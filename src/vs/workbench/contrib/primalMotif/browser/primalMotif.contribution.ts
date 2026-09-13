/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalMotif.css';
// Motifs register themselves as a side effect of being imported, and
// `motifs/motifs.ts` is the one list of which ones. This is the only reference
// to them anywhere: `registerMotif` is the seam, the settings enum below is
// regenerated from the registry, and nothing here has to know what a motif does.
// The tests import that same list, so what ships is what is tested.
import './motifs/motifs.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import {
	IPrimalMotifService,
	IPrimalMotifStatus,
	PRIMAL_MOTIF_BATTERY_FPS,
	PRIMAL_MOTIF_BURST_SECONDS,
	PRIMAL_MOTIF_DEFAULT_ID,
	PRIMAL_MOTIF_DEFAULT_MOTION,
	PRIMAL_MOTIF_DEFAULT_PERPETUAL_ON_BATTERY,
	PRIMAL_MOTIF_ID_SETTING_ID,
	PRIMAL_MOTIF_MAX_FPS,
	PRIMAL_MOTIF_MOTIONS,
	PRIMAL_MOTIF_MOTION_SETTING_ID,
	PRIMAL_MOTIF_PERPETUAL_ON_BATTERY_SETTING_ID,
	PRIMAL_MOTIF_STATIC_ID,
	PrimalMotifState,
	getMotifDescriptors,
	onDidRegisterMotif
} from './primalMotif.js';
import { PrimalMotifScheduler } from './primalMotifScheduler.js';

const MOTIF_CATEGORY = localize2('primalCode.motif.category', "Motif");

const PRIMAL_MOTIF_TOGGLE_PAUSE_COMMAND_ID = 'primalCode.motif.togglePause';
const PRIMAL_MOTIF_PLAY_COMMAND_ID = 'primalCode.motif.play';

// --- service ---------------------------------------------------------------

// `Delayed`, and instantiated by the status bar contribution below rather than
// eagerly: the scheduler does nothing at all until something triggers it, and
// making it `Eager` would put its constructor on the critical path for a
// feature whose default setting is "nothing moves".
registerSingleton(IPrimalMotifService, PrimalMotifScheduler, InstantiationType.Delayed);

// --- settings --------------------------------------------------------------

// `APPLICATION` scoped, like the wallpaper's four and like `primalCode.vibe`:
// the motif is window chrome, not anything about the code being edited, and
// opening a folder must never be able to start something animating.

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/**
 * The settings node, rebuilt whenever a motif registers.
 *
 * The `primalCode.motif.id` enum is generated from the registry rather than
 * written out by hand, so a motif file that is imported later cannot leave the
 * settings UI describing a set of choices that no longer matches reality.
 */
