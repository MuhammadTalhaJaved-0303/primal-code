/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { PRIMAL_WALLPAPER_ON_CLASS } from '../../primalWallpaper/browser/primalWallpaper.js';

/**
 * Primal Code - motif contracts.
 *
 * WHY THIS EXISTS. A VS Code color theme cannot animate: the theme service
 * replaces a stylesheet's `textContent` wholesale on every change, so there is
 * no frame to hook. Motion therefore lives in a separate layer - a "motif" -
 * that renders into the same ground stratum the wallpaper owns, and that a
 * theme may name a default for.
 *
 * THE ONE RULE THIS FILE ENFORCES. A motif never owns a loop. There is no
 * `start`, no `stop`, no timer and no way to reach `requestAnimationFrame` from
 * anything here: the scheduler calls {@link IMotifRenderer.render} and decides
 * when, how often, and whether at all. The measured cost of animation in an
 * Electron workbench is the loop itself, not the arithmetic inside it (a
 * no-op passthrough shader at 120fps took an M3 Pro from ~2% to 95% GPU, and
 * each additional surface added ~25%), so the number of loops is the only
 * number that has to be defended - and it is defended here, by construction.
 *
 * Nothing in this file touches the DOM, a service or a timer. It is names,
 * shapes and pure functions, so both halves of the feature agree on one
 * spelling of everything and the registry can be read before the workbench is
 * up.
 */

// --- settings --------------------------------------------------------------

export const PRIMAL_MOTIF_ID_SETTING_ID = 'primalCode.motif.id';
export const PRIMAL_MOTIF_MOTION_SETTING_ID = 'primalCode.motif.motion';
export const PRIMAL_MOTIF_PERPETUAL_ON_BATTERY_SETTING_ID = 'primalCode.motif.perpetualOnBattery';

/** Every setting the scheduler reacts to, for the `onDidChangeConfiguration` filter. */
export const PRIMAL_MOTIF_SETTING_IDS: readonly string[] = Object.freeze([
	PRIMAL_MOTIF_ID_SETTING_ID,
	PRIMAL_MOTIF_MOTION_SETTING_ID,
	PRIMAL_MOTIF_PERPETUAL_ON_BATTERY_SETTING_ID
]);

/**
 * How long motion is allowed to run.
 *
 * `settle` is the default and the reason this feature is shippable: a trigger
 * starts a short burst that eases to a resting frame, so steady-state cost is
 * exactly zero and WCAG 2.2.2 (Level A, "moving content that starts
 * automatically and lasts more than five seconds") is satisfied by the shape of
 * the default rather than by a preference the user has to find.
 * `prefers-reduced-motion` on its own does not satisfy 2.2.2.
 *
 * `perpetual` is the explicit opt-in. It is only offered together with a
 * discoverable pause control in the status bar - never a settings line alone.
 */
export type PrimalMotifMotion = 'settle' | 'perpetual' | 'off';

export const PRIMAL_MOTIF_MOTIONS: readonly PrimalMotifMotion[] = Object.freeze(['settle', 'perpetual', 'off'] as const);

/** The motif that ships as the default: the wallpaper's own static wash, unchanged. */
export const PRIMAL_MOTIF_STATIC_ID = 'static';

/**
 * The motif a fresh install shows: the world. Spelled as a literal rather than
 * imported from `motifs/globe.ts`, which imports this file; `primalMotifDefault.test.ts`
 * pins it to `PRIMAL_MOTIF_WORLD_ID` and to a registered descriptor.
 *
 * Shipping a motif ON by default is what makes the ladder's default motion
 * (`settle`) load-bearing for WCAG 2.2.2: a burst of `PRIMAL_MOTIF_BURST_MS`
 * (4.5 s) eases to rest on its own inside the five seconds the criterion counts
 * from, so nothing that starts automatically moves for longer than that, and
 * the reader never has to find a control to make it stop. The same test pins
 * that arithmetic.
 */
export const PRIMAL_MOTIF_DEFAULT_ID = 'world';
export const PRIMAL_MOTIF_DEFAULT_MOTION: PrimalMotifMotion = 'settle';
export const PRIMAL_MOTIF_DEFAULT_PERPETUAL_ON_BATTERY = false;

