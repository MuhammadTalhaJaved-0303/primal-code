/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IMotifFrame, IMotifHost, IMotifRenderer, PRIMAL_MOTIF_BURST_SECONDS, PrimalMotifKind, PrimalMotifRole, registerMotif } from '../primalMotif.js';
import { acquireMotifContext, clampMotif, readMotifInk } from './motifPaint.js';

/**
 * Primal Code - the `contours` motif: a topographic field that breathes.
 *
 * WHAT IT IS, AND WHY IT IS NOT ANOTHER STARFIELD. `galaxy` is points, `world`
 * is a raster sphere; this is line work and nothing else, which is the third
 * kind of picture a canvas can make and the cheapest of the three. A nest of
 * closed curves at rising elevations is also the one composition here that is
 * legible when almost all of it is hidden: a 35px strip through a contour map
 * still shows a family of nested arcs, because that is what a contour map is
 * everywhere, and a strip through a landform is still a landform.
 *
 * THE ONE TRICK THAT MAKES IT CHEAP. Contour lines never cross, so the relief
 * cannot be per-ring noise. It is ONE displacement function of angle, evaluated
 * once per frame for the whole nest and added to every ring:
 *
 *     relief[v] = SUM over harmonics of ( sin(h*theta + phase + rate*t) )
 *     radius_i(v) = base_i * (1 + breath_i(t)) + relief[v] * shape_i
 *
 * so a frame is one pass of about ten multiplies per vertex over the shared
 * relief, and the rings cannot cross because they are all displaced by the same
 * amount. The harmonics themselves cost six transcendentals per frame in total
 * rather than one per vertex: `sin(h*theta + phase + rate*t)` is expanded into
 * `sin(h*theta)*cos(phase + rate*t) + cos(h*theta)*sin(phase + rate*t)`, the two
 * angle tables are baked at `create`, and only the two time terms move.
 *
 * `shape_i` is what keeps the summit round. A ring whose radius is not several
 * times the relief would be turned inside out by it, so the relief is faded out
 * as the rings get small - which is also what a real summit does.
 *
 * MEASURED COST, on the shipped code, as the median of 400 frames in the
 * workbench's own Electron renderer (`test/browser/motifBudget.test.ts` is the
 * harness, and it asserts the number below against a fresh measurement):
 *
 *     stage   16 rings x 128 vertices, 1428x1025 pane     0.0353ms   7.1% of the 0.5ms budget
 *     ground  12 rings x  96 vertices, 1920x1080 window   0.0200ms   4.0%
 *
 * The stage is the expensive role and the declared figure is the stage's. There
 * is no GPU context here for the same reason `world` does not take one: a bind
 * and a draw call would cost more than the whole picture does.
 *
 * BOTH ROLES, AND THEY ARE NOT ONE COMPOSITION SCALED. `ground` is the ~35px
 * chrome strip, so the nest is anchored in SCREEN pixels and its centre put a
 * third of the way down the title bar, exactly as `globe.ts` argues: the strip
 * is a fixed size, so a picture that grew with the window would only get
 * flatter inside it. `stage` is a whole code-free pane, so the nest is anchored
 * to the FRAME instead - the rings are fractions of the pane, the outermost ones
 * run off every edge, and what shows is a piece of a landform far too large to
 * see all of. See {@link computeContourComposition}.
 *
 * ONE INK. Every ring is `foreground` at its own alpha, brightest at the summit
 * and fading outwards, and there is no second token anywhere in this file. Depth
 * is luminance and only luminance, which is the whole doctrine of this folder
 * (`motifPaint.ts`), and a palette that cannot supply that ink is declined
 * rather than substituted for.
 *
 * THE RESTING FRAME. Every frame is a finished map, so whichever one the burst
 * runs out on is the picture: the breathing is a slow swell that has no phase
 * that looks broken and no frame that reads as a freeze rather than a rest.
 */

// --- identity --------------------------------------------------------------

/** The `primalCode.motif.id` value. */
export const PRIMAL_MOTIF_CONTOURS_ID = 'contours';

