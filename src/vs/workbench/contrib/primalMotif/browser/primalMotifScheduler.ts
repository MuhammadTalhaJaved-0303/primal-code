/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isNative, isWindows } from '../../../../base/common/platform.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { descriptionForeground, editorBackground, focusBorder, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { isHighContrast } from '../../../../platform/theme/common/theme.js';
import { IColorTheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, LayoutSettings } from '../../../services/layout/browser/layoutService.js';
import { IPowerService, ThermalState } from '../../../services/power/common/powerService.js';
import { IPrimalVibeService } from '../../primalVibes/browser/primalVibes.js';
import { PRIMAL_WALLPAPER_LAYER_CLASS, PRIMAL_WALLPAPER_ON_CLASS, PRIMAL_WALLPAPER_SETTING_IDS } from '../../primalWallpaper/browser/primalWallpaper.js';
import { PRIMAL_MOTIF_WORLD_ID } from './motifs/globe.js';
import {
	IMotifFrame,
	IMotifHost,
	IMotifPalette,
	IPrimalMotifService,
	IPrimalMotifStatus,
	PRIMAL_MOTIF_BUFFER_HEIGHT,
	PRIMAL_MOTIF_BUFFER_WIDTH,
	PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES,
	PRIMAL_MOTIF_FADE_PROPERTY,
	PRIMAL_MOTIF_FRAME_BUDGET_MS,
	PRIMAL_MOTIF_ID_SETTING_ID,
	PRIMAL_MOTIF_INPUT_QUIET_MS,
	PRIMAL_MOTIF_INSTANT_CLASS,
	PRIMAL_MOTIF_MOTION_SETTING_ID,
	PRIMAL_MOTIF_ON_CLASS,
	PRIMAL_MOTIF_PERPETUAL_ON_BATTERY_SETTING_ID,
	PRIMAL_MOTIF_SETTING_IDS,
	PRIMAL_MOTIF_STAGED_CLASS,
	PrimalMotifMotion,
	PrimalMotifRole,
	PrimalMotifState,
	PrimalMotifTrigger,
	getMotifDescriptor,
	settleIntensity,
	toMotifId,
	toMotifMotion
} from './primalMotif.js';
import { IMotifPlan, MotifPowerSource, MotifRunMode, SPEED_LIMIT_NOMINAL, resolveMotifPlan } from './primalMotifLadder.js';
import { MotifSurface } from './primalMotifSurface.js';

/** Rendered frames in a row over budget before the scheduler throttles itself. */
const BUDGET_STRIKES = 30;

/** How far over budget one frame has to be to count as a strike. */
const BUDGET_STRIKE_FACTOR = 3;

/**
 * Main-thread work one coalesced re-measure is allowed before it is reported.
 *
 * A resize is not a frame and is not policed like one: it happens once per
 * layout rather than thirty times a second, and the frame budget's remedy -
 * halving the frame rate - would not make a rebuild any cheaper. But a renderer
 * that rebuilds its tables from `resize()` can cost far more than a frame does,
 * and {@link PrimalMotifScheduler.renderFrame} brackets only `render()`, so
 * without this the most expensive thing this contrib does would be the one
 * thing nothing ever measured. Eight frame budgets: generous for a one-off,
 * still well inside a 60Hz frame, and it is a diagnostic rather than a throttle.
 */
const LAYOUT_BUDGET_MS = PRIMAL_MOTIF_FRAME_BUDGET_MS * 8;

/**
 * How close to the next scheduled frame time a raw animation frame may land and
 * still be taken. Without it the accumulator quantises to the display's cadence
 * and a 120Hz panel yields 24fps rather than 30: the frame at 33.33ms arrives a
 * hair early and is discarded, so the next chance is 41.7ms. One millisecond is
 * shorter than any real display interval, so it can never let two frames
 * through, and it lets the intended frame through at every refresh rate.
 */
const FRAME_SLACK_MS = 1;

/**
 * Slack on the timer that lifts the input suppression. `Date.now()` is coarse
 * and the timer can fire a millisecond early, at which point the ladder would
 * still see the window as un-quiet, park, and arm nothing. One frame of margin
 * makes the wake-up strictly later than the gate it wakes up for.
 */
const INPUT_QUIET_MARGIN_MS = 16;

/**
 * Primal Code - the motif scheduler. This is the feature; the motifs are
 * decoration on top of it.
 *
 * ONE LOOP PER WINDOW. Every surface in a window is driven by that window's
 * single `scheduleAtNextAnimationFrame` chain, and there is one surface per
 * window, so the loop count equals the window count and nothing can raise it.
 *
 * MOTION SETTLES. A trigger - a theme or vibe change, the window taking focus,
 * a workspace opening - starts a burst that runs at full speed and then eases to
 * a resting frame inside `PRIMAL_MOTIF_BURST_MS`, after which the loop
 * stops and steady-state cost is exactly zero. That default is what makes the
 * feature satisfy WCAG 2.2.2 (Level A) by construction rather than by
 * preference: the whole burst finishes under the five seconds the criterion
 * counts from, so nothing that starts automatically ever reaches it.
 * `prefers-reduced-motion` is honoured too, but it is not what satisfies 2.2.2.
 *
 * THE GROUND IS BORROWED, NOT OWNED. The motif paints inside the wallpaper's
 * layer, so "is the wallpaper painting in this window" is a precondition and not
 * a one-off check: it is re-asked on every pass in {@link groundPaints}, because
 * the wallpaper can be switched off, and the chrome design can be switched, at
 * any moment from settings this contrib does not own.
 *
 * STAGES MOVE THE SURFACE; THEY DO NOT ADD ONE. A code-free pane may offer
 * itself as this window's host through {@link registerStage}, and the window's
 * single surface then mounts there instead of in the wallpaper layer. The count
 * of surfaces, loops and graphics contexts is unchanged - which is the point,
 * because the count is the whole performance argument. What changes is where the
 * one surface can be seen: the chrome strip is ~35px tall, and a Start page is
 * most of a window. See {@link resolveMount}.
 *
 * THE LADDER. Seven conditions can degrade or stop motion, plus a self-imposed
 * budget guard, most restrictive wins, re-evaluated on every state change. The
 * decision is a pure function in `primalMotifLadder.ts`; this class keeps its
 * inputs current and obeys the answer.
 *
 * WHAT THE BUDGET GUARD COVERS, AND WHAT IT DOES NOT. `PRIMAL_MOTIF_FRAME_BUDGET_MS`
 * and the strike counter in {@link renderFrame} bracket `render()` and nothing
 * else, because throttling the frame rate is a remedy for per-frame cost and
 * for no other kind. The other expensive thing a renderer does is rebuild its
 * tables from `resize()`, which happens on a layout rather than on a frame;
 * that path is coalesced by {@link relayout} and reported against
 * `LAYOUT_BUDGET_MS`, which is a diagnostic and deliberately not a throttle.
 */