// --- budget ----------------------------------------------------------------

/**
 * The hard performance budget. These are ceilings, not targets, and nothing in
 * this contrib is allowed to expose a way past them.
 *
 * 30fps is never raised to 60 or 120: the loop is the cost, and a loop that
 * wakes half as often costs half as much. The buffer is fixed rather than sized
 * to the device, so a 5K display costs exactly what a laptop panel costs:
 * 640 * 360 * 4 bytes is under a megabyte of backing store, against a 32MB
 * ceiling for everything the motif is allowed to hold on the GPU.
 */
export const PRIMAL_MOTIF_MAX_FPS = 30;

/** The ceiling that applies on battery, and only when perpetual-on-battery was opted into. */
export const PRIMAL_MOTIF_BATTERY_FPS = 15;

/** The fixed render buffer, upscaled by CSS. Never the device resolution. */
export const PRIMAL_MOTIF_BUFFER_WIDTH = 640;
export const PRIMAL_MOTIF_BUFFER_HEIGHT = 360;

/** Main-thread work one `render()` call is allowed, in milliseconds. */
export const PRIMAL_MOTIF_FRAME_BUDGET_MS = 0.5;

/**
 * Main-thread work one `resize()` call is allowed, in milliseconds.
 *
 * A resize is not a frame and is not policed like one: it happens once per
 * layout rather than thirty times a second, and the frame budget's remedy -
 * halving the frame rate - would not make a rebuild any cheaper. But a
 * renderer that rebuilds its tables from `resize()` can cost far more than a
 * frame does, and the scheduler's strike counter brackets only `render()`, so
 * without this the most expensive thing this contrib does would be the one
 * thing nothing ever measured. Eight frame budgets: generous for a one-off,
 * still well inside a 60Hz frame. The scheduler reports an overrun once per
 * session rather than throttling on it, and `test/browser/motifBudget.test.ts`
 * measures every motif's `resize()` against it in both roles.
 */
export const PRIMAL_MOTIF_LAYOUT_BUDGET_MS = PRIMAL_MOTIF_FRAME_BUDGET_MS * 8;

/** How long after a keystroke or a wheel event motion stays suppressed. */
export const PRIMAL_MOTIF_INPUT_QUIET_MS = 250;

// --- settle curve ----------------------------------------------------------

/**
 * Total length of one burst of motion, from a trigger to rest.
 *
 * Under five seconds, and that is the whole reason for the number. WCAG 2.2.2
 * (Level A) applies to motion that starts automatically and runs for *more than
 * five seconds* alongside other content; a burst replays on every window focus,
 * so the entire burst - the hold plus the ease that follows it - has to finish
 * inside that threshold for the default configuration to satisfy the criterion
 * by its own shape, with no control for the user to find. A burst that ran to
 * six seconds would need a pause control on screen the whole time it ran, which
 * is precisely what `settle` exists to avoid.
 */
export const PRIMAL_MOTIF_BURST_MS = 4500;

/** How much of that burst runs at full speed before the easing starts. */
export const PRIMAL_MOTIF_HOLD_MS = 2500;

/**
 * The burst length in whole seconds, for the sentences that describe it.
 *
 * Floored rather than rounded, so the number a reader is given is never longer
 * than the burst actually is - and in particular never reads back as the five
 * seconds WCAG 2.2.2 counts from. Every user-facing mention of the duration
 * derives from here, so the constant above stays the only place it is decided.
 */
export const PRIMAL_MOTIF_BURST_SECONDS = Math.floor(PRIMAL_MOTIF_BURST_MS / 1000);

/**
 * The settle curve: 1 while the burst holds, then a cubic ease to 0.
 *
 * `(1 - t)^3` is used rather than a linear ramp because its derivative is zero
 * at `t = 1`: the motif does not stop, it runs out of momentum, and the last
 * frame before rest is indistinguishable from the resting frame. A linear ramp
 * ends with visible velocity and reads as a freeze.
 *
 * The scheduler multiplies the frame delta by this, so a motif that simply
 * animates against `frame.time` decelerates correctly without knowing that
 * settling exists.
 */
