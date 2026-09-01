/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalBoot.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { PrimalBootOverlay } from './primalBootOverlay.js';

/** User setting that turns the boot sequence off. */
const PRIMAL_BOOT_ENABLED_SETTING_ID = 'primalCode.boot.enabled';

// --- setting ---------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'primalCode',
	title: localize('primalCode.settings', "Primal Code"),
	properties: {
		[PRIMAL_BOOT_ENABLED_SETTING_ID]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.boot.enabled', "Show a brief startup readout — the product version, the active vibe, the open workspace and the coding-agent provider — when a window opens. It never delays the workbench and any key, click or scroll dismisses it."),
		},
	},
});

// --- boot sequence ---------------------------------------------------------

/**
 * Runs the boot sequence once per window open.
 *
 * The phase is deliberate: `AfterRestored` is the first phase where views,
 * panels and editors have already restored, so the overlay is painted over a
 * workbench that is *already* interactive rather than standing in front of one
 * that is still assembling. It is the same phase the vibes status bar entry
 * uses. The overlay itself decides whether the current window and theme should
 * see anything at all; this contribution only owns the setting.
 */
class PrimalBootContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalBoot';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		const enabled = configurationService.getValue<boolean>(PRIMAL_BOOT_ENABLED_SETTING_ID) ?? true;
		if (!enabled) {
			return;
		}

		// Registered immediately: if the window closes mid-animation, shutdown
		// disposal takes the DOM node, the timers and the listeners with it.
		this._register(instantiationService.createInstance(PrimalBootOverlay));
	}
}

registerWorkbenchContribution2(PrimalBootContribution.ID, PrimalBootContribution, WorkbenchPhase.AfterRestored);