export class PrimalMotifScheduler extends Disposable implements IPrimalMotifService {

	declare readonly _serviceBrand: undefined;

	private readonly surfaces = new Map<HTMLElement, MotifSurface>();

	/**
	 * Code-free panes that have offered themselves as this window's host, keyed
	 * by the workbench container the pane lives in.
	 *
	 * Keyed by container and not by pane, deliberately: `PrimalStartInput` is a
	 * singleton per editor *group*, not per window, an auxiliary window has its
	 * own `EditorPart`, and the Start page and the Rig are two different inputs
	 * that a split shows side by side - so several code-free panes are reachable
	 * in one window at once. The budget this scheduler defends is per window, so
	 * the map that decides where a window's one surface mounts has to be per
	 * window too.
	 *
	 * EVERY LIVE OFFER IS KEPT, NEWEST LAST, and the newest is the one honoured.
	 * A single-slot map would be wrong rather than merely lossy: a second pane
	 * would silently supersede the first, and when the second withdrew, the
	 * window would fall back to the wallpaper layer even though the first pane
	 * was still on screen still offering itself. Nothing re-asks a pane - the
	 * offer is withdrawn from the pane's own visibility, which has not changed -
	 * so that surface would stay empty for the rest of that pane's visible
	 * session. A list makes withdrawal fall back to the next live offer instead.
	 *
	 * A stage REPLACES the wallpaper layer as the mount. It never adds a second
	 * surface, and there is no code path here that could: {@link surfaces} is
	 * still keyed by container and {@link ensureSurface} is still the only place
	 * a `MotifSurface` is constructed.
	 */
	private readonly stages = new Map<HTMLElement, readonly HTMLElement[]>();

	/**
	 * Containers whose surface owes a re-measure, and the one deferred slot they
	 * share. See {@link relayout}.
	 */
	private readonly pendingLayouts = new Set<HTMLElement>();
	private readonly deferredLayout = this._register(new MutableDisposable<IDisposable>());

	/** So the "nowhere to paint" diagnostic is a line in the log, not a stream. */
	private missingHostLogged = false;

	/** The same, for the re-measure cost report. A window drag would stream it. */
	private layoutCostLogged = false;

	/**
	 * Every container this scheduler has attached per-window listeners to, with
	 * the store those listeners live in.
	 *
	 * `IWorkbenchLayoutService` announces containers arriving - `onDidAddContainer`
	 * hands out a window-scoped `DisposableStore` - but it announces none leaving:
	 * `containers` is derived from `getWindows()` (`browser/layout.ts`) and a
	 * closed auxiliary window simply stops appearing in it. A container this
	 * scheduler saw at construction time therefore has no store of its own to
	 * hang cleanup on, so it gets one here, and {@link reconcileContainers} is
	 * what notices it has gone. Without that, a closed window's document keeps its
	 * listeners and its `MotifSurface` stays in {@link surfaces} unreachable by
	 * {@link update}, so its canvas, backing store and renderer are held for the
	 * rest of the session.
	 */
	private readonly trackedContainers = new Map<HTMLElement, DisposableStore>();

	/**
	 * Motifs whose `create()` declined under the current palette.
	 *
	 * A refusal is not a lost graphics context. `globe.ts` returns false when the
	 * active theme defines none of the tokens it draws from; that says nothing
	 * about the GPU, about `galaxy`, or about this motif under the next theme. So
	 * it is recorded per motif and cleared whenever the content generation is
	 * bumped - which is exactly when the motif or the palette changed, and
	 * therefore exactly when the answer could be different. {@link unavailable}
	 * stays reserved for the failures that really are terminal.
	 */
	private readonly refusedMotifs = new Set<string>();

	private readonly _onDidChangeStatus = this._register(new Emitter<IPrimalMotifStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	/**
	 * The lease on the frame loop, bumped whenever the plan is re-resolved.
	 *
	 * Every scheduled frame carries the generation it was armed under and checks
	 * it before doing anything, so a stop landing between `scheduleFrame` and the
	 * frame firing retires that frame instead of letting it paint over the
	 * resting image - the discipline `primalDeckLease.ts` uses to hand a lease
	 * back when `stop()` beats the acquire round trip home. Readings of the world
	 * deliberately do not guard on it; see {@link readPowerSignals}.
	 */
	private generation = 0;

	/**
	 * Bumped only when what the motif *paints* changes: the motif id, or the
	 * theme its palette is derived from. A surface built under an older content
	 * generation is rebuilt; one built under the current generation is kept,
	 * whatever the ladder is doing. Parking, unparking, typing and battery
	 * events therefore never cost a graphics context.
	 */
	private contentGeneration = 0;

	private plan: IMotifPlan = { mode: 'off', fps: 0, state: 'static', reason: undefined, perpetual: false };
	private lastStatus: IPrimalMotifStatus | undefined;

	// --- ladder inputs, each kept current by exactly one subscription --------

	private focused: boolean;
	private power: MotifPowerSource = 'unknown';
	private thermal: ThermalState = 'unknown';
	private speedLimit = SPEED_LIMIT_NOMINAL;
	private lastInputAt = 0;
	private paused = false;

	/** Rule 7 is terminal: once set, nothing in this session clears it. */
	private unavailable = false;
	private unavailableLogged = false;

	/** The budget guard has fired at least once this session. */
	private overBudget = false;

	private readonly inputQuietTimer = this._register(new MutableDisposable<IDisposable>());

	/**
	 * The one pending "resolve again, one turn from now".
	 *
	 * Several paths need a re-resolve that must not happen where they stand: a
	 * frame is on the stack, or a class this reads has not been written yet. They
	 * all want the same thing - `update('setting')` on the next turn - so they
	 * share one slot, and a `MutableDisposable` both coalesces them and keeps a
	 * long session from accumulating spent timers.
	 */
	private readonly deferredResolve = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IThemeService private readonly themeService: IThemeService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPowerService private readonly powerService: IPowerService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.focused = this.hostService.hasFocus;

		this._register(toDisposable(() => {
			this.clearSurfaces();
			this.stages.clear();
			this.pendingLayouts.clear();
		}));

		this.registerLadderListeners();
		this.registerTriggerListeners();
		this.registerContainerListeners();

		this.readPowerSignals();
		this.update('setting');
	}

	// --- IPrimalMotifService -----------------------------------------------

