/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IMotifFrame, IMotifHost, IMotifRenderer, PRIMAL_MOTIF_BURST_SECONDS, PrimalMotifKind, PrimalMotifRole, registerMotif } from '../primalMotif.js';
import { acquireMotifContext, clampMotif, readMotifInk, wrapMotif } from './motifPaint.js';

/**
 * Primal Code - the `horizon` motif: a wireframe ground plane running under the
 * viewer towards a vanishing point.
 *
 * WHAT IS STRUCTURALLY DIFFERENT ABOUT IT. It is the only motif here with a
 * CAMERA in it. `galaxy` and `contours` move things about inside a flat picture;
 * `world` and `orbit` turn objects in front of a fixed one. This one holds the
 * scene still and moves the viewer through it, and everything else follows from
 * that single fact: the lines are evenly spaced in the world and unevenly spaced
 * on screen, they accelerate as they approach because perspective says they
 * must, and the whole frame is organised by one point that never moves. No other
 * motif here has a direction of travel.
 *
 * THE PROJECTION, IN ONE LINE. A ground plane under a camera projects so that a
 * line at world depth `z` lands at `y = vanishing + k/z`, and a world line
 * running away from the viewer at lateral offset `m` lands on the straight ray
 * `x = vanishing + m*k'/z`. So the entire picture is `1/z`, and `1/z` is the
 * only quantity computed per line:
 *
 *     depth line j:  u = 1 / (j + frac),  y = vy + reach*u
 *     ray m:         x = vx + m*spread*u,  for the same u
 *
 * The rays are therefore STATIC - a straight line through the vanishing point is
 * the same straight line at every depth - and only the eighteen `u` values move.
 * That makes a frame about twenty multiplies plus ten `stroke()` calls, with no
 * per-pixel work and nothing allocated.
 *
 * THE TREADMILL IS SEAMLESS BY CONSTRUCTION. `frac` runs from 1 down to 0 and
 * wraps. Over one cycle the set of positions goes from `{1/2, 1/3, ... 1/(N+1)}`
 * to `{1/1, 1/2, ... 1/N}`, which is the same set with one line added at the far
 * end and one removed at the near end. The near one has already left the bottom
 * of the frame (that is what {@link NEAR_OVERSHOOT} is for) and the far one
 * arrives at an alpha of about two percent, so neither event is visible and the
 * flow has no repeat in it that the eye can find.
 *
 * MEASURED COST, on the shipped code, as the median of 400 frames in the
 * workbench's own Electron renderer (`test/browser/motifBudget.test.ts` is the
 * harness, and it asserts the number below against a fresh measurement):
 *
 *     ground  18 depth lines, 15 rays, 1920x1080 window   0.0060ms   1.2% of the 0.5ms budget
 *     stage   18 depth lines, 15 rays, 1428x1025 pane     0.0047ms   0.9%
 *
 * The GROUND role is the dearer of the two here, which is the opposite of every
 * other motif in this folder and is worth knowing why: its vanishing point is
 * ten screen pixels down rather than two fifths of the way, so nearly the whole
 * plane is inside the frame and nearly every line it carries is actually
 * rasterised. Either way it is the cheapest motif in the folder.
 *
 * BOTH ROLES, AND THE CAMERA IS WHAT MOVES BETWEEN THEM. `ground` puts the
 * vanishing point INSIDE the ~35px title strip, ten screen pixels down, which is
 * the one placement that gives both visible strips something to hold: the title
 * strip gets the horizon itself and the dense far lines converging on it, and the
 * status strip - which is the near field, most of a window away - gets the fast
 * ones. It is a screen-pixel offset for the same reason `globe.ts` uses one: the
 * strip is a fixed screen size. `stage` raises the vanishing point to two fifths
 * down a whole pane and widens the field of view, so the upper part of the frame
 * is empty sky where a Start page's text column sits, and the grid holds the
 * lower three fifths. See {@link computeHorizonCamera}.
 *
 * IT IS A FIELD, SO IT MAY STRETCH. Unlike `world` and `orbit`, nothing here is
 * an object with a shape to preserve, and a wider window is honestly a wider
 * field of view: the composition is expressed in fractions of the frame and the
 * fixed 640x360 buffer is allowed to carry it to whatever shape the host is.
 *
 * ONE INK. Horizon, depth lines and rays are all `foreground` at their own
 * alpha, and distance is carried by that alpha alone - which is the correct
 * reading of distance anyway, and the only one that is identical for a colour
 * blind user. A palette that cannot supply that ink is declined rather than
 * substituted for; see `motifPaint.ts`.
 */

