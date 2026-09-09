/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalChrome.css';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IPrimalVibeService, PRIMAL_VIBES, PRIMAL_VIBE_CYCLE_COMMAND_ID, PRIMAL_VIBE_PICK_COMMAND_ID, PRIMAL_VIBE_SETTING_ID } from './primalVibes.js';
import { PrimalVibeService } from './primalVibeService.js';

const VIBES_CATEGORY = localize2('vibes.category', "Vibes");

// --- service ---------------------------------------------------------------

registerSingleton(IPrimalVibeService, PrimalVibeService, InstantiationType.Delayed);

// --- setting ---------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'primalCode',
	title: localize('primalCode.settings', "Primal Code"),
	properties: {
		[PRIMAL_VIBE_SETTING_ID]: {
			type: 'string',
			// '' is a real member of the enum, not a hole in it: a profile that has
			// never applied a vibe has no id to record, and an `enum` whose declared
			// default is not one of its own members advertises a value the setting
			// can never legally hold.
			enum: ['', ...PRIMAL_VIBES.map(vibe => vibe.id)],
			// The mode belongs in the TEXT. The dropdown showed labels only, so
			// 'Primal Ink' and 'Primal Basalt' were indistinguishable until you
			// applied one — and for a colour-blind reader, applying one is not a
			// reliable way to find out either.
			enumDescriptions: [
				localize('primalCode.vibe.none', "No vibe recorded yet."),
				...PRIMAL_VIBES.map(vibe => vibe.mode === 'dark'
					? localize('primalCode.vibe.dark', "{0} — a dark vibe.", vibe.label)
					: localize('primalCode.vibe.light', "{0} — a light vibe.", vibe.label))
			],
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.vibe', "The last applied vibe. A vibe bundles the color theme, product icon theme and file icon theme. Use 'Vibes: Choose Vibe...' to switch, or 'Primal Code: Browse Themes' for the full gallery."),
		},
	},
});

// --- actions ---------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_VIBE_CYCLE_COMMAND_ID,
			title: localize2('vibes.cycle', "Next Vibe"),
			category: VIBES_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.Period }
			}
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IPrimalVibeService).cycleVibe();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_VIBE_PICK_COMMAND_ID,
			title: localize2('vibes.pick', "Choose Vibe..."),
			category: VIBES_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyV)
			}
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IPrimalVibeService).pickVibe();
	}
});

// --- status bar entry ------------------------------------------------------

class PrimalVibeStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalVibeStatusBar';

	private static readonly STATUS_ID = 'status.primalCode.vibe';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IStatusbarService private readonly statusbarService: IStatusbarService
	) {
		super();

		this.updateEntry();
		this._register(this.vibeService.onDidChangeVibe(() => this.updateEntry()));
	}

	private updateEntry(): void {
		const vibe = this.vibeService.currentVibe;
		const label = vibe ? vibe.label : localize('vibes.custom', "Custom");
		const text = `$(color-mode) ${label}`;
		const properties = {
			name: localize('vibes.statusName', "Vibe"),
			text,
			ariaLabel: localize('vibes.statusAria', "Current vibe: {0}", label),
			tooltip: localize('vibes.statusTooltip', "Choose Vibe"),
			command: PRIMAL_VIBE_PICK_COMMAND_ID
		};

		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			this.entry.value = this.statusbarService.addEntry(properties, PrimalVibeStatusBarContribution.STATUS_ID, StatusbarAlignment.RIGHT, 1 /* low priority, far right */);
		}
	}
}

registerWorkbenchContribution2(PrimalVibeStatusBarContribution.ID, PrimalVibeStatusBarContribution, WorkbenchPhase.AfterRestored);
