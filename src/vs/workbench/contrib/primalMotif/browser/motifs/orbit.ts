/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IMotifFrame, IMotifHost, IMotifRenderer, PRIMAL_MOTIF_BURST_SECONDS, PrimalMotifKind, PrimalMotifRole, registerMotif } from '../primalMotif.js';
import { acquireMotifContext, clampMotif, readMotifInk, wrapMotif } from './motifPaint.js';

/**
 * Primal Code - the `orbit` motif: an orrery.
 *
 * WHAT IS STRUCTURALLY DIFFERENT ABOUT IT. Every other motif in this folder
 * animates a FIELD - stars, contour lines, a grid, a rotating texture - where
 * every element does the same thing as its neighbours and no single one is worth
 * following. This one animates BODIES: a handful of discrete objects on fixed
 * paths, each at its own period, and the eye can pick one and watch it. That is
 * the whole reason it earns a place next to the others. It is also the only
 * motif here whose resting frame is unambiguously mid-motion - the bodies are
 * somewhere on their rings rather than at a home position - which is what makes
 * a still frame of it read as a mechanism rather than as a diagram.
 *
 * THE PERIODS ARE KEPLER'S, and that is not decoration. `period = base *
 * radius^1.5` is what stops the rings from reading as one wheel: the innermost
 * body completes a turn in nine seconds and the outermost takes three minutes,
 * so at every instant the ring spacing and the angular spacing disagree, and the
 * picture never returns to a pose the eye has just seen. Equal periods would
 * have been a rotating rosette, which is a pattern rather than a system.
 *
 * WHAT COSTS WHAT. Six ellipse strokes for the rings, one stroke for every
 * trail in one path, two fills for the bodies in two brightness buckets, and two
 * ops for the primary: about a dozen path operations for the whole frame, and
 * nothing allocated in it. There is no per-pixel work anywhere in this file.
 *
 * MEASURED COST, on the shipped code, as the median of 400 frames in the
 * workbench's own Electron renderer (`test/browser/motifBudget.test.ts` is the
 * harness, and it asserts the number below against a fresh measurement):
 *
 *     stage   6 rings, 7 bodies, 1428x1025 pane     0.0067ms   1.3% of the 0.5ms budget
 *     ground  5 rings, 6 bodies, 1920x1080 window   0.0060ms   1.2%
 *
 * It is the cheapest motif in this folder but one, which is about what a dozen
 * path operations against a quarter of a million pixels ought to cost.
 *
 * A CIRCLE HAS TO BE A CIRCLE, IN BOTH ROLES. This is the one motif here that is
 * an OBJECT rather than a field, so - like `globe.ts` and unlike `contours.ts` or
 * `horizon.ts` - it refuses to be stretched: every radius is chosen in screen
 * pixels and then divided by the stretch on each axis, so
 * `radiusX / bufferWidth * cssWidth === radiusY / bufferHeight * cssHeight`
 * holds whatever shape the host is. A field may follow the frame; a mechanism
 * drawn as an ellipse is just a broken mechanism.
 *
 * BOTH ROLES, AND THEY ARE DIFFERENT SYSTEMS. `ground` is the ~35px chrome
 * strip: the system is a fixed screen size with its primary a third of the way
 * down the title bar, so the strip cuts it across the centre and shows the whole
 * family of rings at once and the bodies crossing them. `stage` is a code-free
 * pane, so the system is sized from the pane's shorter side, carries a sixth
 * ring that the pane crops on purpose, and sits left of centre where a Start
 * page's text column is not. See {@link computeOrbitSystem}.
 *
 * ONE INK. Rings, trails, bodies and the primary are all `foreground` at their
 * own alpha, and there is no second token in this file. What separates a body
 * from its ring is that it is brighter and solid; what separates an inner ring
 * from an outer one is that it is brighter. A palette that cannot supply that
 * ink is declined rather than substituted for - see `motifPaint.ts`.
 */

// --- identity --------------------------------------------------------------

/** The `primalCode.motif.id` value. */
export const PRIMAL_MOTIF_ORBIT_ID = 'orbit';