// --- identity --------------------------------------------------------------

/** The `primalCode.motif.id` value. */
export const PRIMAL_MOTIF_HORIZON_ID = 'horizon';

/**
 * The measured median cost of one `render()`, in milliseconds. See the header
 * for the table it comes from, and `IMotifDescriptor.frameCostMs` for what the
 * number is for.
 */
export const HORIZON_FRAME_COST_MS = 0.0060;

// --- the plane -------------------------------------------------------------

/**
 * How many lines of the ground plane are carried at once.
 *
 * Eighteen is where the far end stops resolving: beyond it the lines are closer
 * together than the buffer can separate and all that is added is a smudge under
 * the horizon, which the alpha ramp is already providing.
 */
const DEPTH_LINES = 18;

/**
 * How far past the bottom of the frame the nearest line runs before the treadmill
 * takes it back.
 *
 * A line has to LEAVE the frame before it is recycled, or the recycle is a pop.
 * See the header for why the wrap is otherwise seamless.
 */
const NEAR_OVERSHOOT = 1.35;

/** Milliseconds for the plane to advance by one line spacing. */
const SCROLL_PERIOD_MS = 6500;

/** Rays either side of the centre one, so `2 * this + 1` in total. */
const RAY_SPREAD_COUNT = 7;

/**
 * Where a ray is cut into segments, as fractions of the reach, so that a ray can
 * fade with distance without a gradient.
 *
 * A canvas gradient per ray would be fifteen objects to build and fifteen
 * strokes to make; three segments per ray, batched by which segment they are,
 * is three strokes for the whole fan and is indistinguishable at this scale.
 */
const RAY_STOPS: readonly number[] = Object.freeze([0.0, 0.22, 0.55, 1.0] as const);

/**
 * Ink alpha of each ray segment, FAR TO NEAR: segment 0 is the one touching the
 * vanishing point. One shorter than the stops, because it is the gaps between
 * them that are painted.
 */
const RAY_ALPHAS: readonly number[] = Object.freeze([0.05, 0.17, 0.34] as const);

/** Ink alpha of the nearest depth line and of the horizon line itself. */
const DEPTH_ALPHA_NEAR = 0.72;
const HORIZON_ALPHA = 0.34;

/**
 * How sharply a depth line fades with distance.
 *
 * Above 1, so the fade begins immediately and the far half of the plane is
 * nearly gone. That is what makes the picture read as depth rather than as a
 * pattern of horizontal rules, and it is also what lets a line arrive at the
 * horizon without anybody seeing it arrive.
 */
const DEPTH_ALPHA_GAMMA = 1.15;

/**
 * Alpha buckets for the depth lines: every line in a bucket is one path and one
 * `stroke()`, so a frame is six strokes rather than eighteen. The same batching
 * knob `starfield.ts` and `contours.ts` use.
 */
const DEPTH_BUCKETS = 6;

/** Buffer pixels. The horizon carries more weight than the plane, so it reads as the edge. */
const PLANE_LINE_WIDTH = 1;
const HORIZON_LINE_WIDTH = 1.4;

/** The ground role: the vanishing point, in screen pixels below the top edge. */
const GROUND_VANISHING_Y_PIXELS = 10;
const GROUND_SPREAD_RATIO = 0.62;

/** The stage role: the vanishing point as a fraction of the pane, and a wider field of view. */
const STAGE_VANISHING_Y_RATIO = 0.40;
const STAGE_SPREAD_RATIO = 0.82;

/** Both roles put the vanishing point on the frame's centre line. */
const VANISHING_X_RATIO = 0.5;

/** The size assumed until the first layout, so `create` always produces a complete picture. */
const DEFAULT_CSS_WIDTH = 1280;
const DEFAULT_CSS_HEIGHT = 720;

/** How far the vanishing point must move before the camera is worth recomputing. */
const REBUILD_EPSILON = 0.5;

/**
 * The camera: everything about the projection that does not change per frame.
 *
 * Pure, exported and free of the renderer's state, exactly like
 * `computeGlobePlacement` and `computeOrbitSystem`. `reach` is what `1/z = 1`
 * comes to in buffer pixels down the frame, and `spread` is what one lateral
 * step comes to across it at that same depth: between them they are the focal
 * length, and they are the whole difference between the two roles.
 */
