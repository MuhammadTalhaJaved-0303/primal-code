/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/primalMotifStarfield.css';
import { localize } from '../../../../../nls.js';
import {
	IMotifFrame,
	IMotifHost,
	IMotifPalette,
	IMotifRenderer,
	PRIMAL_MOTIF_BURST_SECONDS,
	PrimalMotifKind,
	registerMotif,
} from '../primalMotif.js';
import { acquireMotifContext, clampMotif, readMotifInk, wrapMotif } from './motifPaint.js';

/**
 * Primal Code - the `galaxy` motif: a drifting starfield.
 *
 * The file is named for the technique rather than for the setting value, because
 * the technique is the interesting part: this is a *starfield*, and the reason it
 * can be shipped at all is that a starfield is the cheapest interesting thing a
 * canvas can draw.
 *
 * WHAT COSTS WHAT. The scheduler owns the only loop in the window and calls
 * `render` at most thirty times a second with a 0.5ms main-thread budget.
 * Everything here is arranged around that number:
 *
 * - The nebula - the soft pools of color the stars sit in - is not painted at
 *   all. It is a `background-image` on the canvas element itself, declared in
 *   `../media/primalMotifStarfield.css` from workbench tokens, so the compositor
 *   owns it, it costs exactly zero per frame, and it still follows a theme
 *   change live. Painting it would have meant blending the full 640x360 buffer
 *   twice per frame for a picture that never changes.
 * - The stars are 1px and 2px axis-aligned rectangles, never arcs. `arc()` plus
 *   `fill()` per star is a curve flattening and a scanline fill each; `rect()`
 *   into a shared path is two points and a bounding box. At this scale the two
 *   are visually identical, because the 640x360 buffer is upscaled to the window
 *   with the browser's default bilinear smoothing - which is what turns a 1px
 *   square into a soft round dot, and is free.
 * - Stars are batched by brightness rather than drawn one at a time. Four layers
 *   times four brightness buckets is sixteen `fill()` calls for 246 stars,
 *   instead of 246 `fillRect()` calls.
 * - Nothing is allocated per frame. The per-frame scratch is preallocated once
 *   and reused; the star geometry is written once at construction and read only
 *   from then on.
 *
 * NO LOOP, NO TIMER, NO CLOCK. There is not one in this file. The renderer is
 * handed an already-eased `frame.delta`, accumulates it, and is a pure function
 * of that accumulator - which is also what makes it settle for free: the
 * scheduler eases the delta to zero, so the sky slows and halts without this
 * file knowing that settling exists. Its own clock is used rather than
 * `frame.time` because `frame.time` is the scheduler's burst clock and restarts
 * on every trigger; see the field's own comment.
 *
 * ONE INK, AT A VARYING ALPHA. Every star and every nebula pool in this motif is
 * the theme's `foreground` - `descriptionForeground` where a layer wants the
 * same ink weaker - and nothing else. That is `globe.ts`'s doctrine, stated in
 * its header and now obeyed here: the picture is carried entirely by luminance,
 * so it reads identically for a colour blind user. A light theme gets dark
 * specks on a light ground, because `foreground` always contrasts the theme's
 * own background.
 *
 * IT USED TO CARRY A HUE, AND THAT COST IT THE STAGE. The nearest layer was
 * painted in `palette.accent` and the nebula's two upper pools in
 * `--vscode-focusBorder`, which is a saturated hue in four of the six shipping
 * vibes. Across a 35px title strip at the wallpaper's 0.12 ceiling that was
 * negligible; at stage scale, across most of a code-free pane, it was a
 * dominant hue field - so `primalMotifScheduler.ts` barred this motif from the
 * stage outright. The depth that hue was carrying is now carried by the two
 * things that were always doing most of the work anyway: {@link STAR_LAYERS} is
 * a strictly increasing ladder of alpha and a non-decreasing ladder of size, so
 * a nearer layer is brighter AND bigger, and neither cue depends on being able
 * to tell two hues apart.
 *
 * NO COLOR LITERALS. Every star color comes from {@link IMotifPalette}, i.e.
 * from active-theme tokens, and every nebula color comes from a `--vscode-*`
 * custom property.
 */