/**
 * The measured median cost of one `render()`, in milliseconds. See the header
 * for the table it comes from, and `IMotifDescriptor.frameCostMs` for what the
 * number is for.
 */
export const CONTOURS_FRAME_COST_MS = 0.0353;

// --- the relief ------------------------------------------------------------

/**
 * The angular harmonics the whole nest is displaced by.
 *
 * Three, at coprime wave numbers, so the sum does not repeat inside a turn and
 * no ring reads as a rosette. The weights sum to one, which is what lets a role
 * state its relief as a single distance; the periods are long and mutually
 * irrational enough that the field never returns to a pose the eye has just
 * seen.
 */
interface IContourHarmonic {
	/** Lobes around the ring. */
	readonly wave: number;
	/** Share of the composition's relief, summing to 1 across the table. */
	readonly weight: number;
	/** Milliseconds for this harmonic to travel once around the nest. */
	readonly periodMs: number;
}

const HARMONICS: readonly IContourHarmonic[] = Object.freeze([
	{ wave: 2, weight: 0.55, periodMs: 41000 },
	{ wave: 3, weight: 0.30, periodMs: 27000 },
	{ wave: 5, weight: 0.15, periodMs: 63000 }
] as const);

/**
 * How much the whole nest swells and subsides, as a fraction of a ring's radius,
 * and how long one swell takes.
 *
 * Small, and slower than anything else in the file. This is the motion the user
 * is meant to notice they cannot quite see: at 4.5% over 23 seconds a ring moves
 * about a pixel a second, which is weather rather than animation.
 */
export const BREATH_AMPLITUDE = 0.045;
const BREATH_PERIOD_MS = 23000;

/**
 * Radians of breathing phase between one ring and the next, so the swell travels
 * outwards through the nest instead of the whole map pulsing at once. Negative,
 * so it travels from the summit down.
 */
const BREATH_RING_PHASE = -0.42;

/**
 * How many times the relief a ring's radius has to be before it takes the relief
 * in full.
 *
 * Below that the relief is faded out proportionally. Without this the innermost
 * rings - which are smaller than the displacement - would be turned inside out
 * by it, and a summit would read as a knot. It is also true of real ground: the
 * top of a hill is rounder than its flanks.
 */
const RELIEF_REACH = 2.4;

/** How much more relief the outermost ring takes than the innermost. */
const RELIEF_SPREAD = 0.45;

// --- the nest --------------------------------------------------------------

/** Rings crowd towards the summit at an exponent above 1. */
const SPACING_EXPONENT = 1.45;

/** Alpha falls away from the summit at an exponent below 1, so the fade starts at once. */
const ALPHA_EXPONENT = 0.8;

/**
 * How many alphas the nest is drawn in.
 *
 * The batching knob, and the same one `starfield.ts` uses: every ring in a
 * bucket goes into one path and is stroked once, so the number of `stroke()`
 * calls per frame is this and not the number of rings. Five is enough that the
 * fade from summit to edge reads as a ramp rather than as bands.
 */
const ALPHA_BUCKETS = 5;

/** Buffer pixels. The buffer is upscaled with smoothing, so one is a soft hairline. */
const LINE_WIDTH = 1;

/** The size assumed until the first layout, so `create` always produces a complete picture. */
const DEFAULT_CSS_WIDTH = 1280;
const DEFAULT_CSS_HEIGHT = 720;

/** How far the composition must move before the ring tables are worth rebuilding. */
const REBUILD_EPSILON = 0.5;

/**
 * One role's composition. The two are genuinely different pictures rather than
 * one picture at two sizes - see the header - and the difference is entirely in
 * what a radius is measured in, which is what {@link computeContourComposition}
 * resolves.
 */