const composeConfigurationNode = (): IConfigurationNode => {
	const descriptors = getMotifDescriptors();

	return {
		id: 'primalCode',
		title: localize('primalCode.settings', "Primal Code"),
		properties: {
			[PRIMAL_MOTIF_ID_SETTING_ID]: {
				type: 'string',
				enum: descriptors.map(descriptor => descriptor.id),
				enumDescriptions: descriptors.map(descriptor => descriptor.description),
				default: PRIMAL_MOTIF_DEFAULT_ID,
				scope: ConfigurationScope.APPLICATION,
				description: localize('primalCode.motif.id', "What moves in the window ground, behind and around the editor, side bar, auxiliary bar and panel. A motif never sits behind code: the four slabs stay opaque on top of it. While a motif other than 'static' is active, 'Wallpaper: Tint Slabs' is ignored, because the contrast of text over something that moves cannot be checked."),
			},
			[PRIMAL_MOTIF_MOTION_SETTING_ID]: {
				type: 'string',
				enum: [...PRIMAL_MOTIF_MOTIONS],
				enumDescriptions: [
					localize('primalCode.motif.motion.settle', "Move for about {0} seconds after a theme change, the window taking focus or a workspace opening, then ease to a resting frame. Nothing runs per frame once it has settled, so the steady-state cost is zero.", PRIMAL_MOTIF_BURST_SECONDS),
					localize('primalCode.motif.motion.perpetual', "Keep moving. This runs an animation frame loop for as long as the window is focused, which costs battery and GPU continuously; a status bar item appears so it can be paused. Motifs that do not offer perpetual motion settle anyway."),
					localize('primalCode.motif.motion.off', "Never move. The ground keeps the wallpaper's own static wash.")
				],
				default: PRIMAL_MOTIF_DEFAULT_MOTION,
				scope: ConfigurationScope.APPLICATION,
				description: localize('primalCode.motif.motion', "How long the motif is allowed to move for. Motion always stops when the window loses focus, while you are typing, on battery, and when the system reports heat or throttling."),
			},
			[PRIMAL_MOTIF_PERPETUAL_ON_BATTERY_SETTING_ID]: {
				type: 'boolean',
				default: PRIMAL_MOTIF_DEFAULT_PERPETUAL_ON_BATTERY,
				scope: ConfigurationScope.APPLICATION,
				description: localize('primalCode.motif.perpetualOnBattery', "Allow the motif to move while this machine is on battery, at {0} frames per second instead of {1}. Off by default, and it stays off wherever the system does not report power state at all - Linux, and any platform where the reading is unavailable - because assuming mains power there would spend somebody's battery on a guess.", PRIMAL_MOTIF_BATTERY_FPS, PRIMAL_MOTIF_MAX_FPS),
			},
		},
	};
};

let configurationNode = configurationRegistry.registerConfiguration(composeConfigurationNode());

onDidRegisterMotif(() => {
	const next = composeConfigurationNode();
	configurationRegistry.updateConfigurations({ add: [next], remove: [configurationNode] });
	configurationNode = next;
});

// --- actions ---------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_MOTIF_TOGGLE_PAUSE_COMMAND_ID,
			title: localize2('primalCode.motif.togglePause', "Pause or Resume Motion"),
			category: MOTIF_CATEGORY,
			f1: true
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const motifService = accessor.get(IPrimalMotifService);
		motifService.setPaused(!motifService.isPaused);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_MOTIF_PLAY_COMMAND_ID,
			title: localize2('primalCode.motif.play', "Play Motion"),
			category: MOTIF_CATEGORY,
			f1: true
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IPrimalMotifService).trigger('command');
	}
});

// --- status bar entry ------------------------------------------------------

/**
 * The discoverable pause control that perpetual motion is only offered with.
 *
 * WCAG 2.2.2 (Level A) asks for a mechanism to pause anything that moves
 * automatically for more than five seconds. The default - `settle` - satisfies
 * it by stopping on its own, so no control is needed and none is shown; the
 * status bar stays exactly as clean as it is today for every user who never
 * touches the setting. `perpetual` is the case that needs a mechanism, and a
 * settings line is not one: it is not on screen while the thing it controls is
 * moving. So the item appears with the mode, states what is happening in its
 * tooltip, and pauses on click. It additionally appears whenever the layer is
 * paused in any mode, so the pause is never a state the user cannot see or get
 * out of.
 *
 * Constructing this is also what instantiates the scheduler. That is
 * deliberate: the scheduler is a `Delayed` singleton and nothing else in the
 * workbench asks for it.
 */
class PrimalMotifStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalMotifStatusBar';

	private static readonly STATUS_ID = 'status.primalCode.motif';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IPrimalMotifService private readonly motifService: IPrimalMotifService,
		@IStatusbarService private readonly statusbarService: IStatusbarService
	) {
		super();

		this.updateEntry();
		this._register(this.motifService.onDidChangeStatus(() => this.updateEntry()));
	}

	private updateEntry(): void {
		const status = this.motifService.status;

		if (!this.shouldShow(status)) {
			// Not just hidden: the entry is disposed, so a workbench that never
			// enables perpetual motion never carries one.
			this.entry.clear();
			return;
		}

		const properties = this.composeEntry(status);
		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			this.entry.value = this.statusbarService.addEntry(properties, PrimalMotifStatusBarContribution.STATUS_ID, StatusbarAlignment.RIGHT, 1 /* low priority, far right */);
		}
	}

	/**
	 * Perpetual mode, or a layer that is paused. Never for `static`, which has
	 * nothing to pause.
	 *
	 * A `settle` motif needs no pause control while it runs: the burst finishes
	 * inside the five seconds WCAG 2.2.2 counts from, so it has already stopped.
	 * But `primalCode.motif.togglePause` is in the command palette in every mode
	 * and really does pause in every mode, so a user who pauses from there while
	 * settling has to have a way back that is not remembering the command's name.
	 * The item therefore also appears whenever the layer is paused, and disappears
	 * again with the pause.
	 */
	private shouldShow(status: IPrimalMotifStatus): boolean {
		if (status.motifId === PRIMAL_MOTIF_STATIC_ID) {
			return false;
		}

		return this.motifService.motion === 'perpetual' || status.state === 'paused';
	}

	private composeEntry(status: IPrimalMotifStatus): IStatusbarEntry {
		const paused = this.motifService.isPaused;
		const icon = paused ? '$(play)' : '$(debug-pause)';
		const label = this.describe(status.state);

		return {
			name: localize('primalCode.motif.statusName', "Motif Motion"),
			text: `${icon} ${label}`,
			ariaLabel: localize('primalCode.motif.statusAria', "Motif motion: {0}", label),
			tooltip: this.composeTooltip(status, paused),
			command: PRIMAL_MOTIF_TOGGLE_PAUSE_COMMAND_ID
		};
	}

	/** One word for each state the scheduler can report, so the item is never ambiguous. */
	private describe(state: PrimalMotifState): string {
		switch (state) {
			case 'moving': return localize('primalCode.motif.state.moving', "moving");
			case 'settling': return localize('primalCode.motif.state.settling', "settling");
			case 'resting': return localize('primalCode.motif.state.resting', "resting");
			case 'parked': return localize('primalCode.motif.state.parked', "parked");
			case 'paused': return localize('primalCode.motif.state.paused', "paused");
			case 'unavailable': return localize('primalCode.motif.state.unavailable', "unavailable");
			case 'static': return localize('primalCode.motif.state.static', "static");
		}
	}

	/**
	 * The tooltip always answers "why is it doing that". The scheduler hands up
	 * a localized sentence for every rung of the ladder it stopped on, so the
	 * answer is never "unknown" and never a number the reader has to interpret.
	 */
	private composeTooltip(status: IPrimalMotifStatus, paused: boolean): string {
		const action = paused
			? localize('primalCode.motif.tooltip.resume', "Select to resume.")
			: localize('primalCode.motif.tooltip.pause', "Select to pause.");

		if (status.reason) {
			return `${status.reason} ${action}`;
		}

		if (status.fps > 0) {
			return `${localize('primalCode.motif.tooltip.running', "'{0}' is moving at {1} frames per second.", status.motifId, status.fps)} ${action}`;
		}

		return `${localize('primalCode.motif.tooltip.idle', "'{0}' is not running anything per frame right now.", status.motifId)} ${action}`;
	}
}

// `AfterRestored`, not `BlockRestore`. The wallpaper has to be right in the
// first painted frame because it is the window's color; the motif is motion on
// top of that, it needs the wallpaper's layer to already exist to paint into,
// and starting it before the workbench has restored would put an animation
// frame loop in competition with the editors opening.
registerWorkbenchContribution2(PrimalMotifStatusBarContribution.ID, PrimalMotifStatusBarContribution, WorkbenchPhase.AfterRestored);