// --- identity --------------------------------------------------------------

/** The `primalCode.motif.id` value. */
export const STARFIELD_MOTIF_ID = 'galaxy';

/**
 * The measured median cost of one `render()`, in milliseconds, at the role and
 * host size that cost the most.
 *
 * Measured in the workbench's own Electron renderer, as the median of five
 * batches of a hundred and fifty frames; `test/browser/motifBudget.test.ts` is
 * the harness and re-measures it on every run:
 *
 *     ground  1920x1080 window   0.0147ms   2.9% of the 0.5ms budget
 *     stage   1428x1025 pane     0.0147ms   2.9%
 *
 * The two roles agree to the tick, and that is a fact about the design rather
 * than a coincidence: the same 253 stars go into the same fixed 640x360 buffer
 * whatever the host is, and the only thing the host decides is how far that
 * buffer is stretched afterwards - which is the compositor's work and not this
 * file's. See `IMotifDescriptor.frameCostMs`.
 */
export const STARFIELD_FRAME_COST_MS = 0.0147;

/** Written on the canvas so `primalMotifStarfield.css` can give it the nebula. */
export const STARFIELD_SURFACE_CLASS = 'primal-motif-starfield';

// --- the sky ---------------------------------------------------------------

/**
 * Brightness buckets per layer.
 *
 * This is the batching knob. Every star in a bucket is painted in one `fill()`
 * at one alpha, so the number of draw calls per frame is `layers * buckets` and
 * nothing else. Four is the smallest number at which per-star brightness reads
 * as a range of magnitudes rather than as two kinds of star.
 */
const BRIGHTNESS_BUCKETS = 4;

/**
 * Which palette token a layer paints with. A kind discriminator, not an index.
 *
 * Two members, and there is deliberately no third: `accent` was one until it
 * cost this motif the stage (see the header). Both of these are the same ink at
 * two strengths.
 */
export type StarTone = 'ink' | 'dim';

/**
 * One parallax layer, as authored.
 *
 * Stars are placed on a jittered grid (`columns` x `rows`) rather than at
 * uniform random positions. Uniform sampling clumps, and clumping is expensive
 * here: the four opaque slabs cover the middle of the workbench, so the only
 * ground anyone ever sees is the strip above them and the strip below them. A
 * void in either strip is a visibly empty sky. Stratifying guarantees every cell
 * of the buffer contributes exactly one star.
 *
 * `driftX` and `driftY` are in buffer pixels per second of eased motif time. The
 * deepest layer moves at a sixth of the nearest one, which is the whole of the
 * depth illusion; the absolute speeds are chosen so that a full six-second burst
 * moves the nearest layer under three percent of the buffer width. That is
 * perceptible as movement and nowhere near fast enough to pull the eye off the
 * code.
 */
interface IStarLayerSpec {
	readonly columns: number;
	readonly rows: number;
	/** Edge of the star, in buffer pixels, before the aspect correction. */
	readonly size: number;
	readonly driftX: number;
	readonly driftY: number;
	/** The alpha of the dimmest and the brightest bucket. */
	readonly alphaMin: number;
	readonly alphaMax: number;
	/**
	 * How far twinkle moves a star through its layer's brightness range, 0 to 1.
	 *
	 * Deliberately small, and deliberately slow (see {@link TWINKLE_PERIOD_MIN_MS}):
	 * a star crosses at most a fifth of its range over four and a half seconds or
	 * more. Anything that reads as a flash is both a photosensitivity hazard and
	 * an accessibility failure, so the amplitude is bounded here rather than left
	 * to taste. The deepest layer does not twinkle at all - distance is exactly
	 * what stops a star scintillating.
	 */
	readonly twinkle: number;
	readonly tone: StarTone;
}