export function settleIntensity(elapsedMs: number): number {
	if (!(elapsedMs > PRIMAL_MOTIF_HOLD_MS)) {
		return 1; // also covers NaN, which must never read as "settled"
	}
	if (elapsedMs >= PRIMAL_MOTIF_BURST_MS) {
		return 0;
	}

	const remaining = 1 - (elapsedMs - PRIMAL_MOTIF_HOLD_MS) / (PRIMAL_MOTIF_BURST_MS - PRIMAL_MOTIF_HOLD_MS);
	return remaining * remaining * remaining;
}

// --- DOM names -------------------------------------------------------------

/** The element the scheduler owns inside the wallpaper's layer. */
export const PRIMAL_MOTIF_SURFACE_CLASS = 'primal-motif-surface';

/**
 * The element a code-free pane offers as a host, through
 * {@link IPrimalMotifService.registerStage}. The pane creates and owns it; the
 * scheduler only mounts its one surface into it.
 */
export const PRIMAL_MOTIF_STAGE_CLASS = 'primal-motif-stage';

/** On the workbench container while a non-static motif holds the ground. */
export const PRIMAL_MOTIF_ON_CLASS = 'primal-motif-on';

/** On the workbench container while the surface should appear without a cross-fade. */
export const PRIMAL_MOTIF_INSTANT_CLASS = 'primal-motif-instant';

/**
 * On the workbench container while the surface is mounted on a stage rather
 * than in the wallpaper's own layer - see {@link PrimalMotifRole}.
 *
 * {@link PRIMAL_MOTIF_ON_CLASS} says only that a surface exists somewhere in
 * this window, which is not enough for the two rules in `media/primalMotif.css`
 * that trade something away *because* the motif is holding the chrome's ground:
 * the wallpaper's `background-image` seam and the `tintSlabs` revocation. Both
 * of those premises are false for a staged surface - it is inside an editor
 * pane, nowhere near the wash it would otherwise be compositing over and
 * nowhere near the slabs the tint bleeds through - so they are written to skip
 * this class rather than to key on the presence of a surface alone.
 */
export const PRIMAL_MOTIF_STAGED_CLASS = 'primal-motif-staged';

/**
 * The chrome design that ships in this fork and owns the ground selectors
 * itself, so it opts out of this layer entirely.
 *
 * `media/primalMotif.css` and `primalWallpaper.css` carry the same class in
 * their `:not()` guard, so under it the wallpaper layer *and* the motif surface
 * are `display: none`. That is a stylesheet fact the scheduler has to know as
 * well: a loop running into a surface the stylesheet has made invisible costs
 * exactly as much as a visible one, and the class is toggled at runtime
 * (`modernUI.contribution.ts` writes `.modern-ui` from a setting), so this
 * cannot be answered once at startup. Read through {@link groundPaintsIn}, the
 * one rule that decides whether the ground is actually painting in a window.
 *
 * The Agents window (`agent-sessions-workbench`, `vs/sessions`) used to be
 * listed here as well. It is not a different ground: its entry point
 * (`sessions.common.main.ts`) loads the vibes, the wallpaper and this
 * contribution, its parts are opaque slabs on the `--vscode-agents-*` tokens,
 * and its title bar and the gaps between its floating panels are exactly the
 * chrome the ground was made for. A motif chosen once is the motif of every window - the setting
 * is application-scoped for that reason - so the class left this list, and the
 * window's code-free "New session" landing offers a stage
 * (`vs/sessions/contrib/chat/browser/newChatMotifStage.ts`) the way Primal
 * Start does. `primalChrome.css` still excludes it: the slab chrome is the IDE
 * window's, and the sessions window owns its own parts.
 */
export const PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES: readonly string[] = Object.freeze([
	'modern-ui'
]);