export interface IContourComposition {
	readonly rings: number;
	readonly vertices: number;
	/** Where the summit sits across the frame, as a fraction of the buffer's width. */
	readonly centreXRatio: number;
	/**
	 * Where the summit sits down the frame. Screen pixels below the top edge for
	 * `ground`, where the visible strip is a fixed screen size; a fraction of the
	 * buffer's height for `stage`, which has no strip and is whatever shape the
	 * editor group left it.
	 */
	readonly centreY: number;
	/** Radius of the innermost and the outermost ring, in this role's own units. */
	readonly innerRadius: number;
	readonly outerRadius: number;
	/** Total angular displacement of the nest, in this role's own units. */
	readonly relief: number;
	/** Ink alpha of the summit ring and of the outermost one. */
	readonly alphaNear: number;
	readonly alphaFar: number;
}

/**
 * The chrome strip: screen pixels throughout, and a centre a third of the way
 * down the default 35px title bar so the strip cuts the nest across its summit.
 * That slice carries the whole family of rings at once, which is the only slice
 * of a contour map that shows what kind of map it is.
 */
const GROUND_COMPOSITION: IContourComposition = Object.freeze({
	rings: 12,
	vertices: 96,
	centreXRatio: 0.26,
	centreY: 12,
	innerRadius: 22,
	outerRadius: 560,
	relief: 58,
	alphaNear: 0.78,
	alphaFar: 0.10
});

/**
 * A whole pane: fractions of the frame throughout, an outermost ring at 1.3 of
 * the half-frame so the pane crops the nest on every edge, and a summit set off
 * to the lower left of centre - away from the text column a Start pane puts at
 * its top left, and off the axes, so the composition has a diagonal in it.
 */
const STAGE_COMPOSITION: IContourComposition = Object.freeze({
	rings: 16,
	vertices: 128,
	centreXRatio: 0.34,
	centreY: 0.58,
	innerRadius: 0.05,
	outerRadius: 1.30,
	relief: 0.16,
	alphaNear: 0.85,
	alphaFar: 0.08
});

/**
 * One ring, resolved: how far out it is and how much of the shared relief it
 * takes.
 *
 * Pure and exported for the same reason the composition is. Whether two rings
 * can touch is decided entirely by these two numbers - a contour map whose lines
 * cross is not a contour map - and that is a question about arithmetic, so
 * `test/browser/motifComposition.test.ts` asks it here rather than by looking at
 * a picture.
 */
export interface IContourRing {
	readonly radius: number;
	readonly relief: number;
}

/**
 * The rings of one composition, summit outwards.
 *
 * The spacing crowds towards the summit; the relief share is faded out where a
 * ring is not several times the relief (which is what keeps the summit round
 * rather than knotted) and grows a little towards the edge.
 */
export function computeContourRings(composition: IContourComposition): readonly IContourRing[] {
	const rings: IContourRing[] = [];
	const span = composition.outerRadius - composition.innerRadius;
	const full = RELIEF_REACH * composition.relief;

	for (let ring = 0; ring < composition.rings; ring++) {
		const t = composition.rings > 1 ? ring / (composition.rings - 1) : 0;
		const radius = composition.innerRadius + span * Math.pow(t, SPACING_EXPONENT);

		rings.push({
			radius,
			relief: clampMotif(radius / Math.max(full, 1e-6), 0, 1) * (1 - RELIEF_SPREAD + RELIEF_SPREAD * t)
		});
	}

	return rings;
}

/**
 * Where the nest goes, and what one unit of radius is worth on each axis.
 *
 * Pure, exported and free of the renderer's state, for the same reason
 * `computeGlobePlacement` is: this is the arithmetic that decides whether the
 * product shows a landform or a smudge, and it is worth a test rather than a
 * screenshot.
 *
 * `scaleX` and `scaleY` are what a radius of 1 comes to in buffer pixels on each
 * axis. In `ground` they undo the stretch of the fixed 640x360 buffer onto the
 * window, so a ring is a circle ON SCREEN whatever shape the window is - the
 * same correction the globe makes, for the same reason. In `stage` they are the
 * buffer's own dimensions, so a ring follows the frame's aspect deliberately:
 * this role is composed TO the pane rather than dropped into it, and a landform
 * that stretched with the frame is a landform, where a globe that did would be
 * an ellipse.
 */
export interface IContourComposedNest {
	readonly composition: IContourComposition;
	readonly centreX: number;
	readonly centreY: number;
	readonly scaleX: number;
	readonly scaleY: number;
}