/**
 * The four layers, nearest last.
 *
 * THE TWO LADDERS ARE THE DEPTH. `alphaMin`/`alphaMax` never overlap between
 * layers and `size` never decreases, so every layer is separated from its
 * neighbours twice over - by brightness and by how big a star is - and a reader
 * who cannot distinguish two hues loses nothing, because there are not two hues.
 * `motifRegistry.test.ts` asserts both ladders, so a future tweak cannot quietly
 * flatten one of them and leave the depth resting on the other.
 *
 * The deepest layer is the only one in `dim`, which is the same ink weaker: the
 * layer that is furthest away is the one a theme is most entitled to render as
 * secondary ink.
 */
export const STAR_LAYERS: readonly IStarLayerSpec[] = Object.freeze([
	{ columns: 16, rows: 9, size: 1, driftX: 0.9, driftY: -0.16, alphaMin: 0.10, alphaMax: 0.26, twinkle: 0, tone: 'dim' },
	{ columns: 11, rows: 6, size: 1, driftX: 2.1, driftY: -0.38, alphaMin: 0.30, alphaMax: 0.52, twinkle: 0.12, tone: 'ink' },
	{ columns: 7, rows: 4, size: 2, driftX: 4.4, driftY: -0.80, alphaMin: 0.56, alphaMax: 0.78, twinkle: 0.16, tone: 'ink' },
	{ columns: 5, rows: 3, size: 3, driftX: 5.6, driftY: -1.02, alphaMin: 0.82, alphaMax: 1.00, twinkle: 0.20, tone: 'ink' }
] as const);

/**
 * Twinkle periods, in milliseconds. The slowest flicker rate that could be
 * called a flash is three per second; the fastest star here takes four and a
 * half seconds to complete one cycle, which is off that scale by a factor of
 * thirteen. That is why twinkle needs no reduced-motion special case of its own
 * beyond the one the scheduler already applies to the whole layer.
 */
const TWINKLE_PERIOD_MIN_MS = 4500;
const TWINKLE_PERIOD_MAX_MS = 11000;

/** Per-star base brightness, as a fraction of its layer's alpha range. */
const BRIGHTNESS_MIN = 0.05;
const BRIGHTNESS_MAX = 0.95;

/**
 * Light themes get slightly quieter stars.
 *
 * A dark speck on a light ground carries more contrast per unit of alpha than a
 * light speck on a dark one, so the same numbers read louder on a light theme.
 * This is the one place {@link IMotifPalette.dark} is used.
 */
const LIGHT_THEME_ALPHA_SCALE = 0.8;

/**
 * How far the aspect correction is allowed to go.
 *
 * The buffer is a fixed 640x360 stretched to whatever shape the workbench is, so
 * a star drawn as a square in buffer space arrives on screen as a rectangle. The
 * correction restores it; the clamp stops a pathologically tall or wide window
 * from turning 2px stars into streaks.
 */
const ASPECT_MIN = 0.5;
const ASPECT_MAX = 2.5;

/** Up to four copies of a star are emitted per frame, for the two wrap seams. */
const MAX_COPIES_PER_STAR = 4;

/** Probes for {@link isPaintable}. Two, so a value equal to one of them is still detected. */
const PAINT_PROBE_A = '#000000';
const PAINT_PROBE_B = '#ffffff';

/** Golden-ratio odd constant, the usual way to decorrelate one seed into several. */
const SEED_STRIDE = 0x9e3779b9;

// --- the PRNG --------------------------------------------------------------

/**
 * mulberry32: thirty-two bits of state, four operations, no dependencies.
 *
 * `Math.random` is banned in this build and would be wrong here anyway. The sky
 * has to be *the same sky* every time a given theme is active - across a
 * restart, across every window, and across a settle-and-retrigger - or the
 * ground reshuffles under the user each time they focus the window, which reads
 * as a glitch rather than as depth. A seeded stream gives that for free and
 * costs one closure.
 */