/**
 * Is the ground painting in a window whose workbench element carries these
 * classes? Pure, so the rule is testable without a scheduler. Both halves
 * change at runtime and neither raises an event of its own, which is why
 * `groundPaints` in `primalMotifScheduler.ts` re-asks on every pass:
 *
 * - the wallpaper has to be on. `PRIMAL_WALLPAPER_ON_CLASS` is toggled by
 *   `primalWallpaperService.applyTo`, which paints nothing for
 *   `primalCode.wallpaper.mode: 'off'` and for `opacity: 0`;
 * - none of the chrome designs in {@link PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES}
 *   may be active, because the stylesheets hide the layer under them.
 */
export function groundPaintsIn(classes: { contains(token: string): boolean }): boolean {
	return classes.contains(PRIMAL_WALLPAPER_ON_CLASS)
		&& !PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES.some(optOut => classes.contains(optOut));
}

/** Written on the surface element; the cross-fade between the wash and the motif. */
export const PRIMAL_MOTIF_FADE_PROPERTY = '--primal-motif-fade';

// --- the renderer contract -------------------------------------------------

export type PrimalMotifKind = 'css' | 'canvas2d' | 'webgl';

/**
 * The palette a motif is allowed to paint with: workbench theme tokens,
 * resolved to CSS color strings by the scheduler and handed over.
 *
 * Token-only, with no literal anywhere, is what makes one motif work for all 21
 * themes. A motif that wants "blue" has to say which token it means.
 */
export interface IMotifPalette {
	/** `editor.background`. The tone the motif is painted onto. */
	readonly ground: string;
	/** `foreground`. Full-strength ink. */
	readonly ink: string;
	/** `descriptionForeground`. Secondary ink. */
	readonly dim: string;
	/** `focusBorder`. The one accent the workbench guarantees. */
	readonly accent: string;
	/** True when the active theme is dark, for motifs that need to know which way "up" is. */
	readonly dark: boolean;
}

/**
 * What kind of ground a motif has been handed.
 *
 * A literal union rather than a boolean, deliberately: the next host this layer
 * grows - a full-window overlay, a splash, an empty-group watermark - is then a
 * new member and a new `switch` arm, not a second flag that has to be read
 * together with the first to mean anything.
 *
 * `ground` is the workbench chrome's own strip: the ~35px title bar, the status
 * bar and the slabs' corner notches, which is all the ground a workbench with
 * four flush opaque slabs actually shows.
 * `stage` is a large code-free pane - Primal Start, the Rig - which is mostly
 * empty and is therefore the one place a picture can be big enough to read as
 * one. A motif that does not care may ignore this entirely.
 */
export type PrimalMotifRole = 'ground' | 'stage';

/**
 * Everything a motif is given. Note what is absent: no window, no document, no
 * scheduler, no service. A motif can paint and it can report that it cannot,
 * and that is the whole of its authority.
 */
export interface IMotifHost {
	/** The element the motif paints into. A `<canvas>` for the canvas kinds, a `<div>` for `css`. */
	readonly element: HTMLElement;

	/** What kind of ground this is. See {@link PrimalMotifRole}. */
	readonly role: PrimalMotifRole;

	/** The fixed backing store, in device-independent buffer pixels. Never the device resolution. */
	readonly bufferWidth: number;
	readonly bufferHeight: number;

	/** Theme tokens, already resolved. Re-read on every `create()`; a theme change re-creates. */
	readonly palette: IMotifPalette;

	/**
	 * Reports that this motif cannot run - a GPU context that could not be
	 * created or that was lost. The scheduler falls back to a static frame for
	 * the rest of the session and never retries, so calling this is terminal.
	 */
	fail(reason: string): void;
}

/** What one call to {@link IMotifRenderer.render} is told. */
export interface IMotifFrame {
	/**
	 * Eased motif time in milliseconds since this burst began. It advances more
	 * slowly as the burst settles and stops advancing at rest, so animating
	 * against it settles for free.
	 */
	readonly time: number;

	/** The eased advance since the previous rendered frame. `0` on the first frame of a burst. */
	readonly delta: number;

	/** 1 at full motion, easing to 0 at rest. See {@link settleIntensity}. */
	readonly intensity: number;

	/** True on the one frame that paints the resting image, after which the loop stops. */
	readonly resting: boolean;
}