export function computeContourComposition(role: PrimalMotifRole, cssWidth: number, cssHeight: number, bufferWidth: number, bufferHeight: number): IContourComposedNest {
	if (role === 'stage') {
		return {
			composition: STAGE_COMPOSITION,
			centreX: STAGE_COMPOSITION.centreXRatio * bufferWidth,
			centreY: STAGE_COMPOSITION.centreY * bufferHeight,
			scaleX: bufferWidth,
			scaleY: bufferHeight
		};
	}

	return {
		composition: GROUND_COMPOSITION,
		centreX: GROUND_COMPOSITION.centreXRatio * bufferWidth,
		centreY: GROUND_COMPOSITION.centreY * bufferHeight / cssHeight,
		scaleX: bufferWidth / cssWidth,
		scaleY: bufferHeight / cssHeight
	};
}

// --- the renderer ----------------------------------------------------------

class ContoursMotifRenderer implements IMotifRenderer {

	readonly id = PRIMAL_MOTIF_CONTOURS_ID;
	readonly label = localize('primalCode.motif.contours.label', "Contours");
	readonly kind: PrimalMotifKind = 'canvas2d';

	private context: CanvasRenderingContext2D | undefined;
	private role: PrimalMotifRole = 'ground';
	private ink = '';

	private bufferWidth = 0;
	private bufferHeight = 0;
	private cssWidth = DEFAULT_CSS_WIDTH;
	private cssHeight = DEFAULT_CSS_HEIGHT;

	private nest: IContourComposedNest | undefined;

	/** `cos(theta) * scaleX` and `sin(theta) * scaleY` per vertex, so a frame does no trigonometry. */
	private unitX = new Float32Array(0);
	private unitY = new Float32Array(0);

	/** `weight * sin(wave * theta)` and its cosine, per harmonic, flattened per vertex. */
	private harmonicSin: readonly Float32Array[] = [];
	private harmonicCos: readonly Float32Array[] = [];

	/** Per ring: its radius, how much of the relief it takes, and which alpha bucket it is in. */
	private ringRadius = new Float32Array(0);
	private ringRelief = new Float32Array(0);
	private ringBucket = new Int32Array(0);

	/** One alpha per bucket, and the shared per-frame relief scratch. */
	private bucketAlpha = new Float32Array(0);
	private relief = new Float32Array(0);

	/**
	 * Eased milliseconds of motion, accumulated from `frame.delta` rather than
	 * read from `frame.time`.
	 *
	 * `frame.time` is the scheduler's burst clock and restarts on every trigger,
	 * so a nest driven by it would snap back to its unbreathed pose each time the
	 * window regained focus. The delta is already eased, so accumulating it makes
	 * this settle for free without the file knowing that settling exists.
	 */
	private elapsedMs = 0;

	create(host: IMotifHost): boolean {
		const context = acquireMotifContext(host);
		if (!context) {
			return false;
		}

		const ink = readMotifInk(host.palette);
		if (!ink) {
			// No `foreground` and no `descriptionForeground`. A refusal rather
			// than a substitute: see `motifPaint.ts` for why the accent is not
			// offered here, and `primalMotifLadder.ts` for what a refusal costs.
			return false;
		}

		this.context = context;
		this.role = host.role;
		this.ink = ink.toString();
		this.bufferWidth = host.bufferWidth;
		this.bufferHeight = host.bufferHeight;
		this.rebuild();

		return true;
	}

	/**
	 * The nest is anchored in screen pixels in the `ground` role, so a layout is
	 * a change of BUFFER geometry: the fixed 640x360 buffer is stretched to a new
	 * shape and the tables carry the correction that keeps a ring circular. The
	 * `stage` role is composed to the frame and its tables do not move at all,
	 * which the epsilon test below discovers for itself rather than being told.
	 */
	resize(width: number, height: number): void {
		if (!(width > 0) || !(height > 0) || !this.context) {
			return;
		}

		this.cssWidth = width;
		this.cssHeight = height;

		const nest = this.nest;
		const next = computeContourComposition(this.role, width, height, this.bufferWidth, this.bufferHeight);
		if (nest
			&& Math.abs(next.centreY - nest.centreY) < REBUILD_EPSILON
			&& Math.abs(next.scaleX * next.composition.outerRadius - nest.scaleX * nest.composition.outerRadius) < REBUILD_EPSILON
			&& Math.abs(next.scaleY * next.composition.outerRadius - nest.scaleY * nest.composition.outerRadius) < REBUILD_EPSILON) {
			return;
		}

		this.rebuild();
	}