function createRandom(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
	};
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The seed: FNV-1a over the resolved palette.
 *
 * Seeding from the theme's own colors rather than from a constant means every
 * theme gets its own sky and keeps it, and it needs nothing the renderer
 * contract does not already hand over - there is no theme identity on
 * {@link IMotifHost}, and inventing a route to one would have been a second way
 * to reach the theme service from a layer that is deliberately given none. A
 * theme change rebuilds the renderer, so the sky re-rolls exactly then, and two
 * windows on the same theme show the same sky because they hash the same
 * strings.
 */
function seedFromPalette(palette: IMotifPalette): number {
	const text = `${palette.ground}|${palette.ink}|${palette.dim}|${palette.accent}|${palette.dark}`;
	let hash = FNV_OFFSET_BASIS;

	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, FNV_PRIME);
	}

	return hash >>> 0;
}

// --- geometry --------------------------------------------------------------

/**
 * One layer, generated. Every array is written once during construction and read
 * only from then on: the drift is applied on the way out and never stored back,
 * so a burst can be replayed from any `frame.time` and produce the identical
 * picture. That is what makes the resting frame reproducible.
 */
interface IStarLayer {
	readonly spec: IStarLayerSpec;
	readonly color: string;
	readonly x: Float32Array;
	readonly y: Float32Array;
	readonly brightness: Float32Array;
	readonly phase: Float32Array;
	/** Radians per millisecond of eased motif time. */
	readonly rate: Float32Array;
}

function buildLayer(spec: IStarLayerSpec, color: string, seed: number, width: number, height: number): IStarLayer {
	const random = createRandom(seed);
	const count = spec.columns * spec.rows;
	const cellWidth = width / spec.columns;
	const cellHeight = height / spec.rows;

	const x = new Float32Array(count);
	const y = new Float32Array(count);
	const brightness = new Float32Array(count);
	const phase = new Float32Array(count);
	const rate = new Float32Array(count);

	for (let row = 0; row < spec.rows; row++) {
		for (let column = 0; column < spec.columns; column++) {
			const index = row * spec.columns + column;

			// Jittered across the whole cell, not inset into it: an inset leaves a
			// regular gap along every cell boundary and the grid becomes visible.
			x[index] = (column + random()) * cellWidth;
			y[index] = (row + random()) * cellHeight;

			brightness[index] = BRIGHTNESS_MIN + random() * (BRIGHTNESS_MAX - BRIGHTNESS_MIN);
			phase[index] = random() * Math.PI * 2;

			const period = TWINKLE_PERIOD_MIN_MS + random() * (TWINKLE_PERIOD_MAX_MS - TWINKLE_PERIOD_MIN_MS);
			rate[index] = (Math.PI * 2) / period;
		}
	}

	return { spec, color, x, y, brightness, phase, rate };
}

/** Appends one point to a bucket and returns the new count. */
function writePoint(points: Float32Array, slot: number, x: number, y: number): number {
	points[slot * 2] = x;
	points[slot * 2 + 1] = y;
	return slot + 1;
}

/**
 * Whether the canvas will actually paint with this color.
 *
 * A canvas silently keeps its previous fill style when handed a value it cannot
 * parse, so a blank or malformed token would leave the stars painted in whatever
 * came before - black, on the first frame, which is the one failure mode that
 * would be worse than painting nothing. Probing from two different sentinels is
 * what makes the answer trustworthy for a value that happens to equal one of
 * them: any parseable color differs from at least one of black and white.
 */
function isPaintable(context: CanvasRenderingContext2D, value: string): boolean {
	if (!value) {
		return false;
	}

	context.fillStyle = PAINT_PROBE_A;
	context.fillStyle = value;
	if (context.fillStyle !== PAINT_PROBE_A) {
		return true;
	}

	context.fillStyle = PAINT_PROBE_B;
	context.fillStyle = value;
	return context.fillStyle !== PAINT_PROBE_B;
}