/**
 * A motif. Implementations are pure painters: they are handed a surface and a
 * frame and they draw. They never schedule, never time, never observe
 * visibility, and never decide whether they should be running.
 */
export interface IMotifRenderer extends IDisposable {
	readonly id: string;
	readonly label: string;
	readonly kind: PrimalMotifKind;

	/**
	 * Prepares to paint into `host`. Returns `false` when this motif cannot be
	 * drawn from what it was handed - a context that would not initialise, or a
	 * palette it cannot make a picture out of.
	 *
	 * A `false` here is permanent for *this motif under this palette*: the
	 * scheduler records the refusal and does not ask again until the palette
	 * changes, which is the only thing that could change the answer. It is
	 * deliberately not terminal for the layer - another motif, or this one under
	 * another theme, is unaffected. Use {@link IMotifHost.fail} for the failures
	 * that really are terminal: a lost graphics context.
	 */
	create(host: IMotifHost): boolean;

	/** Paints one frame. Must stay inside {@link PRIMAL_MOTIF_FRAME_BUDGET_MS} of main-thread work. */
	render(frame: IMotifFrame): void;

	/**
	 * The surface's size in CSS pixels changed. The backing store never does;
	 * this is for aspect. Must stay inside {@link PRIMAL_MOTIF_LAYOUT_BUDGET_MS}
	 * of main-thread work, and must not paint: the scheduler paints the frame
	 * that follows a resize, whether the loop is running or the surface is at
	 * rest, so a renderer that repainted here would upload twice.
	 */
	resize(width: number, height: number): void;

	dispose(): void;
}

/** What the registry knows about a motif before anyone asks for an instance. */
export interface IMotifDescriptor {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly kind: PrimalMotifKind;

	/**
	 * Whether `primalCode.motif.motion: 'perpetual'` is honoured for this motif.
	 * Perpetual motion is a per-motif opt-in, not a global switch: a motif that
	 * says `false` here always settles, whatever the setting says.
	 */
	readonly allowsPerpetual: boolean;

	/**
	 * The MEASURED main-thread cost of one {@link IMotifRenderer.render} call, in
	 * milliseconds, at whichever role and host size costs this motif the most.
	 *
	 * A declaration, not a target, and it has to be a number somebody took off a
	 * clock: `test/browser/motifBudget.test.ts` runs every registered motif for a
	 * few hundred frames and holds its median against this figure, so a motif
	 * whose cost drifted upwards fails a test rather than quietly eating a
	 * thirtieth of a second somewhere in the field. The reason it lives on the
	 * descriptor rather than only in each motif's header is that the test is
	 * written over {@link getMotifDescriptors}, so a motif that ships without
	 * measuring itself cannot exist.
	 *
	 * It must be at or under {@link PRIMAL_MOTIF_FRAME_BUDGET_MS}, which is the
	 * budget itself and is never relaxed to fit a renderer. `0` is the honest
	 * answer for a motif the scheduler never calls `render` on - `static` is the
	 * only one.
	 */
	readonly frameCostMs: number;

	/** Builds a fresh renderer. Called once per surface, and again after a theme change. */
	create(): IMotifRenderer;
}

// --- the registry ----------------------------------------------------------

const motifDescriptors = new Map<string, IMotifDescriptor>();
const onDidRegisterMotifEmitter = new Emitter<IMotifDescriptor>();

/**
 * Fires when a motif is added. The contribution listens so the
 * `primalCode.motif.id` enum stays honest as motif files are imported.
 */
export const onDidRegisterMotif: Event<IMotifDescriptor> = onDidRegisterMotifEmitter.event;

/**
 * Adds a motif. This is the seam every motif author uses; nobody needs the
 * service instance to publish one, so a motif file can be a leaf that the
 * contribution imports and nothing imports back.
 */
export function registerMotif(descriptor: IMotifDescriptor): IDisposable {
	if (motifDescriptors.has(descriptor.id)) {
		throw new Error(`A motif with the id '${descriptor.id}' is already registered`);
	}

	motifDescriptors.set(descriptor.id, descriptor);
	onDidRegisterMotifEmitter.fire(descriptor);

	return toDisposable(() => motifDescriptors.delete(descriptor.id));
}

