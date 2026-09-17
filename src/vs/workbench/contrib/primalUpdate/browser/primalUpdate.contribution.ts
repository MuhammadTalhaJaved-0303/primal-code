/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IPrimalUpdateService, PRIMAL_CHECK_FOR_UPDATES_COMMAND_ID, PRIMAL_UPDATE_DEFAULT_MODE, PRIMAL_UPDATE_INITIAL_DELAY_MS, shouldCheckOnFocus, PRIMAL_UPDATE_INTERVAL_MS, PRIMAL_UPDATE_MANIFEST_URL, PRIMAL_UPDATE_MODES, PRIMAL_UPDATE_MODE_SETTING_ID, PrimalUpdateTrigger } from './primalUpdate.js';
import { PrimalUpdateService } from './primalUpdateService.js';

const PRIMAL_CATEGORY = localize2('primalCode.category', "Primal Code");

// --- service ---------------------------------------------------------------

registerSingleton(IPrimalUpdateService, PrimalUpdateService, InstantiationType.Delayed);

// --- setting ---------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'primalCode',
	title: localize('primalCode.settings', "Primal Code"),
	properties: {
		[PRIMAL_UPDATE_MODE_SETTING_ID]: {
			type: 'string',
			enum: [...PRIMAL_UPDATE_MODES],
			default: PRIMAL_UPDATE_DEFAULT_MODE,
			scope: ConfigurationScope.APPLICATION,
			tags: ['usesOnlineServices'],
			enumDescriptions: [
				localize('primalCode.update.mode.notify', "Check for a newer build and show a notification when one exists. Nothing is downloaded or installed for you."),
				localize('primalCode.update.mode.off', "Never check. No request is made at all."),
			],
			description: localize('primalCode.update.mode', "Controls whether Primal Code checks whether a newer build has been released. The check is a single HTTPS GET for a small JSON file at {0}. It carries no query string, no headers of ours, no identifier and no telemetry: nothing about you, your machine or your work is sent. Primal Code never downloads or installs an update by itself; it only tells you that a newer build exists and links to it.", PRIMAL_UPDATE_MANIFEST_URL),
		},
	},
});

// --- action ----------------------------------------------------------------

class PrimalCheckForUpdatesAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_CHECK_FOR_UPDATES_COMMAND_ID,
			title: localize2('primalCode.checkForUpdates', "Check for Updates"),
			category: PRIMAL_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IPrimalUpdateService).checkForUpdates(PrimalUpdateTrigger.Explicit);
	}
}
registerAction2(PrimalCheckForUpdatesAction);

// --- background schedule ---------------------------------------------------

/**
 * Owns *when* the background check runs; {@link PrimalUpdateService} owns what it
 * does. Startup safety is the whole point of this class:
 *
 * - it is registered at `WorkbenchPhase.Eventually`, so it is not constructed
 *   until the workbench has restored and settled;
 * - its constructor only reads a string setting and arms a timer -- there is no
 *   `await` on the path to a usable window;
 * - a build without `IProductService.commit` is a development build, and gets no
 *   timer and no request at all;
 * - both timers hang off this contribution, which the workbench disposes on
 *   shutdown (`WorkbenchContributionsRegistry` clears `instanceDisposables` on
 *   `onDidShutdown`).
 */
class PrimalUpdateContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalUpdate';

	private readonly firstCheck = this._register(new MutableDisposable<IDisposable>());
	private readonly recheckTimer = this._register(new IntervalTimer());

	private scheduled = false;

	/** When the last check was sent, or `undefined` until the first one has. */
	private lastCheckMs: number | undefined;

	constructor(
		@IPrimalUpdateService private readonly primalUpdateService: IPrimalUpdateService,
		@IProductService private readonly productService: IProductService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		if (!this.productService.commit) {
			this.logService.trace('[primalUpdate] development build (no product commit): no timer, no request');
			return;
		}

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PRIMAL_UPDATE_MODE_SETTING_ID)) {
				this.updateSchedule();
			}
		}));

		// Coming back to the window is the other trigger, and the one that makes a
		// release published while the editor was open reach the reader the moment
		// they look at it rather than up to eight hours later.
		this._register(this.hostService.onDidChangeFocus(focused => {
			if (this.scheduled && shouldCheckOnFocus(focused, this.lastCheckMs, Date.now())) {
				this.logService.trace('[primalUpdate] window focused and the last check is stale, checking again');
				this.check();
			}
		}));

		this.updateSchedule();
	}

	/** Arms or disarms the timers to match the current setting value. */
	private updateSchedule(): void {
		const enabled = this.primalUpdateService.isEnabled;
		if (enabled === this.scheduled) {
			return;
		}
		this.scheduled = enabled;

		if (!enabled) {
			this.firstCheck.clear();
			this.recheckTimer.cancel();
			this.logService.trace('[primalUpdate] update checks turned off, timers cleared');
			return;
		}

		// The periodic timer only starts once the delayed first check has fired,
		// so nothing polls a window that was closed before it ever checked.
		this.firstCheck.value = disposableTimeout(() => {
			this.check();
			this.recheckTimer.cancelAndSet(() => this.check(), PRIMAL_UPDATE_INTERVAL_MS, mainWindow);
		}, PRIMAL_UPDATE_INITIAL_DELAY_MS);
	}

	private check(): void {
		this.lastCheckMs = Date.now();
		this.primalUpdateService.checkForUpdates(PrimalUpdateTrigger.Automatic)
			.then(undefined, error => this.logService.trace('[primalUpdate] background check failed', error));
	}
}

registerWorkbenchContribution2(PrimalUpdateContribution.ID, PrimalUpdateContribution, WorkbenchPhase.Eventually);