/**
 * The measured median cost of one `render()`, in milliseconds. See the header
 * for the table it comes from, and `IMotifDescriptor.frameCostMs` for what the
 * number is for.
 */
export const ORBIT_FRAME_COST_MS = 0.0067;

// --- the system ------------------------------------------------------------

/** One body on a ring. Sizes are fractions of the system's reach, like the radii. */
interface IOrbitBodySpec {
	/** Where it starts, in radians. Chosen so no two bodies are in conjunction at rest. */
	readonly anomaly: number;
	readonly size: number;
	readonly alpha: number;
}

/** One ring, and whatever is on it. */
interface IOrbitRingSpec {
	/** Radius as a fraction of the system's reach; 1 is the reach itself. */
	readonly radius: number;
	/** Ink alpha of the ring line. */
	readonly alpha: number;
	readonly bodies: readonly IOrbitBodySpec[];
}

/**
 * The chrome strip's system: five rings, six bodies, and everything measured in
 * screen pixels because the strip is a fixed screen size and a system that grew
 * with the window would only get flatter inside it.
 */
const GROUND_RINGS: readonly IOrbitRingSpec[] = Object.freeze([
	{ radius: 0.21, alpha: 0.30, bodies: [{ anomaly: 0.7, size: 0.014, alpha: 0.95 }] },
	{ radius: 0.35, alpha: 0.26, bodies: [{ anomaly: 2.6, size: 0.011, alpha: 0.88 }] },
	{ radius: 0.52, alpha: 0.22, bodies: [{ anomaly: 4.9, size: 0.017, alpha: 1.00 }, { anomaly: 1.3, size: 0.009, alpha: 0.72 }] },
	{ radius: 0.72, alpha: 0.18, bodies: [{ anomaly: 3.4, size: 0.012, alpha: 0.86 }] },
	{ radius: 1.00, alpha: 0.14, bodies: [{ anomaly: 5.7, size: 0.015, alpha: 0.92 }] }
] as const);

/**
 * A whole pane's system: the same five rings plus a sixth at 1.55 of the reach,
 * which is past the pane's shorter side and is therefore cropped - that crop is
 * what gives the composition a scale, and it is the reason this is not the
 * ground's system at a larger size.
 */
const STAGE_RINGS: readonly IOrbitRingSpec[] = Object.freeze([
	{ radius: 0.21, alpha: 0.34, bodies: [{ anomaly: 0.7, size: 0.013, alpha: 0.95 }] },
	{ radius: 0.35, alpha: 0.30, bodies: [{ anomaly: 2.6, size: 0.010, alpha: 0.88 }] },
	{ radius: 0.52, alpha: 0.26, bodies: [{ anomaly: 4.9, size: 0.016, alpha: 1.00 }, { anomaly: 1.3, size: 0.008, alpha: 0.72 }] },
	{ radius: 0.72, alpha: 0.21, bodies: [{ anomaly: 3.4, size: 0.011, alpha: 0.86 }] },
	{ radius: 1.00, alpha: 0.16, bodies: [{ anomaly: 5.7, size: 0.014, alpha: 0.92 }] },
	{ radius: 1.55, alpha: 0.11, bodies: [{ anomaly: 2.1, size: 0.018, alpha: 0.80 }] }
] as const);

/**
 * How long a body at the reach takes to come round.
 *
 * Everything else follows from Kepler: the innermost ring is at 0.21 of the
 * reach and therefore takes `0.21^1.5` of this, about nine seconds, which is
 * long enough to be a drift rather than a spin and short enough that a single
 * settle burst shows a body move most of the way across the frame. The
 * outermost takes three minutes, which is the same order as the globe's turn.
 */
const REACH_PERIOD_MS = 96000;

/** Kepler's third law. Not a tunable. */
const KEPLER_EXPONENT = 1.5;

/** The primary, as fractions of the reach: the disc, and the corona ring outside it. */
const PRIMARY_RADIUS = 0.038;
const PRIMARY_ALPHA = 0.92;
const CORONA_RADIUS = 0.072;
const CORONA_ALPHA = 0.24;