	get activeMotifId(): string {
		return toMotifId(this.configurationService.getValue<unknown>(PRIMAL_MOTIF_ID_SETTING_ID));
	}

	get motion(): PrimalMotifMotion {
		return toMotifMotion(this.configurationService.getValue<unknown>(PRIMAL_MOTIF_MOTION_SETTING_ID));
	}

	/**
	 * Always recomputed. `lastStatus` exists only to deduplicate the event, and
	 * reading it here would report "moving" to anyone who asked between the two
	 * events that bracket a settle.
	 */
	get status(): IPrimalMotifStatus {
		return this.composeStatus();
	}

	get isPaused(): boolean {
		return this.paused;
	}

	trigger(reason: PrimalMotifTrigger): void {
		this.update(reason);
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) {
			return;
		}

		this.paused = paused;
		this.update('command', /* restart */ !paused);
	}

	registerStage(container: HTMLElement, element: HTMLElement): IDisposable {
		const offers = this.stages.get(container) ?? [];
		this.stages.set(container, [...offers, element]);

		// Coalesced through the one deferred slot rather than reconciled here.
		// Panes are created, hidden, shown, moved between groups and disposed far
		// more often than containers are, and every host change rebuilds the
		// renderer - a fresh 2D context and about a megabyte of typed tables. A
		// pane that is shown and hidden twice in one turn therefore costs one
		// re-resolve, not four.
		this.scheduleResolve();

		let withdrawn = false;
		return toDisposable(() => {
			// Idempotent: a pane may clear its registration and be disposed after,
			// and a second removal would take some other pane's offer with it.
			if (withdrawn) {
				return;
			}
			withdrawn = true;

			const current = this.stages.get(container);
			if (!current) {
				return; // the window closed; `untrackContainer` dropped the lot.
			}

			// Exactly this offer leaves. Any other pane's offer stays live, and
			// if one of them was made before this one it becomes the newest again
			// and wins the mount back on the re-resolve below - which is the whole
			// reason these are a list rather than a slot.
			const index = current.lastIndexOf(element);
			if (index === -1) {
				return;
			}

			const remaining = [...current.slice(0, index), ...current.slice(index + 1)];
			if (remaining.length === 0) {
				this.stages.delete(container);
			} else {
				this.stages.set(container, remaining);
			}

			this.scheduleResolve();
		});
	}

	relayout(container: HTMLElement): void {
		if (this._store.isDisposed || !this.surfaces.has(container)) {
			return;
		}

		this.pendingLayouts.add(container);
		this.deferredLayout.value ??= disposableTimeout(() => this.flushLayouts(), 0);
	}

	// --- wiring -------------------------------------------------------------

	private registerLadderListeners(): void {
		// Rule 2. `isMotionReduced()` already folds the `workbench.reduceMotion`
		// setting together with the `prefers-reduced-motion` media query
		// (platform/accessibility/browser/accessibilityService.ts), so this is the
		// one place both are read.
		this._register(this.accessibilityService.onDidChangeReducedMotion(() => this.update('setting')));

		// Rule 3. Electron only reports occlusion through `visibilityState` on
		// macOS; on Windows and Linux a buried window keeps animating. So we park
		// on blur ourselves rather than trusting the platform.
		this._register(this.hostService.onDidChangeFocus(focused => {
			this.focused = focused;
			// Focus is also a trigger: the window coming back is exactly when the
			// owner wants to see the motif move.
			this.update('focus', /* restart */ focused);
		}));

		// Rules 4 and 5 read `IPowerService`, the workbench-layer face of the three
		// `powerMonitor` signals on `INativeHostService` - `onDidChangeOnBatteryPower`,
		// `onDidChangeThermalState`, `onDidChangeSpeedLimit` - forwarded verbatim
		// by `NativePowerService` in `electron-browser`. Depending on it keeps this
		// file in the `browser` layer and gives a web entry point the registered
		// stub instead of a service resolution that throws.
		//
		// None of the three fires on every platform: macOS reports all three,
		// Windows battery and speed limit but never thermal state, Linux none. The
		// absence of an event is therefore never read as good news - the fields
		// start at `unknown` / nominal, and `unknown` power counts as battery.

		// Rule 4. macOS and Windows only.
		this._register(this.powerService.onDidChangeOnBatteryPower(onBattery => {
			this.power = onBattery ? 'battery' : 'mains';
			this.update('setting');
		}));

		// Rule 5, first half. macOS only; there is no equivalent elsewhere.
		this._register(this.powerService.onDidChangeThermalState(state => {
			this.thermal = state;
			this.update('setting');
		}));

		// Rule 5, second half. macOS and Windows. This is what covers Windows for
		// heat, since it has no thermal state; Linux has neither, and is already
		// held to explicit opt-in by rule 4's `unknown` power source.
		this._register(this.powerService.onDidChangeSpeedLimit(limit => {
			this.speedLimit = limit;
			this.update('setting');
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (PRIMAL_MOTIF_SETTING_IDS.some(settingId => e.affectsConfiguration(settingId))) {
				// `primalCode.motif.id` can have changed, so the renderer may be the
				// wrong one; and a burst plays, because changing the setting is how
				// you preview what you just chose.
				this.bumpContentGeneration();
				this.update('setting', /* restart */ true);
				return;
			}

			// The ground this layer borrows is turned on and off from outside this
			// contrib, and a ground that stops painting has to stop the loop: see
			// {@link groundPaints}. The wallpaper's settings decide whether the
			// layer paints at all, and the Modern UI experiment swaps in a chrome
			// design that excludes it. Neither changes what the motif *paints*, so
			// the content generation is deliberately not bumped, no graphics context
			// is thrown away and no burst is replayed.
			if (PRIMAL_WALLPAPER_SETTING_IDS.some(settingId => e.affectsConfiguration(settingId))
				|| e.affectsConfiguration(LayoutSettings.MODERN_UI)) {
				this.scheduleResolve();
			}
		}));
	}

	/**
	 * Re-resolves the ladder on the next turn rather than where the caller stands.
	 *
	 * Two kinds of caller need this. One is running with a frame on the stack, and
	 * re-entering the ladder there would tear down the surface that frame is
	 * painting into. The other is about to read DOM classes that another
	 * contribution's `onDidChangeConfiguration` listener has not written yet -
	 * listener order is registration order, a function of workbench phases this
	 * contrib does not control and must not depend on. Both want the same
	 * next-turn re-resolve, so they share one slot and one `update` satisfies all
	 * of them.
	 */
	private scheduleResolve(): void {
		this.deferredResolve.value = disposableTimeout(() => this.update('setting'), 0);
	}

	/**
	 * Re-measures every surface a layout has touched since the last turn.
	 *
	 * The slot is released before the work rather than after, so a layout that
	 * arrives while this is running arms the next turn instead of being dropped
	 * into the batch that is already draining.
	 */
	private flushLayouts(): void {
		this.deferredLayout.clear();

		const containers = [...this.pendingLayouts];
		this.pendingLayouts.clear();

		for (const container of containers) {
			const surface = this.surfaces.get(container);
			if (!surface) {
				continue; // the surface went away between the layout and this turn.
			}

			const startedAt = surface.targetWindow.performance.now();
			surface.layout();
			const cost = surface.targetWindow.performance.now() - startedAt;

			if (cost > LAYOUT_BUDGET_MS && !this.layoutCostLogged) {
				this.layoutCostLogged = true;
				this.logService.warn(`[primalMotif] '${surface.renderer.id}' spent ${cost.toFixed(2)}ms on the main thread rebuilding for a new size, against a ${LAYOUT_BUDGET_MS}ms budget. The frame budget does not cover this path - see LAYOUT_BUDGET_MS. Logged once per session.`);
			}
		}
	}

	/**
	 * Declares that what the motif paints has changed - the motif id, or the
	 * palette it derives from.
	 *
	 * Clearing {@link refusedMotifs} is part of the same statement: a motif
	 * declined under a palette, and this is the moment the palette stopped being
	 * that one, so the refusal has expired and the motif is asked again.
	 */
	private bumpContentGeneration(): void {
		this.contentGeneration++;
		this.refusedMotifs.clear();
	}

	private registerTriggerListeners(): void {
		// A theme change re-derives the palette, so the surface is rebuilt as well
		// as replayed - hence the content generation bump alongside the trigger.
		this._register(this.themeService.onDidColorThemeChange(() => {
			this.bumpContentGeneration();
			this.update('theme', /* restart */ true);
		}));
		this._register(this.vibeService.onDidChangeVibe(() => {
			this.bumpContentGeneration();
			this.update('theme', /* restart */ true);
		}));

		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.update('workspace', /* restart */ true)));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.update('workspace', /* restart */ true)));
	}

	private registerContainerListeners(): void {
		this._register(toDisposable(() => this.untrackAllContainers()));

		// A container announced by the layout service comes with a window-scoped
		// store, so the window closing is what unhooks it. Nothing is left to
		// reconcile for these.
		this._register(this.layoutService.onDidAddContainer(({ container, disposables }) => {
			this.trackContainer(container);
			disposables.add(toDisposable(() => this.untrackContainer(container)));
			this.update('setting');
		}));

		// Containers that already existed when this scheduler was built get no such
		// store: the layout service has no removal event and no per-container store
		// to hand out after the fact. An auxiliary window restored before this
		// point - editor parts are restored during workbench restore, and this
		// scheduler is a `Delayed` singleton first instantiated at `AfterRestored`
		// - therefore reaches us this way, and is unhooked by
		// {@link reconcileContainers} instead.
		for (const container of this.layoutService.containers) {
			this.trackContainer(container);
		}

		// Through the coalesced slot, not straight into the surface: a container
		// layout arrives in the middle of the workbench's own layout pass, and a
		// renderer that rebuilds its tables from `resize()` would take a forced
		// geometry read and several milliseconds of arithmetic there. Deferring by
		// one turn also collapses the several layouts a single user action can
		// produce into one re-measure.
		this._register(this.layoutService.onDidLayoutContainer(({ container }) => this.relayout(container)));
	}

	/**
	 * Attaches this scheduler's per-window listeners to a container, once.
	 *
	 * The store is this scheduler's rather than the window's, because for a
	 * pre-existing container there is no window store to use. What guarantees it
	 * is disposed is {@link reconcileContainers}, not the shutdown of the
	 * workbench.
	 */
	private trackContainer(container: HTMLElement): void {
		if (this.trackedContainers.has(container)) {
			return;
		}

		const store = new DisposableStore();
		store.add(this.observeContainer(container));
		this.trackedContainers.set(container, store);
	}

	/** Drops every trace of a container: its listeners, its surface and its classes. */
	private untrackContainer(container: HTMLElement): void {
		this.trackedContainers.get(container)?.dispose();
		this.trackedContainers.delete(container);
		// A closed window's panes are not disposed in an order this scheduler can
		// see, so the stage offer is dropped here as well. Leaving it would hold a
		// detached element - and its whole document - for the rest of the session.
		this.stages.delete(container);
		this.pendingLayouts.delete(container);
		this.removeSurface(container);
	}

	private untrackAllContainers(): void {
		for (const container of [...this.trackedContainers.keys()]) {
			this.untrackContainer(container);
		}
	}

	/**
	 * Notices the windows that have gone, by their absence - which is the only
	 * way they are announced (see {@link trackedContainers}). Run at the head of
	 * every pass, so the answer is never more than one re-resolve stale, against a
	 * set that is almost always of size one.
	 */
	private reconcileContainers(containers: readonly HTMLElement[]): void {
		let stale: HTMLElement[] | undefined;
		for (const container of this.trackedContainers.keys()) {
			if (!containers.includes(container)) {
				stale ??= [];
				stale.push(container);
			}
		}

		// Collected before anything is dropped, because `untrackContainer` writes
		// to the map the loop above is reading. Nothing is allocated at all in the
		// case that is true almost every time: no window has closed.
		if (stale) {
			for (const container of stale) {
				this.untrackContainer(container);
			}
		}
	}

	/**
	 * Per-window listeners: document visibility (rule 1) and input (rule 6).
	 *
	 * Input is any keystroke or wheel event anywhere in the workbench container,
	 * in the capture phase so nothing can stop it reaching us. That is a
	 * deliberate superset of "editor input": a keystroke in the terminal, the
	 * chat box or the quick pick is exactly as latency-critical as one in the
	 * editor, and the handler is a field write, so the superset is free.
	 */
	private observeContainer(container: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const targetWindow = getWindow(container);

		store.add(addDisposableListener(targetWindow.document, 'visibilitychange', () => this.update('setting')));

		const onInput = () => this.noteInput();
		store.add(addDisposableListener(container, 'keydown', onInput, true));
		store.add(addDisposableListener(container, 'wheel', onInput, true));

		return store;
	}

	/**
	 * `Date.now()` and not `performance.now()`, deliberately: every window has
	 * its own `performance` epoch, so a keystroke in an auxiliary window opened
	 * ten minutes after the main one would be compared against a number from a
	 * different clock and would suppress motion forever. The wall clock is
	 * shared, and a 250ms gate does not care about its coarser resolution.
	 */
	private noteInput(): void {
		const now = Date.now();
		const wasQuiet = now - this.lastInputAt >= PRIMAL_MOTIF_INPUT_QUIET_MS;
		this.lastInputAt = now;

		// One timer, re-armed on every keystroke, that lifts the suppression once
		// typing has actually stopped. A `MutableDisposable` swap is a
		// `clearTimeout` and a `setTimeout`, which is what rule 6 is willing to
		// spend on the input path.
		this.inputQuietTimer.value = disposableTimeout(() => this.update('setting'), PRIMAL_MOTIF_INPUT_QUIET_MS + INPUT_QUIET_MARGIN_MS);

		if (wasQuiet) {
			// Only the first keystroke after a quiet spell re-evaluates the ladder.
			// Every keystroke after it is already suppressed, and running the
			// ladder on the repeat path is precisely what rule 6 exists to avoid.
			this.update('setting');
		}
	}

	/**
	 * The one-off reads that give the ladder a starting value, since the power
	 * signals are events that only fire on a *change*.
	 *
	 * Platform-gated rather than trusted everywhere. The getters exist on every
	 * platform - `IPowerService` is a total interface - but their answers are not
	 * equally meaningful: `isOnBatteryPower()` is only wired to real battery
	 * events on macOS and Windows, and the web stub returns a flat `false`.
	 * Elsewhere the field stays `unknown`, which the ladder treats as `battery`.
	 *
	 * Note what these do NOT guard on: the plan generation. A reading of the
	 * world is still true when it arrives late, unlike a frame, which belongs to
	 * a plan that may since have been retired.
	 */
	private readPowerSignals(): void {
		if (isNative && (isMacintosh || isWindows)) {
			this.powerService.isOnBatteryPower().then(onBattery => {
				if (this._store.isDisposed) {
					return;
				}
				this.power = onBattery ? 'battery' : 'mains';
				this.update('setting');
			}, error => this.logService.warn('[primalMotif] Failed to read the battery state; treating power as unknown', error));
		}

		// Thermal state is macOS only - `powerMonitor.getCurrentThermalState()`
		// resolves `unknown` everywhere else, and `unknown` is not throttled as
		// far as rule 5 is concerned. Heat is covered on Windows by the speed
		// limit instead, and on Linux by rule 4 refusing to assume mains power in
		// the first place.
		if (isNative && isMacintosh) {
			this.powerService.getCurrentThermalState().then(state => {
				if (this._store.isDisposed) {
					return;
				}
				this.thermal = state;
				this.update('setting');
			}, error => this.logService.warn('[primalMotif] Failed to read the thermal state; treating it as nominal', error));
		}

		// There is no getter for the speed limit anywhere in this codebase, only
		// `onDidChangeSpeedLimit`. We therefore start at nominal and only learn
		// otherwise when the system tells us, which is the correct reading of an
		// event-only signal: no throttling has been reported yet.
	}

	// --- the ladder ---------------------------------------------------------

	/**
	 * Gathers the ladder's readings and hands them to `resolveMotifPlan`. Rule 1
	 * (document hidden) is deliberately not among them: it is per window, so it
	 * is applied in {@link applyTo} against each surface's own document. A buried
	 * main window must not stop an auxiliary window that is on screen.
	 */
	private resolve(): IMotifPlan {
		const motifId = this.activeMotifId;
		const descriptor = getMotifDescriptor(motifId);

		return resolveMotifPlan({
			motifId,
			motifMissing: !descriptor,
			motifRefused: this.refusedMotifs.has(motifId),
			motifAllowsPerpetual: descriptor?.allowsPerpetual === true,
			unavailable: this.unavailable,
			highContrast: isHighContrast(this.themeService.getColorTheme().type),
			motion: this.motion,
			reducedMotion: this.accessibilityService.isMotionReduced(),
			paused: this.paused,
			focused: this.focused,
			thermal: this.thermal,
			speedLimit: this.speedLimit,
			power: this.power,
			perpetualOnBattery: this.configurationService.getValue<unknown>(PRIMAL_MOTIF_PERPETUAL_ON_BATTERY_SETTING_ID) === true,
			quietForMs: Date.now() - this.lastInputAt,
			overBudget: this.overBudget
		});
	}

	// --- applying the plan --------------------------------------------------

	/**
	 * Re-resolves the ladder and reconciles every surface with the answer.
	 *
	 * `restart` says whether this call is a trigger - something the owner did
	 * that deserves a fresh burst - rather than a ladder condition merely
	 * clearing. It is deliberately NOT the question "must the renderer be
	 * rebuilt": that is driven by {@link contentGeneration}, so parking and
	 * unparking never throw away a graphics context.
	 */
	private update(trigger: PrimalMotifTrigger, restart = false): void {
		if (this._store.isDisposed) {
			return;
		}

		// Before anything else, and before the plan is resolved: a surface belonging
		// to a window that has closed must not be counted as this layer's state.
		const containers = [...this.layoutService.containers];
		this.reconcileContainers(containers);

		const generation = ++this.generation;
		const plan = this.resolve();
		this.plan = plan;

		for (const container of containers) {
			this.applyTo(container, plan, restart, generation);
		}

		this.publishStatus(plan, trigger);
	}

	private applyTo(container: HTMLElement, plan: IMotifPlan, restart: boolean, generation: number): void {
		// Rule 1, per window. A hidden document sees nothing, so it gets nothing:
		// the loop is cancelled, the renderer is disposed (releasing whatever GPU
		// context it held) and the backing store is freed. Zero work, not less.
		//
		// The ground is asked about here too, and on every pass rather than once at
		// creation, for exactly the same reason: a window whose ground has stopped
		// painting shows nobody anything, and a loop rendering into a `display: none`
		// canvas costs every bit as much as one rendering into a visible one.
		const hidden = getWindow(container).document.visibilityState === 'hidden';
		const mode: MotifRunMode = hidden || !this.groundPaints(container) ? 'off' : plan.mode;

		if (mode === 'off') {
			// Nothing to paint at all - the `static` motif, `motion: 'off'`, high
			// contrast, a lost context, a document nobody can see, or a ground that
			// is not painting in this window. The surface goes, and with it the
			// loop, the context and the backing store.
			this.removeSurface(container);
			return;
		}

		if (this.unavailable) {
			// A sibling window already failed inside this same pass, before the
			// deferred re-resolve could turn the plan off. Do not ask this window's
			// GPU for a context we have just been told we cannot have.
			this.removeSurface(container);
			return;
		}

		const surface = this.ensureSurface(container);
		if (!surface) {
			return; // no wallpaper layer to paint into, or the renderer refused
		}

		container.classList.toggle(PRIMAL_MOTIF_ON_CLASS, true);
		// Where the surface ended up, and not merely that there is one. Two rules
		// in `media/primalMotif.css` give something of the chrome's up in exchange
		// for the motif holding the chrome's ground - the wallpaper's wash and the
		// user's `tintSlabs` - and neither trade is owed while the surface is
		// inside an editor pane instead. See PRIMAL_MOTIF_STAGED_CLASS.
		container.classList.toggle(PRIMAL_MOTIF_STAGED_CLASS, surface.role === 'stage');
		container.classList.toggle(PRIMAL_MOTIF_INSTANT_CLASS, this.accessibilityService.isMotionReduced());
		surface.element.style.setProperty(PRIMAL_MOTIF_FADE_PROPERTY, '1');
		surface.layout();

		if (mode === 'run') {
			this.startLoop(surface, generation, restart);
			return;
		}

		// Parked. Whatever was last painted stays on screen and nothing is
		// scheduled - that is what "park on a static frame" means, and it is the
		// same code path for reduced motion, blur, battery, heat and typing.
		surface.frame.clear();

		if (surface.lastRenderedAt === 0) {
			// Except on a surface that has never painted, which would otherwise be
			// a transparent canvas. One frame, at zero intensity, so the resting
			// image is the art rather than an empty rectangle. The guard keeps it
			// to one frame per surface: ladder churn repaints nothing.
			surface.lastRenderedAt = surface.targetWindow.performance.now();
			this.renderFrame(surface, { time: surface.motifTime, delta: 0, intensity: 0, resting: true });
		}
	}

	/**
	 * Starts (or restarts) this window's single animation frame chain.
	 *
	 * `restart` restarts the burst clock, so a trigger replays the motion from
	 * the beginning while a condition merely clearing resumes the burst where it
	 * was. The pending frame is always cancelled and re-armed, never left alone:
	 * a frame scheduled under the previous generation would retire itself the
	 * moment it fired (see {@link onFrame}) and reschedule nothing, which would
	 * stop the loop dead on the next harmless ladder re-evaluation.
	 */
	private startLoop(surface: MotifSurface, generation: number, restart: boolean): void {
		const now = surface.targetWindow.performance.now();

		if (restart || surface.burstStartedAt === 0) {
			surface.burstStartedAt = now;
			surface.motifTime = 0;
			surface.budgetStrikes = 0;
		}

		// Reset on EVERY arming, not only on a restart. `onFrame` derives its delta
		// from this, and an unpark that is not a trigger - typing going quiet, the
		// battery or thermal signal clearing, the budget guard re-resolving - would
		// otherwise hand the first frame the whole duration of the park as its
		// delta, teleporting the entire background in one frame. That is exactly
		// the abrupt large-field motion the settle curve exists to keep out. Zero
		// here means the motif resumes from where it stopped.
		surface.lastRenderedAt = 0;

		surface.nextFrameAt = now;
		surface.frame.clear();
		this.scheduleFrame(surface, generation);
	}

	private scheduleFrame(surface: MotifSurface, generation: number): void {
		surface.frame.value = scheduleAtNextAnimationFrame(surface.targetWindow, () => this.onFrame(surface, generation));
	}

	private onFrame(surface: MotifSurface, generation: number): void {
		// The generation guard, for a stop that lands mid-flight: a plan change
		// between scheduling this frame and it firing retires it here rather than
		// letting one stale frame paint over the resting image.
		if (generation !== this.generation || this.plan.mode !== 'run' || this._store.isDisposed) {
			return;
		}

		const now = surface.targetWindow.performance.now();
		const interval = 1000 / this.plan.fps;

		if (now < surface.nextFrameAt - FRAME_SLACK_MS) {
			// Under the ceiling. Skipping against a wall clock rather than
			// trusting the animation frame cadence is the only way 30 means 30 on
			// a 60Hz panel, a 120Hz panel and a 144Hz panel alike.
			this.scheduleFrame(surface, generation);
			return;
		}

		surface.nextFrameAt += interval;
		if (surface.nextFrameAt < now) {
			// A stall must not be caught up on: drop the missed frames and re-base.
			surface.nextFrameAt = now + interval;
		}

		const elapsed = now - surface.burstStartedAt;
		const intensity = this.plan.perpetual ? 1 : settleIntensity(elapsed);
		const rawDelta = surface.lastRenderedAt === 0 ? 0 : now - surface.lastRenderedAt;
		surface.lastRenderedAt = now;

		// The eased delta is what makes settling free for every motif: a motif
		// that animates against `frame.time` runs down to a stop without knowing
		// that settling exists.
		const delta = rawDelta * intensity;
		surface.motifTime += delta;

		const resting = !this.plan.perpetual && intensity === 0;
		const frame: IMotifFrame = { time: surface.motifTime, delta, intensity, resting };

		if (!this.renderFrame(surface, frame)) {
			return; // the renderer failed; `fail()` has already retired everything
		}

		if (resting) {
			// The burst is over. One resting frame was painted, and now nothing in
			// this window runs per frame until the next trigger.
			surface.frame.clear();
			this.publishStatus(this.plan, 'setting');
			return;
		}

		this.scheduleFrame(surface, generation);
	}

	/**
	 * Calls the renderer and polices the main-thread budget around it. Returns
	 * false when the renderer threw or reported failure, in which case the
	 * surface is already gone.
	 */
	private renderFrame(surface: MotifSurface, frame: IMotifFrame): boolean {
		const startedAt = surface.targetWindow.performance.now();

		try {
			surface.renderer.render(frame);
		} catch (error) {
			this.markUnavailable(`the renderer threw while painting: ${error}`);
			return false;
		}

		if (this.overBudget) {
			return true; // already throttled; stop paying for the bookkeeping
		}

		const cost = surface.targetWindow.performance.now() - startedAt;
		if (cost > PRIMAL_MOTIF_FRAME_BUDGET_MS * BUDGET_STRIKE_FACTOR) {
			surface.budgetStrikes++;
			if (surface.budgetStrikes >= BUDGET_STRIKES) {
				this.overBudget = true;
				this.logService.warn(`[primalMotif] '${surface.renderer.id}' spent ${cost.toFixed(2)}ms on the main thread for ${BUDGET_STRIKES} frames in a row, against a ${PRIMAL_MOTIF_FRAME_BUDGET_MS}ms budget. Halving its frame rate for the rest of this session`);

				// Deferred, because this runs with a frame on the stack: re-resolving
				// here would re-arm the loop under a new generation and then let the
				// frame we are inside schedule a stale one over it, which would stop
				// the loop entirely. Guarded to run once by `overBudget` above.
				this.scheduleResolve();
			}
		} else {
			surface.budgetStrikes = 0;
		}

		return true;
	}

	// --- surfaces -----------------------------------------------------------

	/**
	 * Is the ground actually painting in this window? The one place that answers
	 * it, and it is re-asked on every pass.
	 *
	 * Both halves of the answer can change at runtime from settings this contrib
	 * does not own, and neither of them produces an event of its own:
	 *
	 * - `primal-wallpaper-on` is toggled by `primalWallpaperService.applyTo` from
	 *   `resolvePaint`, which paints nothing for `primalCode.wallpaper.mode: 'off'`
	 *   and for `opacity: 0`. When it goes, `primalWallpaper.css` collapses the
	 *   layer to `display: none` - but it leaves the element, and the motif canvas
	 *   inside it, in the DOM. `requestAnimationFrame` fires per window and not
	 *   per element, so `display: none` stops nothing on its own.
	 * - The other chrome designs (see `PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES`) are
	 *   excluded by the `:not()` guard both stylesheets carry, and `.modern-ui` is
	 *   toggled on this very element from a setting while the workbench runs.
	 *
	 * Answering false tears the surface down through the ordinary `mode: 'off'`
	 * path, so a ground that stops painting costs exactly what `motion: 'off'`
	 * costs: nothing. There is one way to turn the ground off, and this is it.
	 */
	private groundPaints(container: HTMLElement): boolean {
		const classes = container.classList;
		return classes.contains(PRIMAL_WALLPAPER_ON_CLASS)
			&& !PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES.some(optOut => classes.contains(optOut));
	}

	/**
	 * Where this window's one surface mounts, and what role that host implies.
	 *
	 * A registered stage wins; otherwise the wallpaper's own layer, which is what
	 * every window used before stages existed and what every window without one
	 * still uses. `undefined` means there is nowhere to paint at all, which is
	 * ordinary during startup - the wallpaper contribution may not have run yet.
	 *
	 * RESTRICTED TO `world`, FOR NOW. `starfield` puts `tone: 'accent'` on its
	 * brightest star layer and paints its nebula pools in `--vscode-focusBorder`
	 * (`media/primalMotifStarfield.css`). At the wallpaper's 0.12 layer opacity,
	 * across the title strip, that is negligible. At stage scale, across most of
	 * a pane, it is a dominant hue field - and hue is precisely what this
	 * product's rules say may never carry meaning, because it is the one thing
	 * some users cannot see. Until `starfield` is reworked to one ink at varying
	 * alpha the way `globe` already is, it does not get a stage; it falls back to
	 * the wallpaper layer here, silently and correctly.
	 */
	private resolveMount(container: HTMLElement): { readonly host: HTMLElement; readonly role: PrimalMotifRole } | undefined {
		// The newest live offer. See {@link stages} for why every offer is kept
		// rather than only the newest: withdrawing this one has to hand the mount
		// back to whichever pane offered before it, not to the wallpaper layer.
		const offers = this.stages.get(container);
		const stage = offers?.[offers.length - 1];
		if (stage && this.activeMotifId === PRIMAL_MOTIF_WORLD_ID) {
			return { host: stage, role: 'stage' };
		}

		// The wallpaper contribution owns this element and keeps its own
		// container->layer map privately, so the motif layer has to find it. The
		// selector is not a magic string: PRIMAL_WALLPAPER_LAYER_CLASS is exported
		// by the wallpaper and imported here, which makes the class name a shared
		// contract the compiler checks. Worth replacing with a service accessor if
		// the wallpaper ever grows one.
		// eslint-disable-next-line no-restricted-syntax
		const layer = container.querySelector<HTMLElement>(`.${PRIMAL_WALLPAPER_LAYER_CLASS}`);
		return layer ? { host: layer, role: 'ground' } : undefined;
	}

	/**
	 * The wallpaper seam.
	 *
	 * The motif does not own a layer; it borrows the wallpaper's. `ensureLayer`
	 * in `primalWallpaperService.ts` appends exactly one `.primal-wallpaper`
	 * element per container and never clears its children, and the stylesheet
	 * gives that element `z-index: -1`, the clamped opacity ceiling and a grain
	 * pseudo-element that paints above its in-flow children. Appending the motif
	 * canvas inside it inherits all three at once and keeps the four opaque slabs
	 * above the whole stratum. `media/primalMotif.css` completes the seam by
	 * dropping the wallpaper's own `background-image` while a motif holds the
	 * ground; nothing in `primalWallpaper` is modified.
	 *
	 * Whether the wallpaper is painting at all is not asked here: {@link groundPaints}
	 * asks it on every pass, before this is ever called, so a ground that stops
	 * painting tears an existing surface down instead of merely declining to build
	 * a new one. That is the right subordination, and it is one check in one place.
	 */
	private ensureSurface(container: HTMLElement): MotifSurface | undefined {
		const mount = this.resolveMount(container);
		if (!mount) {
			// Formerly a silent `return undefined`, which rendered nothing while
			// the status bar went on reporting "moving". There is no recovery to
			// attempt here - the next pass asks again - so this is a diagnostic
			// and not a failure, and it is logged once so a window that keeps
			// re-resolving does not fill the log with it.
			if (!this.missingHostLogged) {
				this.missingHostLogged = true;
				const staged = this.stages.has(container) ? 'a stage is registered for it' : 'no stage is registered for it';
				this.logService.warn(`[primalMotif] Nowhere to paint in this window: ${staged} and there is no '.${PRIMAL_WALLPAPER_LAYER_CLASS}' layer to fall back to. The ground keeps whatever it already shows. Logged once per session.`);
			}
			return undefined;
		}

		const existing = this.surfaces.get(container);
		if (existing) {
			if (existing.contentGeneration === this.contentGeneration && existing.host === mount.host) {
				return existing;
			}
			// Either the motif or the palette changed under it, so the renderer
			// holds a picture that is no longer the right one; or the host did,
			// and the canvas would otherwise be left orphaned in the element it
			// used to live in while the status bar reported motion. Both are
			// rebuilds, and they are the only two things that justify dropping a
			// graphics context.
			this.removeSurface(container);
		}

		const descriptor = getMotifDescriptor(this.activeMotifId);
		if (!descriptor) {
			return undefined;
		}

		const renderer = descriptor.create();

		// A stage measures itself, not the window. `placement()` in
		// `motifs/globe.ts` divides by the CSS size to correct the fixed 640x360
		// buffer being stretched to its host, so a pane-sized surface told the
		// window's size would draw the disc as an ellipse. The ground role keeps
		// the container, which is what it has always measured.
		const measure = mount.role === 'stage' ? mount.host : container;
		const surface = new MotifSurface(container, getWindow(container), renderer, this.contentGeneration, mount.host, mount.role, measure);
		const host: IMotifHost = {
			element: surface.element,
			role: mount.role,
			bufferWidth: PRIMAL_MOTIF_BUFFER_WIDTH,
			bufferHeight: PRIMAL_MOTIF_BUFFER_HEIGHT,
			palette: this.readPalette(this.themeService.getColorTheme()),
			fail: reason => this.markUnavailable(`'${descriptor.id}' reported ${reason}`)
		};

		// A lost WebGL context is observable from the element whatever the renderer
		// does about it, so the scheduler watches too. `preventDefault()` is
		// deliberately NOT called: preventing the default is what asks the browser
		// to restore the context, and rule 7 says never retry.
		surface.add(addDisposableListener(surface.element, 'webglcontextlost', () => this.markUnavailable('a lost WebGL context')));

		if (!renderer.create(host)) {
			surface.dispose();
			this.markRefused(descriptor.id);
			return undefined;
		}

		this.surfaces.set(container, surface);
		return surface;
	}

	/** Token-only, so one motif is correct in all 21 themes without knowing any of them. */
	private readPalette(theme: IColorTheme): IMotifPalette {
		const ink = theme.getColor(foreground)?.toString() ?? '';
		return {
			ground: theme.getColor(editorBackground)?.toString() ?? '',
			ink,
			dim: theme.getColor(descriptionForeground)?.toString() ?? ink,
			accent: theme.getColor(focusBorder)?.toString() ?? ink,
			dark: theme.type === 'dark' || theme.type === 'hcDark'
		};
	}

	/**
	 * One motif declined to paint under the current palette.
	 *
	 * Deliberately not rule 7. `create()` returning false is not only a GPU
	 * failure: `globe.ts` returns false when the active theme defines none of the
	 * tokens it draws from, which says nothing about the graphics stack, nothing
	 * about `galaxy`, and nothing about this motif under the next theme. Treating
	 * it as terminal took the whole layer down for the session, reported it as a
	 * lost graphics context, and left the two obvious recoveries - change the
	 * motif, change the theme - unable to bring it back.
	 *
	 * The refusal is instead recorded against the motif id and expires with the
	 * content generation (see {@link bumpContentGeneration}). 'A false is
	 * permanent' still holds for that motif under that palette.
	 */
	private markRefused(motifId: string): void {
		if (this.refusedMotifs.has(motifId)) {
			return; // already known; a sibling window in this same pass
		}

		this.refusedMotifs.add(motifId);
		this.logService.warn(`[primalMotif] '${motifId}' declined to paint under the active theme's palette; the ground keeps the wallpaper's own wash until the motif or the theme changes`);

		// Deferred for the reason `markUnavailable` defers: this runs inside a pass
		// over the containers, and re-entering the ladder here would reconcile
		// surfaces the caller is still walking. On the next pass the id is refused,
		// so the plan is `off`, no surface is built and this cannot recur.
		this.scheduleResolve();
	}

	/**
	 * Rule 7. Terminal for the session, logged exactly once, and never retried:
	 * a GPU that just failed to give us a context is not a GPU to keep asking.
	 *
	 * Reserved for the failures that really are terminal - `IMotifHost.fail`, a
	 * `webglcontextlost` event, and a renderer that threw mid-frame. A motif
	 * merely declining to paint goes to {@link markRefused} instead.
	 */
	private markUnavailable(reason: string): void {
		if (this.unavailable) {
			return;
		}

		this.unavailable = true;
		if (!this.unavailableLogged) {
			this.unavailableLogged = true;
			this.logService.warn(`[primalMotif] Falling back to a static ground for the rest of this session: ${reason}`);
		}

		this.clearSurfaces();

		// Deferred: this can be called from inside `render()`, and re-entering the
		// ladder while a frame is on the stack would tear down the surface that
		// frame is painting into.
		this.scheduleResolve();
	}

	private removeSurface(container: HTMLElement): void {
		this.surfaces.get(container)?.dispose();
		this.surfaces.delete(container);
		container.classList.remove(PRIMAL_MOTIF_ON_CLASS, PRIMAL_MOTIF_STAGED_CLASS, PRIMAL_MOTIF_INSTANT_CLASS);
	}

	private clearSurfaces(): void {
		for (const container of [...this.surfaces.keys()]) {
			this.removeSurface(container);
		}
	}

	// --- status -------------------------------------------------------------

	/**
	 * Derived from what is actually happening, not from what the plan asked for.
	 * A burst that has run out leaves the plan saying `run` while the loop has
	 * already cleared its own frame, and reporting "moving" there would be a lie
	 * the status bar tells for as long as the window stays focused.
	 */
	private composeStatus(): IPrimalMotifStatus {
		const plan = this.plan;
		const motifId = this.activeMotifId;
		const surface = this.firstSurface();

		if (plan.mode !== 'run' || !surface) {
			return { state: plan.state === 'moving' ? 'resting' : plan.state, motifId, reason: plan.reason, fps: 0 };
		}

		if (!surface.frame.value) {
			// The burst finished and the loop stopped itself. Nothing is scheduled,
			// so nothing is running, whatever the plan says.
			return { state: 'resting', motifId, reason: undefined, fps: 0 };
		}

		if (plan.perpetual) {
			return { state: 'moving', motifId, reason: undefined, fps: plan.fps };
		}

		const elapsed = surface.targetWindow.performance.now() - surface.burstStartedAt;
		const state: PrimalMotifState = settleIntensity(elapsed) < 1 ? 'settling' : 'moving';
		return { state, motifId, reason: undefined, fps: plan.fps };
	}

	/** Any surface will do: there is one per window and they share one plan. */
	private firstSurface(): MotifSurface | undefined {
		for (const surface of this.surfaces.values()) {
			return surface;
		}
		return undefined;
	}

	private publishStatus(plan: IMotifPlan, trigger: PrimalMotifTrigger): void {
		const status = this.composeStatus();
		const previous = this.lastStatus;
		if (previous
			&& previous.state === status.state
			&& previous.motifId === status.motifId
			&& previous.reason === status.reason
			&& previous.fps === status.fps) {
			return;
		}

		this.lastStatus = status;
		this.logService.trace(`[primalMotif] ${status.motifId} is ${status.state} at ${status.fps}fps after '${trigger}' (mode ${plan.mode})`);
		this._onDidChangeStatus.fire(status);
	}
}