	render(frame: IMotifFrame): void {
		const context = this.context;
		const nest = this.nest;
		if (!context || !nest) {
			return;
		}

		// `delta`, not `time`: see {@link elapsedMs}.
		this.elapsedMs += frame.delta;

		const composition = nest.composition;
		const vertices = composition.vertices;

		this.composeRelief(vertices);

		context.clearRect(0, 0, this.bufferWidth, this.bufferHeight);
		context.strokeStyle = this.ink;
		context.lineWidth = LINE_WIDTH;

		const breathPhase = this.elapsedMs * (Math.PI * 2) / BREATH_PERIOD_MS;

		for (let bucket = 0; bucket < ALPHA_BUCKETS; bucket++) {
			context.globalAlpha = this.bucketAlpha[bucket];
			context.beginPath();

			let drawn = false;
			for (let ring = 0; ring < composition.rings; ring++) {
				if (this.ringBucket[ring] !== bucket) {
					continue;
				}

				this.traceRing(context, nest, ring, vertices, breathPhase);
				drawn = true;
			}

			if (drawn) {
				context.stroke();
			}
		}

		context.globalAlpha = 1;
	}

	dispose(): void {
		// The element and its backing store belong to the surface. What belongs
		// here is a few kilobytes of tables and the context reference.
		this.context = undefined;
		this.nest = undefined;
		this.unitX = new Float32Array(0);
		this.unitY = new Float32Array(0);
		this.harmonicSin = [];
		this.harmonicCos = [];
		this.ringRadius = new Float32Array(0);
		this.ringRelief = new Float32Array(0);
		this.ringBucket = new Int32Array(0);
		this.bucketAlpha = new Float32Array(0);
		this.relief = new Float32Array(0);
	}

	// --- tables -------------------------------------------------------------

	/**
	 * Everything that does not change between frames: the angle tables, the
	 * harmonic tables and the rings.
	 *
	 * Runs at `create` and on a resize that actually moved the nest, and never
	 * from a frame. It is a few thousand transcendentals, which is why it is
	 * here and not there.
	 */
	private rebuild(): void {
		const nest = computeContourComposition(this.role, this.cssWidth, this.cssHeight, this.bufferWidth, this.bufferHeight);
		const composition = nest.composition;
		const vertices = composition.vertices;

		this.nest = nest;
		this.unitX = new Float32Array(vertices);
		this.unitY = new Float32Array(vertices);
		this.relief = new Float32Array(vertices);

		const harmonicSin: Float32Array[] = [];
		const harmonicCos: Float32Array[] = [];
		for (let index = 0; index < HARMONICS.length; index++) {
			harmonicSin.push(new Float32Array(vertices));
			harmonicCos.push(new Float32Array(vertices));
		}

		for (let vertex = 0; vertex < vertices; vertex++) {
			const theta = vertex / vertices * Math.PI * 2;
			this.unitX[vertex] = Math.cos(theta) * nest.scaleX;
			this.unitY[vertex] = Math.sin(theta) * nest.scaleY;

			for (let index = 0; index < HARMONICS.length; index++) {
				const harmonic = HARMONICS[index];
				const amplitude = harmonic.weight * composition.relief;
				harmonicSin[index][vertex] = amplitude * Math.sin(harmonic.wave * theta);
				harmonicCos[index][vertex] = amplitude * Math.cos(harmonic.wave * theta);
			}
		}

		this.harmonicSin = harmonicSin;
		this.harmonicCos = harmonicCos;
		this.buildRings(composition);
	}