export interface IHorizonCamera {
	readonly vanishingX: number;
	readonly vanishingY: number;
	readonly reach: number;
	readonly spread: number;
}

export function computeHorizonCamera(role: PrimalMotifRole, cssWidth: number, cssHeight: number, bufferWidth: number, bufferHeight: number): IHorizonCamera {
	if (role === 'stage') {
		const vanishingY = STAGE_VANISHING_Y_RATIO * bufferHeight;

		return {
			vanishingX: VANISHING_X_RATIO * bufferWidth,
			vanishingY,
			reach: (bufferHeight - vanishingY) * NEAR_OVERSHOOT,
			spread: STAGE_SPREAD_RATIO * bufferWidth / RAY_SPREAD_COUNT
		};
	}

	// Screen pixels, not a ratio: the strip this has to land in is a fixed screen
	// size whatever the window does. `cssHeight` is guarded by the caller.
	const vanishingY = GROUND_VANISHING_Y_PIXELS * bufferHeight / cssHeight;

	return {
		vanishingX: VANISHING_X_RATIO * bufferWidth,
		vanishingY,
		reach: (bufferHeight - vanishingY) * NEAR_OVERSHOOT,
		spread: GROUND_SPREAD_RATIO * bufferWidth / RAY_SPREAD_COUNT
	};
}

// --- the renderer ----------------------------------------------------------

class HorizonMotifRenderer implements IMotifRenderer {

	readonly id = PRIMAL_MOTIF_HORIZON_ID;
	readonly label = localize('primalCode.motif.horizon.label', "Horizon");
	readonly kind: PrimalMotifKind = 'canvas2d';

	private context: CanvasRenderingContext2D | undefined;
	private role: PrimalMotifRole = 'ground';
	private ink = '';

	private bufferWidth = 0;
	private bufferHeight = 0;
	private cssWidth = DEFAULT_CSS_WIDTH;
	private cssHeight = DEFAULT_CSS_HEIGHT;

	private camera: IHorizonCamera | undefined;

	/** `1/z` for each carried line, rewritten in place every frame. Never reallocated. */
	private readonly depth = new Float32Array(DEPTH_LINES);

	/**
	 * Eased milliseconds of motion, accumulated from `frame.delta` rather than
	 * read from `frame.time`, which is the scheduler's burst clock and restarts
	 * on every trigger. A plane driven by that clock would jump back to its
	 * starting phase each time the window regained focus. The delta is already
	 * eased, so this settles for free.
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
		this.camera = computeHorizonCamera(this.role, this.cssWidth, this.cssHeight, this.bufferWidth, this.bufferHeight);

		return true;
	}

	/**
	 * In the `ground` role the vanishing point is a fixed screen offset, so a
	 * layout moves it within the buffer; in `stage` the camera is expressed in
	 * fractions of the frame and does not move at all, which the epsilon test
	 * discovers for itself rather than being told.
	 */
	resize(width: number, height: number): void {
		if (!(width > 0) || !(height > 0) || !this.context) {
			return;
		}

		this.cssWidth = width;
		this.cssHeight = height;

		const next = computeHorizonCamera(this.role, width, height, this.bufferWidth, this.bufferHeight);
		if (this.camera && Math.abs(next.vanishingY - this.camera.vanishingY) < REBUILD_EPSILON) {
			return;
		}

		this.camera = next;
	}

	render(frame: IMotifFrame): void {
		const context = this.context;
		const camera = this.camera;
		if (!context || !camera) {
			return;
		}

		// `delta`, not `time`: see {@link elapsedMs}.
		this.elapsedMs += frame.delta;

		this.advance();

		context.clearRect(0, 0, this.bufferWidth, this.bufferHeight);
		context.strokeStyle = this.ink;

		this.paintRays(context, camera);
		this.paintPlane(context, camera);
		this.paintHorizon(context, camera);

		context.globalAlpha = 1;
	}

	dispose(): void {
		// Nothing is held but the context reference and eighteen floats.
		this.context = undefined;
		this.camera = undefined;
	}

	// --- the frame ----------------------------------------------------------

	/**
	 * Where each carried line is now, as `1/z`.
	 *
	 * `frac` counts DOWN from 1 to 0, so `z` falls and the plane comes towards
	 * the viewer. See the header for why the wrap at the end of that count is
	 * not visible.
	 */
	private advance(): void {
		const frac = 1 - wrapMotif(this.elapsedMs / SCROLL_PERIOD_MS, 1);

		for (let line = 0; line < DEPTH_LINES; line++) {
			this.depth[line] = 1 / (line + 1 + frac);
		}
	}