/**
 * Ordered fallbacks for a tone: a layer would rather be the wrong strength of
 * the theme's own ink than not be there at all.
 *
 * Both chains end at the other ink token and nowhere else. `palette.accent` is
 * deliberately absent from both and must not be added back - it resolves to
 * `focusBorder`, and a hue in the ground is the one thing here that some readers
 * could not see. `create()` has already refused a palette that offers neither
 * ink, so a chain that falls off its end cannot happen in practice; if it ever
 * did, the layer is dropped rather than painted in something else.
 */
function tonePreference(palette: IMotifPalette, tone: StarTone): readonly string[] {
	return tone === 'dim'
		? [palette.dim, palette.ink]
		: [palette.ink, palette.dim];
}

// --- the renderer ----------------------------------------------------------

class StarfieldMotifRenderer implements IMotifRenderer {

	readonly id = STARFIELD_MOTIF_ID;
	readonly label = localize('primalCode.motif.galaxy.label', "Galaxy");
	readonly kind: PrimalMotifKind = 'canvas2d';

	private context: CanvasRenderingContext2D | undefined;
	private layers: readonly IStarLayer[] = [];
	private width = 0;
	private height = 0;

	/** Set once from the theme's polarity; see {@link LIGHT_THEME_ALPHA_SCALE}. */
	private alphaScale = 1;

	/**
	 * How much taller than wide a star has to be drawn in buffer space to arrive
	 * square on screen. 1 until the first {@link resize}, which is the correct
	 * value for the 16:9 the buffer already is.
	 */
	private pixelAspect = 1;

	/**
	 * Per-frame scratch, shared by every layer because layers are drawn one at a
	 * time. Each bucket holds interleaved x,y pairs; `bucketCounts` says how many
	 * of each are live. Sized for the largest layer times the four copies a star
	 * sitting on both wrap seams needs, so it can never overflow and never has to
	 * grow.
	 *
	 * This is the only state that changes per frame, and it is pure output:
	 * nothing reads it between frames.
	 */
	private bucketPoints: readonly Float32Array[] = [];
	private readonly bucketCounts = new Int32Array(BRIGHTNESS_BUCKETS);

	/**
	 * Eased milliseconds of motion this renderer has been handed, accumulated from
	 * `frame.delta` rather than read from `frame.time`.
	 *
	 * `frame.time` is the scheduler's *burst* clock, and it is reset to zero on
	 * every trigger - a window regaining focus, a workspace opening - while the
	 * renderer itself is kept, because a trigger does not change what is painted.
	 * A sky drawn from that clock would therefore snap back to its seed positions
	 * on every alt-tab: the nearest layer jumps some twenty buffer pixels and every
	 * twinkle phase resets at the same instant. Accumulating the delta keeps this a
	 * pure function of its own clock, which never goes backwards. The delta is
	 * already eased by the settle curve, so the sky still runs down to a stop for
	 * free and this file still knows nothing about settling.
	 */
	private elapsedMs = 0;

	create(host: IMotifHost): boolean {
		// No 2D context at all is a refusal rather than `host.fail`: the scheduler
		// records it against this motif and does not ask again until the palette
		// changes, which is as permanent as it needs to be without declaring the
		// whole layer lost for the session.
		const context = acquireMotifContext(host);
		if (!context) {
			return false;
		}

		if (!readMotifInk(host.palette)) {
			// A theme that supplies neither `foreground` nor `descriptionForeground`
			// is a theme this cannot be drawn from. The accent is not a third
			// chance - see `motifPaint.ts` - so the sky declines, the scheduler
			// records the refusal, and the ground keeps the wallpaper's own wash.
			return false;
		}

		const element = context.canvas;
		this.context = context;
		this.width = host.bufferWidth;
		this.height = host.bufferHeight;
		this.alphaScale = host.palette.dark ? 1 : LIGHT_THEME_ALPHA_SCALE;

		// The CSS hook for the nebula. Removed again in `dispose`, so an element
		// that outlives this renderer is never left carrying a sky nobody paints.
		element.classList.add(STARFIELD_SURFACE_CLASS);

		this.layers = this.buildLayers(context, host.palette);

		const largest = STAR_LAYERS.reduce((most, layer) => Math.max(most, layer.columns * layer.rows), 0);
		this.bucketPoints = Array.from(
			{ length: BRIGHTNESS_BUCKETS },
			() => new Float32Array(largest * MAX_COPIES_PER_STAR * 2)
		);

		return true;
	}