/**
 * How far behind a body its trail reaches, in radians, and how brightly.
 *
 * The trail is what makes a STILL frame say which way the system is turning, so
 * it is not decoration: under `settle` the resting frame is what most users look
 * at most of the time, and a resting orrery with no trails is a diagram.
 * Radians rather than a distance, so an inner body - which is faster - also
 * sweeps its trail faster, which is the correct reading.
 */
const TRAIL_RADIANS = 0.55;
const TRAIL_ALPHA = 0.44;

/** Buffer pixels. The trail is heavier than the ring it sits on, so weight separates them too. */
const RING_LINE_WIDTH = 1;
const TRAIL_LINE_WIDTH = 1.6;

/**
 * Brightness buckets for the bodies, so the whole set is two fills rather than
 * eight, and the floor those buckets start from.
 *
 * Bucketing across the whole 0..1 alpha range would have put every body in one
 * bucket and thrown its brightness away, because a body is never dim: the range
 * that has to be resolved is the top third, and that is what the floor states.
 */
const BODY_BUCKETS = 2;
const BODY_ALPHA_FLOOR = 0.70;

/** The ground role: the system's reach and its centre, in screen pixels. */
const GROUND_REACH_PIXELS = 232;
const GROUND_CENTRE_X_RATIO = 0.68;
const GROUND_CENTRE_Y_PIXELS = 12;

/** The stage role: the reach as a fraction of the pane's SHORTER side, and its clamp. */
const STAGE_REACH_RATIO = 0.70;
const STAGE_REACH_MIN_PIXELS = 260;
const STAGE_REACH_MAX_PIXELS = 780;
const STAGE_CENTRE_X_RATIO = 0.42;
const STAGE_CENTRE_Y_RATIO = 0.50;

/** The size assumed until the first layout, so `create` always produces a complete picture. */
const DEFAULT_CSS_WIDTH = 1280;
const DEFAULT_CSS_HEIGHT = 720;

const TAU = Math.PI * 2;

/**
 * Where the system goes, in buffer coordinates, for one role and one host size.
 *
 * Pure, exported and free of the renderer's state, exactly like
 * `computeGlobePlacement`: this is the arithmetic that decides whether the
 * product shows an orrery or a smudge, and the circularity invariant it carries
 * is the kind of thing a test can hold and a screenshot cannot.
 *
 * `reachX` and `reachY` are the same screen distance divided by the stretch on
 * each axis, which is what keeps a ring circular on screen while the fixed
 * 640x360 buffer is pulled to whatever shape the host is.
 */
export interface IOrbitSystem {
	readonly rings: readonly IOrbitRingSpec[];
	readonly centreX: number;
	readonly centreY: number;
	readonly reachX: number;
	readonly reachY: number;
}

export function computeOrbitSystem(role: PrimalMotifRole, cssWidth: number, cssHeight: number, bufferWidth: number, bufferHeight: number): IOrbitSystem {
	if (role === 'stage') {
		const reach = clampMotif(STAGE_REACH_RATIO * Math.min(cssWidth, cssHeight), STAGE_REACH_MIN_PIXELS, STAGE_REACH_MAX_PIXELS);

		return {
			rings: STAGE_RINGS,
			centreX: STAGE_CENTRE_X_RATIO * bufferWidth,
			centreY: STAGE_CENTRE_Y_RATIO * bufferHeight,
			reachX: reach * bufferWidth / cssWidth,
			reachY: reach * bufferHeight / cssHeight
		};
	}

	return {
		rings: GROUND_RINGS,
		centreX: GROUND_CENTRE_X_RATIO * bufferWidth,
		// Screen pixels, not a ratio: the strip this has to land in is a fixed
		// screen size whatever the window does.
		centreY: GROUND_CENTRE_Y_PIXELS * bufferHeight / cssHeight,
		reachX: GROUND_REACH_PIXELS * bufferWidth / cssWidth,
		reachY: GROUND_REACH_PIXELS * bufferHeight / cssHeight
	};
}

/** How long one ring takes to come round, from its radius. Kepler, and nothing else. */
export function orbitPeriodMs(radius: number): number {
	return REACH_PERIOD_MS * Math.pow(radius, KEPLER_EXPONENT);
}