	/** A depth line's alpha, from its `1/z`. The whole of the distance cue. */
	private alphaOf(depth: number): number {
		return DEPTH_ALPHA_NEAR * Math.pow(depth, DEPTH_ALPHA_GAMMA);
	}

	/**
	 * The plane's cross lines, batched by alpha: every line in a bucket is one
	 * path and the bucket is one stroke.
	 */
	private paintPlane(context: CanvasRenderingContext2D, camera: IHorizonCamera): void {
		context.lineWidth = PLANE_LINE_WIDTH;

		// The plane is drawn to the full width of the buffer rather than to the
		// outermost ray: a ground plane has no edge, and stopping it at one would
		// have drawn its edge.
		const left = 0;
		const right = this.bufferWidth;

		for (let bucket = 0; bucket < DEPTH_BUCKETS; bucket++) {
			let drawn = false;
			context.beginPath();
			// The bucket's centre, so the faintest bucket is still lit and the
			// nearest is not blown out.
			context.globalAlpha = DEPTH_ALPHA_NEAR * ((bucket + 0.5) / DEPTH_BUCKETS);

			for (let line = 0; line < DEPTH_LINES; line++) {
				const depth = this.depth[line];
				if (this.bucketOf(this.alphaOf(depth)) !== bucket) {
					continue;
				}

				const y = camera.vanishingY + camera.reach * depth;
				context.moveTo(left, y);
				context.lineTo(right, y);
				drawn = true;
			}

			if (drawn) {
				context.stroke();
			}
		}
	}

	/** Which alpha bucket a line falls in. Clamped, so no line can be missed. */
	private bucketOf(alpha: number): number {
		return clampMotif(Math.floor(alpha / DEPTH_ALPHA_NEAR * DEPTH_BUCKETS), 0, DEPTH_BUCKETS - 1);
	}

	/**
	 * The rays: static, because a straight line through the vanishing point is
	 * the same line at every depth. Three strokes for the whole fan - one per
	 * segment of the fade - and no clock is read here at all.
	 */
	private paintRays(context: CanvasRenderingContext2D, camera: IHorizonCamera): void {
		context.lineWidth = PLANE_LINE_WIDTH;

		for (let segment = 0; segment < RAY_ALPHAS.length; segment++) {
			const from = RAY_STOPS[segment];
			const to = RAY_STOPS[segment + 1];

			context.globalAlpha = RAY_ALPHAS[segment];
			context.beginPath();

			for (let ray = -RAY_SPREAD_COUNT; ray <= RAY_SPREAD_COUNT; ray++) {
				const lateral = ray * camera.spread;
				context.moveTo(camera.vanishingX + lateral * from, camera.vanishingY + camera.reach * from);
				context.lineTo(camera.vanishingX + lateral * to, camera.vanishingY + camera.reach * to);
			}

			context.stroke();
		}
	}

	/** The horizon itself: the one line in the picture that never moves. */
	private paintHorizon(context: CanvasRenderingContext2D, camera: IHorizonCamera): void {
		context.globalAlpha = HORIZON_ALPHA;
		context.lineWidth = HORIZON_LINE_WIDTH;
		context.beginPath();
		context.moveTo(0, camera.vanishingY);
		context.lineTo(this.bufferWidth, camera.vanishingY);
		context.stroke();
	}
}

// --- registration ----------------------------------------------------------

registerMotif({
	id: PRIMAL_MOTIF_HORIZON_ID,
	label: localize('primalCode.motif.horizon', "Horizon"),
	description: localize('primalCode.motif.horizon.description', "A wireframe ground plane running under the window towards a vanishing point, its lines drawn in the active theme's own ink and fading with distance. No second colour. Under the default 'settle' motion it travels for about {0} seconds after a trigger and then rests.", PRIMAL_MOTIF_BURST_SECONDS),
	kind: 'canvas2d',
	// An even flow towards the viewer with no event in it and no phase to notice
	// passes the test `starfield.ts` sets for perpetual motion. It is still an
	// opt-in, and the status bar still offers the pause.
	allowsPerpetual: true,
	frameCostMs: HORIZON_FRAME_COST_MS,
	create: () => new HorizonMotifRenderer()
});