	/**
	 * Resolves each layer's token to a color the canvas will accept, and drops any
	 * layer whose tone the active theme does not define.
	 *
	 * Dropping rather than failing is deliberate. `create()` returning false takes
	 * this motif off the ground until the motif or the theme changes, and a theme
	 * that is merely missing `descriptionForeground` is not a reason to stop
	 * painting a sky that three other layers can carry. The palette already chains its
	 * own fallbacks, so in practice nothing is ever dropped; were everything
	 * dropped, `render` paints an empty buffer and the CSS nebula alone holds the
	 * ground, which is still a finished picture.
	 */
	private buildLayers(context: CanvasRenderingContext2D, palette: IMotifPalette): readonly IStarLayer[] {
		const seed = seedFromPalette(palette);
		const layers: IStarLayer[] = [];

		for (let index = 0; index < STAR_LAYERS.length; index++) {
			const spec = STAR_LAYERS[index];
			const color = tonePreference(palette, spec.tone).find(candidate => isPaintable(context, candidate));
			if (!color) {
				continue;
			}

			// A per-layer stream, so the four layers are independent rather than
			// four consecutive views of one sequence.
			layers.push(buildLayer(spec, color, seed + Math.imul(index + 1, SEED_STRIDE), this.width, this.height));
		}

		return layers;
	}

	/**
	 * The surface's CSS size changed. The 640x360 backing store never does, so the
	 * only thing this affects is how far a buffer pixel is stretched on each axis
	 * - which is exactly how much taller a star has to be drawn to land on screen
	 * as a square rather than as a lozenge.
	 *
	 * Nothing is repainted here. The scheduler owns when a frame happens.
	 */
	resize(width: number, height: number): void {
		if (width <= 0 || height <= 0 || this.width <= 0 || this.height <= 0) {
			return; // a hidden or unlaid-out container; keep the last good aspect
		}

		const stretchX = width / this.width;
		const stretchY = height / this.height;
		this.pixelAspect = clampMotif(stretchX / stretchY, ASPECT_MIN, ASPECT_MAX);
	}

	/**
	 * One frame.
	 *
	 * A pure function of {@link elapsedMs}: the only thing that advances is that
	 * one accumulator, no geometry is mutated, and there are no particles being
	 * born or dying. Two consequences, and both of them are the point of this
	 * design.
	 *
	 * First, the sky settles for free. The scheduler eases `frame.delta` to zero,
	 * so the drift decelerates and the twinkle slows with it, and the last moving
	 * frame is indistinguishable from the resting one.
	 *
	 * Second, *every* frame is a finished picture, so the resting frame needs no
	 * choosing: whatever instant the burst stopped at is a complete sky. That
	 * includes the zero frame, which is what the scheduler paints on a surface
	 * that has never animated - reduced motion, a blurred window, a battery. On a
	 * machine that never runs a burst that seed frame is what the user looks at
	 * all of the time, so it is the frame the layout was authored for: the
	 * stratified placement makes it even, and the seeded brightness gives it a
	 * range of magnitudes rather than a flat grid of identical dots.
	 */
	render(frame: IMotifFrame): void {
		const context = this.context;
		if (!context) {
			return;
		}

		// `delta` and not `time`: see {@link elapsedMs}. The scheduler restarts its
		// burst clock on every trigger, and a sky driven by that clock would
		// jump-cut backwards each time the window regained focus.
		this.elapsedMs += frame.delta;

		context.clearRect(0, 0, this.width, this.height);

		const seconds = this.elapsedMs / 1000;
		for (const layer of this.layers) {
			this.drawLayer(context, layer, this.elapsedMs, seconds);
		}

		context.globalAlpha = 1;
	}