	/** The rings, flattened into the typed arrays a frame reads, plus the bucket alphas. */
	private buildRings(composition: IContourComposition): void {
		const count = composition.rings;
		const rings = computeContourRings(composition);

		this.ringRadius = new Float32Array(count);
		this.ringRelief = new Float32Array(count);
		this.ringBucket = new Int32Array(count);
		this.bucketAlpha = new Float32Array(ALPHA_BUCKETS);

		for (let ring = 0; ring < count; ring++) {
			const t = count > 1 ? ring / (count - 1) : 0;

			this.ringRadius[ring] = rings[ring].radius;
			this.ringRelief[ring] = rings[ring].relief;
			this.ringBucket[ring] = clampMotif(Math.floor(t * ALPHA_BUCKETS), 0, ALPHA_BUCKETS - 1);
		}

		for (let bucket = 0; bucket < ALPHA_BUCKETS; bucket++) {
			// The bucket's centre, not its edge, so the summit is not blown out
			// and the outermost ring is still lit.
			const t = (bucket + 0.5) / ALPHA_BUCKETS;
			this.bucketAlpha[bucket] = composition.alphaNear + (composition.alphaFar - composition.alphaNear) * Math.pow(t, ALPHA_EXPONENT);
		}
	}

	// --- the frame ----------------------------------------------------------

	/**
	 * The shared displacement, once for the whole nest.
	 *
	 * Six transcendentals in total - two per harmonic, for the time term alone -
	 * because `sin(h*theta + phase)` was expanded at `create` into the two angle
	 * tables this multiplies. Everything else is a multiply and an add.
	 */
	private composeRelief(vertices: number): void {
		const relief = this.relief;
		relief.fill(0);

		for (let index = 0; index < HARMONICS.length; index++) {
			const phase = this.elapsedMs * (Math.PI * 2) / HARMONICS[index].periodMs;
			const cosPhase = Math.cos(phase);
			const sinPhase = Math.sin(phase);
			const sinTable = this.harmonicSin[index];
			const cosTable = this.harmonicCos[index];

			for (let vertex = 0; vertex < vertices; vertex++) {
				relief[vertex] += sinTable[vertex] * cosPhase + cosTable[vertex] * sinPhase;
			}
		}
	}

	/** One closed ring, appended to whatever path the caller has open. */
	private traceRing(context: CanvasRenderingContext2D, nest: IContourComposedNest, ring: number, vertices: number, breathPhase: number): void {
		const base = this.ringRadius[ring] * (1 + BREATH_AMPLITUDE * Math.sin(breathPhase + ring * BREATH_RING_PHASE));
		const share = this.ringRelief[ring];
		const centreX = nest.centreX;
		const centreY = nest.centreY;
		const relief = this.relief;
		const unitX = this.unitX;
		const unitY = this.unitY;

		for (let vertex = 0; vertex < vertices; vertex++) {
			const radius = base + relief[vertex] * share;
			const x = centreX + radius * unitX[vertex];
			const y = centreY + radius * unitY[vertex];

			if (vertex === 0) {
				context.moveTo(x, y);
			} else {
				context.lineTo(x, y);
			}
		}

		context.closePath();
	}
}

// --- registration ----------------------------------------------------------

registerMotif({
	id: PRIMAL_MOTIF_CONTOURS_ID,
	label: localize('primalCode.motif.contours', "Contours"),
	description: localize('primalCode.motif.contours.description', "A topographic field of nested contour lines that swell and subside, drawn in the active theme's own ink at one alpha per elevation. Line work only, and no second colour. Under the default 'settle' motion it breathes for about {0} seconds after a trigger and then rests.", PRIMAL_MOTIF_BURST_SECONDS),
	kind: 'canvas2d',
	// A swell with no event in it and no phase to wait for is the kind of motion
	// that is tolerable indefinitely. It is still an opt-in, and the status bar
	// still offers the pause.
	allowsPerpetual: true,
	frameCostMs: CONTOURS_FRAME_COST_MS,
	create: () => new ContoursMotifRenderer()
});