export function getMotifDescriptor(id: string): IMotifDescriptor | undefined {
	return motifDescriptors.get(id);
}

export function getMotifDescriptors(): readonly IMotifDescriptor[] {
	return [...motifDescriptors.values()];
}

// --- the static motif ------------------------------------------------------

/**
 * The default, and the reason the default path is not a special case: `static`
 * goes through the scheduler like every other motif, is resolved by the same
 * registry lookup and hits the same ladder. It paints nothing at all - the
 * ground stays exactly the wallpaper's own wash - so the scheduler recognises
 * it, keeps the surface torn down and never starts a loop. What it exercises is
 * the resolution, the ladder and the wallpaper seam, every time the product
 * starts with nothing moving.
 */
class StaticMotifRenderer implements IMotifRenderer {

	readonly id = PRIMAL_MOTIF_STATIC_ID;
	readonly label = localize('primalCode.motif.static.label', "Static");
	readonly kind: PrimalMotifKind = 'css';

	create(): boolean {
		return true;
	}

	render(): void {
		// Nothing moves, so nothing is painted. The scheduler never calls this.
	}

	resize(): void {
		// Nothing to lay out.
	}

	dispose(): void {
		// Nothing held.
	}
}

registerMotif({
	id: PRIMAL_MOTIF_STATIC_ID,
	label: localize('primalCode.motif.static', "Static"),
	description: localize('primalCode.motif.static.description', "No motion at all. The ground keeps the wallpaper's own wash, and nothing in this window runs per frame."),
	kind: 'css',
	allowsPerpetual: false,
	// Nothing is scheduled and `render` is never called: see the class above.
	frameCostMs: 0,
	create: () => new StaticMotifRenderer()
});

// --- narrowing -------------------------------------------------------------

/** Narrows a raw settings value to a known motion mode, defaulting to `settle`. */
export function toMotifMotion(value: unknown): PrimalMotifMotion {
	return PRIMAL_MOTIF_MOTIONS.find(motion => motion === value) ?? PRIMAL_MOTIF_DEFAULT_MOTION;
}

/**
 * Narrows a raw settings value to a registered motif id. An id nobody
 * registered - a hand-edited settings file, or a motif that was removed -
 * resolves to `static` rather than to nothing, so the ground is never broken by
 * a typo.
 */
export function toMotifId(value: unknown): string {
	return typeof value === 'string' && motifDescriptors.has(value) ? value : PRIMAL_MOTIF_STATIC_ID;
}

// --- the service -----------------------------------------------------------

/**
 * What the scheduler is doing right now. Reported in the status bar tooltip in
 * perpetual mode, so "why is nothing moving" always has an answer on screen.
 */
export type PrimalMotifState =
	/** The active motif is `static`, or motion is set to `off`. Nothing is scheduled. */
	| 'static'
	/** A burst is running at full intensity. */
	| 'moving'
	/** A burst is easing towards its resting frame. */
	| 'settling'
	/** A burst finished; the resting frame is on screen and nothing is scheduled. */
	| 'resting'
	/** Something on the degradation ladder parked motion; it resumes when that clears. */
	| 'parked'
	/** The user paused perpetual motion from the status bar. */
	| 'paused'
	/** A GPU context could not be created or was lost. Static for the rest of the session. */
	| 'unavailable';

export interface IPrimalMotifStatus {
	readonly state: PrimalMotifState;
	/** The motif that is (or would be) painting. */
	readonly motifId: string;
	/**
	 * Why motion is not running, as a localized sentence - or why it runs at
	 * half the rate, on the budget guard's rung. `undefined` while motion runs
	 * unthrottled.
	 */
	readonly reason: string | undefined;
	/** The frame rate currently being scheduled, or 0 when nothing is scheduled. */
	readonly fps: number;
}

/** What starts a burst of motion. */
export type PrimalMotifTrigger = 'theme' | 'focus' | 'workspace' | 'setting' | 'command';

export const IPrimalMotifService = createDecorator<IPrimalMotifService>('primalMotifService');