// --- the renderer ----------------------------------------------------------

class OrbitMotifRenderer implements IMotifRenderer {

	readonly id = PRIMAL_MOTIF_ORBIT_ID;
	readonly label = localize('primalCode.motif.orbit.label', "Orbit");
	readonly kind: PrimalMotifKind = 'canvas2d';

	private context: CanvasRenderingContext2D | undefined;
	private role: PrimalMotifRole = 'ground';
	private ink = '';

	private bufferWidth = 0;
	private bufferHeight = 0;
	private cssWidth = DEFAULT_CSS_WIDTH;
	private cssHeight = DEFAULT_CSS_HEIGHT;

	private system: IOrbitSystem | undefined;

	/**
	 * Eased milliseconds of motion, accumulated from `frame.delta` rather than
	 * read from `frame.time`, which is the scheduler's burst clock and restarts
	 * on every trigger. A system driven by that clock would snap every body back
	 * to its starting anomaly each time the window regained focus. The delta is
	 * already eased, so this settles for free.
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
		this.system = computeOrbitSystem(this.role, this.cssWidth, this.cssHeight, this.bufferWidth, this.bufferHeight);

		return true;
	}

	/**
	 * The system is a fixed screen size, so a layout is a change of BUFFER
	 * geometry: the fixed 640x360 buffer is stretched to a new shape, and the
	 * reach carries the correction that keeps a ring circular on screen.
	 *
	 * There are no tables here to rebuild - the whole system is five numbers -
	 * so this recomputes unconditionally rather than testing an epsilon.
	 */
	resize(width: number, height: number): void {
		if (!(width > 0) || !(height > 0) || !this.context) {
			return;
		}

		this.cssWidth = width;
		this.cssHeight = height;
		this.system = computeOrbitSystem(this.role, width, height, this.bufferWidth, this.bufferHeight);
	}

	render(frame: IMotifFrame): void {
		const context = this.context;
		const system = this.system;
		if (!context || !system) {
			return;
		}

		// `delta`, not `time`: see {@link elapsedMs}.
		this.elapsedMs += frame.delta;

		context.clearRect(0, 0, this.bufferWidth, this.bufferHeight);
		context.strokeStyle = this.ink;
		context.fillStyle = this.ink;

		this.paintRings(context, system);
		this.paintTrails(context, system);
		this.paintBodies(context, system);
		this.paintPrimary(context, system);

		context.globalAlpha = 1;
	}

	dispose(): void {
		// Nothing is held but the context reference and six numbers.
		this.context = undefined;
		this.system = undefined;
	}

	// --- the frame ----------------------------------------------------------

	/** Where a body is now, as an angle. The only place the clock is read. */
	private anomalyOf(radius: number, body: IOrbitBodySpec): number {
		return wrapMotif(body.anomaly + TAU * this.elapsedMs / orbitPeriodMs(radius), TAU);
	}

	/** The rings: one stroke each, because each carries its own alpha and there are six of them. */
	private paintRings(context: CanvasRenderingContext2D, system: IOrbitSystem): void {
		context.lineWidth = RING_LINE_WIDTH;

		for (const ring of system.rings) {
			context.globalAlpha = ring.alpha;
			context.beginPath();
			context.ellipse(system.centreX, system.centreY, ring.radius * system.reachX, ring.radius * system.reachY, 0, 0, TAU);
			context.stroke();
		}
	}

	/** Every trail in one path: they share an alpha and a weight, so they share a stroke. */
	private paintTrails(context: CanvasRenderingContext2D, system: IOrbitSystem): void {
		context.globalAlpha = TRAIL_ALPHA;
		context.lineWidth = TRAIL_LINE_WIDTH;
		context.beginPath();

		for (const ring of system.rings) {
			const radiusX = ring.radius * system.reachX;
			const radiusY = ring.radius * system.reachY;

			for (const body of ring.bodies) {
				const anomaly = this.anomalyOf(ring.radius, body);
				// `moveTo` first: an arc appended to an open subpath is joined to
				// it by a straight line, which would draw a chord across the
				// system from wherever the previous trail ended.
				context.moveTo(system.centreX + radiusX * Math.cos(anomaly - TRAIL_RADIANS), system.centreY + radiusY * Math.sin(anomaly - TRAIL_RADIANS));
				context.ellipse(system.centreX, system.centreY, radiusX, radiusY, 0, anomaly - TRAIL_RADIANS, anomaly);
			}
		}

		context.stroke();
	}