	private drawLayer(context: CanvasRenderingContext2D, layer: IStarLayer, timeMs: number, seconds: number): void {
		const { spec, x: baseX, y: baseY, brightness, phase, rate } = layer;
		const width = this.width;
		const height = this.height;
		const count = baseX.length;

		const starWidth = spec.size;
		const starHeight = spec.size * this.pixelAspect;

		// One modulo for the whole layer instead of one per star. Both offsets land
		// in [0, span), and every base position is in [0, span) too, so the sum is
		// under twice the span and a single conditional subtract wraps it.
		const offsetX = wrapMotif(spec.driftX * seconds, width);
		const offsetY = wrapMotif(spec.driftY * seconds, height);

		const seamX = width - starWidth;
		const seamY = height - starHeight;

		const counts = this.bucketCounts;
		counts.fill(0);

		for (let index = 0; index < count; index++) {
			let starX = baseX[index] + offsetX;
			if (starX >= width) {
				starX -= width;
			}

			let starY = baseY[index] + offsetY;
			if (starY >= height) {
				starY -= height;
			}

			const level = spec.twinkle === 0
				? brightness[index]
				: brightness[index] + spec.twinkle * Math.sin(phase[index] + rate[index] * timeMs);

			const bucket = clampMotif((level * BRIGHTNESS_BUCKETS) | 0, 0, BRIGHTNESS_BUCKETS - 1);
			const points = this.bucketPoints[bucket];
			let slot = counts[bucket];

			// A star straddling a seam is emitted on both sides of it, so it slides
			// off one edge and onto the other instead of blinking out. Four copies
			// only in the corner, where both seams apply at once.
			const overX = starX > seamX;
			const overY = starY > seamY;

			slot = writePoint(points, slot, starX, starY);
			if (overX) {
				slot = writePoint(points, slot, starX - width, starY);
			}
			if (overY) {
				slot = writePoint(points, slot, starX, starY - height);
			}
			if (overX && overY) {
				slot = writePoint(points, slot, starX - width, starY - height);
			}

			counts[bucket] = slot;
		}

		const range = spec.alphaMax - spec.alphaMin;
		context.fillStyle = layer.color;

		for (let bucket = 0; bucket < BRIGHTNESS_BUCKETS; bucket++) {
			const used = counts[bucket];
			if (used === 0) {
				continue;
			}

			// The bucket's center, not its edge, so the dimmest bucket is still lit
			// and the brightest one is not blown out.
			context.globalAlpha = (spec.alphaMin + range * ((bucket + 0.5) / BRIGHTNESS_BUCKETS)) * this.alphaScale;

			const points = this.bucketPoints[bucket];
			context.beginPath();
			for (let point = 0; point < used; point++) {
				context.rect(points[point * 2], points[point * 2 + 1], starWidth, starHeight);
			}
			context.fill();
		}
	}

	dispose(): void {
		// The element and its backing store belong to the surface; what belongs to
		// this renderer is the class it added and the references it holds.
		this.context?.canvas.classList.remove(STARFIELD_SURFACE_CLASS);
		this.context = undefined;
		this.layers = [];
		this.bucketPoints = [];
	}
}

// --- registration ----------------------------------------------------------

registerMotif({
	id: STARFIELD_MOTIF_ID,
	label: localize('primalCode.motif.galaxy', "Galaxy"),
	description: localize('primalCode.motif.galaxy.description', "A starfield drifting behind the workbench in four parallax layers, painted in the active theme's own ink so it suits a light theme as readily as a dark one. Under the default 'settle' motion it drifts for about {0} seconds after a trigger and then rests.", PRIMAL_MOTIF_BURST_SECONDS),
	kind: 'canvas2d',
	frameCostMs: STARFIELD_FRAME_COST_MS,
	// A slow, even, characterless drift is the one kind of motion that is
	// tolerable indefinitely: there is no event in it to wait for and no phase to
	// notice. It is still an opt-in, and the status bar still offers the pause.
	allowsPerpetual: true,
	create: () => new StarfieldMotifRenderer()
});