export interface IPrimalMotifService {
	readonly _serviceBrand: undefined;

	/** The resolved motif id; always a registered one, never a raw settings value. */
	readonly activeMotifId: string;

	/** The resolved motion mode. */
	readonly motion: PrimalMotifMotion;

	/** The current state, and why. */
	readonly status: IPrimalMotifStatus;

	/** Fires whenever {@link status} changes; deduplicated, so it is safe to render from. */
	readonly onDidChangeStatus: Event<IPrimalMotifStatus>;

	/** Whether the user paused perpetual motion. Meaningless outside `perpetual`. */
	readonly isPaused: boolean;

	/** Starts a burst, if the ladder allows one. Cheap and idempotent within a burst. */
	trigger(reason: PrimalMotifTrigger): void;

	/** Pauses or resumes perpetual motion. Persists for the session only. */
	setPaused(paused: boolean): void;

	/**
	 * Offers a code-free pane as this window's motif host, and returns the
	 * disposable that withdraws the offer.
	 *
	 * One method, and no `start`, `stop`, timing or frame rate reaches the
	 * caller: a pane says only "there is ground here", and the scheduler still
	 * decides everything else. The offer is honoured on the next re-resolve
	 * rather than where the caller stands, because panes are created, hidden,
	 * shown, moved between groups and disposed far more often than containers
	 * are, and reconciling a surface synchronously from inside a pane callback
	 * would rebuild a graphics context on every one of those.
	 *
	 * It does NOT add a surface. There is still exactly one per container: a
	 * stage REPLACES the wallpaper layer as the mount for that window's single
	 * surface. That is the whole performance argument (a no-op passthrough
	 * shader at 120fps took an M3 Pro from ~2% to 95% GPU, each extra surface
	 * adding ~25%), and it is kept structural rather than tuned.
	 *
	 * @param container the workbench container the pane lives in, from
	 * `IWorkbenchLayoutService.getContainer(getWindow(element))`. Never the pane.
	 * @param element the pane's own stage element - see {@link PRIMAL_MOTIF_STAGE_CLASS}.
	 */
	registerStage(container: HTMLElement, element: HTMLElement): IDisposable;

	/**
	 * Tells this container's surface that its host's CSS box may have changed.
	 *
	 * The cheap half of {@link trigger}, and the only half a layout is entitled
	 * to. `trigger` re-resolves the whole ladder and re-arms the frame chain at
	 * `now`, which defeats the plan's own frame-rate ceiling: a pane forwarding
	 * every mouse-move of a sash drag through it would render at the display's
	 * cadence rather than at the 30fps the ladder decided on, synchronously
	 * inside the workbench's layout pass. A resize needs none of that. It needs
	 * the surface re-measured and the picture repainted at the new shape, which
	 * is what this does and all it does.
	 *
	 * Coalesced and throttled: the first layout after a quiet spell is
	 * re-measured on the next turn, and the ones behind it no more often than
	 * the ceiling frame interval, so a sash drag costs one re-measure per frame
	 * and not one per mouse move. Deferred out of the caller's layout pass in
	 * either case, so the forced geometry read is not interleaved with the
	 * workbench's own layout writes. A surface that changed size while at rest
	 * is repainted by the same flush; one with a frame coming is repainted by
	 * that frame.
	 *
	 * @param container the workbench container, exactly as for {@link registerStage}.
	 */
	relayout(container: HTMLElement): void;
}

/**
 * `e instanceof HTMLCanvasElement` is false for a canvas built in another
 * window, and this product runs two — the workbench and the Agents window — so
 * every surface check has to compare against the element's OWN window's
 * constructor. `dom.ts` ships this shape for the element types it needed
 * (isHTMLElement, isHTMLDivElement, ...) but not for canvas, so the motif layer
 * carries its own, written the same way.
 */
export function isMotifCanvas(e: unknown): e is HTMLCanvasElement {
	// eslint-disable-next-line no-restricted-syntax
	return e instanceof HTMLCanvasElement || e instanceof getWindow(e as Node).HTMLCanvasElement;
}