	/** Which brightness bucket a body falls in. Clamped, so no body can be missed. */
	private bucketOf(alpha: number): number {
		const share = (alpha - BODY_ALPHA_FLOOR) / (1 - BODY_ALPHA_FLOOR);
		return clampMotif(Math.floor(share * BODY_BUCKETS), 0, BODY_BUCKETS - 1);
	}

	/** The bodies, batched into two brightness buckets: two fills for the whole set. */
	private paintBodies(context: CanvasRenderingContext2D, system: IOrbitSystem): void {
		for (let bucket = 0; bucket < BODY_BUCKETS; bucket++) {
			let drawn = false;

			context.beginPath();
			// The bucket's centre within the body range, so the dimmer half is
			// still lit and the brighter half is not blown out.
			context.globalAlpha = BODY_ALPHA_FLOOR + (1 - BODY_ALPHA_FLOOR) * ((bucket + 0.5) / BODY_BUCKETS);

			for (const ring of system.rings) {
				const radiusX = ring.radius * system.reachX;
				const radiusY = ring.radius * system.reachY;

				for (const body of ring.bodies) {
					if (this.bucketOf(body.alpha) !== bucket) {
						continue;
					}

					const anomaly = this.anomalyOf(ring.radius, body);
					context.moveTo(system.centreX + radiusX * Math.cos(anomaly) + body.size * system.reachX, system.centreY + radiusY * Math.sin(anomaly));
					context.ellipse(
						system.centreX + radiusX * Math.cos(anomaly),
						system.centreY + radiusY * Math.sin(anomaly),
						body.size * system.reachX,
						body.size * system.reachY,
						0, 0, TAU
					);
					drawn = true;
				}
			}

			if (drawn) {
				context.fill();
			}
		}
	}

	/** The primary: a solid disc, and a corona ring that is the same ink much weaker. */
	private paintPrimary(context: CanvasRenderingContext2D, system: IOrbitSystem): void {
		context.globalAlpha = PRIMARY_ALPHA;
		context.beginPath();
		context.ellipse(system.centreX, system.centreY, PRIMARY_RADIUS * system.reachX, PRIMARY_RADIUS * system.reachY, 0, 0, TAU);
		context.fill();

		context.globalAlpha = CORONA_ALPHA;
		context.lineWidth = RING_LINE_WIDTH;
		context.beginPath();
		context.ellipse(system.centreX, system.centreY, CORONA_RADIUS * system.reachX, CORONA_RADIUS * system.reachY, 0, 0, TAU);
		context.stroke();
	}
}

// --- registration ----------------------------------------------------------

registerMotif({
	id: PRIMAL_MOTIF_ORBIT_ID,
	label: localize('primalCode.motif.orbit', "Orbit"),
	description: localize('primalCode.motif.orbit.description', "Concentric rings with bodies on them, each taking longer to come round the further out it is, drawn in the active theme's own ink at one alpha per ring. No second colour. Under the default 'settle' motion it turns for about {0} seconds after a trigger and then rests.", PRIMAL_MOTIF_BURST_SECONDS),
	kind: 'canvas2d',
	// NOT offered for perpetual motion, and this is the one motif here that
	// declines it. `starfield.ts` states the test it has to pass: a drift with no
	// event in it and no phase to notice is what is tolerable indefinitely. An
	// orrery is the opposite by construction - it has bodies to follow, moments
	// of conjunction to wait for, and a fastest period of nine seconds - so it
	// settles whatever the setting says, and the user keeps the setting.
	allowsPerpetual: false,
	frameCostMs: ORBIT_FRAME_COST_MS,
	create: () => new OrbitMotifRenderer()
});
