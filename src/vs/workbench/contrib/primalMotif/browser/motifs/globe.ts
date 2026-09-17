/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../../base/common/color.js';
import { localize } from '../../../../../nls.js';
import { IMotifFrame, IMotifHost, IMotifRenderer, PRIMAL_MOTIF_LAYOUT_BUDGET_MS, PrimalMotifKind, PrimalMotifRole, registerMotif } from '../primalMotif.js';
import { getGroundWash } from './globeGround.js';
import { GLOBE_MASK_HEIGHT, GLOBE_MASK_WIDTH, IGlobeMaskMip, buildGlobeMaskMip } from './globeMask.js';
import { acquireMotifContext, readMotifInk } from './motifPaint.js';

/**
 * Primal Code - the `world` motif: a slowly turning globe in the ground.
 *
 * THE TECHNIQUE, AND WHY IT IS NOT WEBGL. This is the COBE approach: an
 * equirectangular landmass mask (globeMask.ts) sampled per pixel through an
 * orthographic sphere projection, lit by one directional term. What makes it
 * cheap enough for canvas 2D is that the projection never changes between
 * frames - rotation is a *longitude offset*, and nothing else about a pixel
 * moves. So every transcendental in the maths below is computed once, at
 * `create` and on a resize that actually resized the globe, and baked into
 * parallel typed arrays. A frame is then one pass of integer table lookups:
 *
 *     coverage = mask[row + ((column + phase) mod 256)]     // two taps, lerped
 *     pixel    = ink | tone[shade + coverage] over backdrop
 *
 * Measured on the shipped code (node 22, the same V8 the workbench runs), per
 * frame against a 0.5ms budget:
 *
 *     1600x900   2,893 px   0.0135ms    2.7% of budget
 *     2560x1440  1,844 px   0.0081ms    1.6%
 *     3440x1440  1,368 px   0.0061ms    1.2%
 *     800x600    8,685 px   0.0388ms    7.8%
 *     640x480   13,579 px   0.0587ms   11.7%
 *
 * A small window is the expensive one, because the globe holds its size on
 * screen while the buffer's pixels get bigger - and even that is an eighth of
 * the budget. There is no reading of these numbers that justifies asking for a
 * GPU context: WebGL's own per-frame overhead - a bind, a uniform upload, a
 * draw call - would cost more than the whole picture does here, and it would
 * put a context that can be lost into a workbench that then has to survive
 * losing it. The one canvas 2D context is created by the scheduler's surface,
 * released when that surface goes, and cannot be lost.
 *
 * WHY THE PIXEL COUNT IS SO SMALL - AND WHERE THIS IS ACTUALLY VISIBLE. The
 * ground the wallpaper owns is the *frame*: `primalChrome.css` leaves the four
 * slabs flush and opaque, so the only ground a workbench shows is the title bar
 * strip, the status bar strip and the slabs' corner notches (see the header of
 * primalWallpaper.css, which says so in as many words). A motif additionally
 * forces `tintSlabs` off, so that is the whole of it. Composing a globe for the
 * middle of the window would therefore compose it for the one region nobody can
 * see. The globe is instead sized in *screen* pixels and its centre is put a
 * third of the way down the default title bar: the strip then cuts the sphere
 * across its widest chord, which is the one slice that carries both limbs, the
 * terminator and the equatorial continents at once. It is a fixed screen size
 * rather than a fraction of the window because the strip is a fixed screen size
 * too - a globe that grew with the window would only get flatter inside it.
 *
 * COLOUR. One token: `foreground`, at a varying alpha. Land, sea, terminator,
 * limb, atmosphere and the wash behind them are all the same ink; the picture
 * is carried entirely by luminance. That is the wallpaper's own doctrine
 * (`composeAmbientWash` uses `foreground` at three alphas and says it
 * "introduces no hue that the theme did not already have"), it is the chrome
 * spec's rule that meaning is never carried by hue, and it is the only reading
 * of this picture that is identical for a colour blind user. `palette.dim` is
 * only ever a fallback for a theme that defines no `foreground` at all, and it
 * is the same ink at a lower strength. `palette.accent` is not read anywhere in
 * this file, and must not become one: it resolves to `focusBorder`, a saturated
 * hue in four of the six vibes, and a second hue in the ground would be the one
 * thing here that some users could not see. The ink is read through
 * `readMotifInk` in `motifPaint.ts`, the one function every motif in this folder
 * reads it through - this file used to keep a private copy of that rule, which
 * is where the accent fallback crept in and which is why there is no copy now.
 *
 * WHERE THIS PAINTS. Two roles, and the composition differs between them
 * because the amount of visible ground differs by two orders of magnitude - see
 * {@link computeGlobePlacement}. `ground` is the strip described above.
 * `stage` is a large code-free pane, where the same picture is drawn ten times
 * bigger and cropped by the pane's own corner.
 *
 * THE RESTING FRAME. `settle` leaves this motif standing still most of the
 * time, so the resting frame is the product and the motion is the flourish. The
 * lighting is fixed to the viewer, not to the sphere, so whatever longitude the
 * burst runs out on, the picture is the same well-lit crescent with the
 * terminator falling in the same place - there is no phase of the rotation that
 * looks broken, and no frame that reads as a freeze rather than a rest.
 */

// --- identity --------------------------------------------------------------

export const PRIMAL_MOTIF_WORLD_ID = 'world';

/**
 * The measured median cost of one `render()`, in milliseconds, at the role and
 * host size that cost the most - which for this motif is the stage, by a factor
 * of eighteen.
 *
 * The table in the header above is the per-window-size measurement at the
 * `ground` role, taken with node, and it is still what that role costs. This is
 * what the workbench's own Electron renderer measures for the whole frame
 * including the `putImageData` upload, at both roles
 * (`test/browser/motifBudget.test.ts` is the harness and re-measures it on every
 * run):
 *
 *     ground  1920x1080 window   0.019ms     3.8% of the 0.5ms budget
 *     stage   1428x1025 pane     0.360ms    72.0%
 *
 * THE STAGE FIGURE IS THE LEAST MARGIN ANY MOTIF HERE HAS, and it is not a
 * surprise: {@link STAGE_RADIUS_RATIO} makes the disc about ten times the
 * ground role's radius, which is a hundred times the pixels, and the
 * `putImageData` rectangle grows with it until it is most of the buffer. It
 * holds the 0.5ms budget on this machine and the ladder's own `overBudget` rung
 * catches a machine where it does not - but it is the one number in this contrib
 * that would not survive being made bigger, and anything that raises the stage
 * radius has to be measured rather than reasoned about.
 */
export const GLOBE_FRAME_COST_MS = 0.360;

/**
 * The measured median cost of one `resize()` that actually rebuilds, in
 * milliseconds, at the stage - the role and size where it costs the most.
 *
 * NOT A FRAME, AND NOT POLICED LIKE ONE. This is the "most expensive thing this
 * contrib does" that `primalMotifScheduler.ts` reports against
 * {@link PRIMAL_MOTIF_LAYOUT_BUDGET_MS}: the mask mip, the seven geometry tables
 * and the halo, all rebuilt because the pane changed shape. It runs from a
 * layout and never from a frame, so `frameCostMs` does not cover it and the
 * strike counter never sees it - which is exactly why it is declared and
 * measured on its own (`test/browser/motifBudget.test.ts`, the resize suite):
 *
 *     stage   1428x1025 pane, 70,507 disc pixels   3.3ms    83% of the 4ms layout budget
 *     ground  1920x1080 window                     0.3ms     8%
 *
 * Three things keep a sash drag from paying this at the display's cadence, and
 * all three are needed. The scheduler flushes layouts no more often than the
 * ceiling frame interval; {@link STAGE_RADIUS_STEP_PIXELS} holds the radius
 * still across small changes so most flushes rebuild nothing; and the
 * transcendentals in {@link GlobeMotifRenderer.buildGeometry} that could be
 * tabled are (`asin`, `pow`) or approximated (`atan2`), and the halo pass
 * solves the ring's extent per row instead of scanning the disc - which is
 * what brought the stage figure down from 6ms to under the budget in the
 * first place. It is still the least margin any number in this contrib has,
 * and anything that raises the stage radius has to be measured, not reasoned
 * about.
 */
export const GLOBE_STAGE_REBUILD_COST_MS = 3.3;

// --- the sphere ------------------------------------------------------------

/** Axial tilt, in radians. The real 23.44 degrees, tipping the north pole towards the viewer. */
const TILT = 0.4084;

const COS_TILT = Math.cos(TILT);
const SIN_TILT = Math.sin(TILT);

/**
 * The key light, in view space: x right, y up, z towards the viewer.
 *
 * Up and to the left, and slightly in front, which puts the terminator on the
 * lower right of the disc and agrees with the wallpaper wash's own bright pool
 * at 18% 6%. One light, no specular, no second fill: this is a tonal
 * silhouette, not a photograph.
 */
const LIGHT_LENGTH = Math.sqrt(0.52 * 0.52 + 0.42 * 0.42 + 0.75 * 0.75);
const LIGHT_X = -0.52 / LIGHT_LENGTH;
const LIGHT_Y = 0.42 / LIGHT_LENGTH;
const LIGHT_Z = 0.75 / LIGHT_LENGTH;

/** How much of the sphere's tone survives on the night side. */
const AMBIENT = 0.10;

/** Limb darkening: `pow(cos(view angle), this)`. Small, so the sphere reads round rather than flat. */
const LIMB_DARKENING = 0.30;

/** Buffer pixels of geometric fade at the limb. Two is enough to antialias an edge that never moves. */
const LIMB_FADE_PIXELS = 2.2;

// --- tone ------------------------------------------------------------------

/** Ink alpha of fully lit ocean. */
const SEA_ALPHA = 0.40;

/**
 * How sea and land answer the light differently, which is most of what makes a
 * sphere read as a planet rather than a printed ball.
 *
 * Water is close to a mirror at a grazing angle: it is dark where it faces away
 * and carries a broad sheen where it faces the sun. Land is matte - it scatters
 * what it receives and saturates early, so it keeps its shape across the whole
 * lit face and does not blow out under the sun.
 *
 * Both are curves over the same lit term, so both live in the tone table and
 * cost nothing per frame. The exponents are the whole model: sea below 1 would
 * flatten it, so it stays above; land above the sea's exponent would darken the
 * continents into the ocean, so it stays below.
 */
const SEA_GAMMA = 1.45;
const LAND_GAMMA = 0.78;

/** The sun's sheen on water: how strong, and how tight around the sub-solar point. */
const SEA_SHEEN_ALPHA = 0.55;
const SEA_SHEEN_TIGHTNESS = 7.0;

// Land keeps its shape across the terminator because its exponent is below
// one, which lifts the midtones. A constant floor would do it too, but it would
// survive the limb fade and draw a hard ring around the disc, so the curve
// carries it instead: at no light there is still no land.

/** Ink alpha of fully lit land. The wallpaper's own wash peaks at 1, so this matches the shipped ceiling. */
const LAND_ALPHA = 1.0;

/** Applied to the lighting term before it reaches alpha, to deepen the terminator a little. */
const TONE_GAMMA = 1.15;

/** Quantisation of the tone table. 128 levels of light is a 0.6% alpha step - below anything visible. */
const SHADE_LEVELS = 128;
const COVERAGE_LEVELS = 64;
const COVERAGE_SHIFT = 6;
const COVERAGE_QUANTISE = 2;

/**
 * The atmosphere: an ink ring centred on the limb itself, brighter on the lit
 * side.
 *
 * Centred *on* the limb rather than outside it, because the sphere's own alpha
 * is already fading to nothing across the last couple of pixels of the disc. A
 * ring that began where the sphere ended would leave a dark gap between the two,
 * and the gap is what the eye would read. Sitting astride the limb, the ring
 * fills that fade from the outside as the sphere hands it over from the inside,
 * and the seam disappears - which is why the same function is evaluated in two
 * places: baked into the buffer outside the disc, folded into each disc pixel's
 * backdrop inside it.
 */
const HALO_WIDTH = 0.13;
const HALO_ALPHA = 0.55;
const HALO_FALLOFF = 0.04;
const HALO_AMBIENT = 0.35;

/** Standard deviations of the ring that are worth evaluating. */
const HALO_REACH = 3;

/**
 * The atmosphere seen edge-on: a thin brightening just inside the limb, on the
 * lit side only. It is what separates a sphere from a disc - the halo outside
 * says there is air, and this says the air is in front of the planet too.
 * A function of the surface normal alone, so it is folded into the backdrop
 * when the geometry is built and costs nothing per frame.
 */
const RIM_ALPHA = 0.30;
const RIM_POWER = 5.0;

// --- placement -------------------------------------------------------------

/** The globe's radius as a fraction of the window's height, clamped to a screen size the frame can hold. */
const RADIUS_RATIO = 0.09;
const RADIUS_MIN_PIXELS = 100;
const RADIUS_MAX_PIXELS = 190;

/** Horizontal placement, as a fraction of the window's width. Right of the command centre, left of the layout controls. */
const CENTRE_X_RATIO = 0.74;

/** Vertical placement, in screen pixels below the top edge: a third of the default 35px title bar. */
const CENTRE_Y_PIXELS = 12;

/**
 * The `stage` role: the limb placement.
 *
 * A stage is a large code-free pane rather than a 35px strip, so the reasoning
 * above inverts. There is real ground here, and the constants that put 94% of
 * the disc above the window's top edge would put a small smudge behind the
 * page's text instead.
 *
 * The centre therefore goes down and right, far enough that the pane crops the
 * disc on both of those edges: what shows is a large arc rising into frame - a
 * planet limb - and not a small disc, and not a full disc sitting behind the
 * text column. The composition is anchored to the bottom-right corner rather
 * than to the content, which is what makes it survive the ~263px the page's own
 * height swings by as the recents list fills in asynchronously.
 *
 * The radius is a fraction of the pane's SHORTER side, unlike the ground role's
 * fraction of height: a stage can be any shape a split leaves it, and a globe
 * sized off the long side of a wide, short pane would be cropped to a band.
 */
// The stage globe used to be centred at 86%/88% with a radius over half the
// pane, which put its centre off the bottom-right corner: what reached the
// frame was a shallow arc with no centre and no horizon, and it read as a
// smudge rather than as a planet. The centre now sits inside the frame, so the
// limb curves away on two sides and the continents cross a visible meridian.
const STAGE_RADIUS_RATIO = 0.43;
const STAGE_RADIUS_MIN_PIXELS = 220;
const STAGE_RADIUS_MAX_PIXELS = 560;
const STAGE_CENTRE_X_RATIO = 0.78;
const STAGE_CENTRE_Y_RATIO = 0.76;

/**
 * The stage radius is held to steps of this many screen pixels.
 *
 * A sash drag lays the pane out once per mouse move, and at the stage every
 * three pixels of width moved the disc's buffer radius past
 * {@link REBUILD_EPSILON} - one full rebuild ({@link GLOBE_STAGE_REBUILD_COST_MS})
 * per three pixels of drag. Ten screen pixels of radius is two percent of a
 * stage disc, invisible as a step while the pane itself is moving, and it means
 * a drag rebuilds once per eighteen pixels rather than once per three. The
 * clamp is applied after the rounding, so its ends stay exact.
 */
const STAGE_RADIUS_STEP_PIXELS = 10;

/** How far the globe's buffer size must move before the tables are worth rebuilding. */
const REBUILD_EPSILON = 0.5;

/** The size assumed until the first layout, so `create` always produces a complete picture. */
const DEFAULT_CSS_WIDTH = 1280;
const DEFAULT_CSS_HEIGHT = 720;

// --- rotation --------------------------------------------------------------

/** One turn every three minutes. Slow enough to be weather, not animation. */
const ROTATION_PERIOD_MS = 180000;

/** Sub-pixel steps per mask column. The mask is only 256 wide; without this the sphere would judder. */
const PHASE_FRACTION_BITS = 7;
const PHASE_FRACTION = 1 << PHASE_FRACTION_BITS;
const PHASE_UNITS = GLOBE_MASK_WIDTH * PHASE_FRACTION;

/** Where a fresh globe starts: 20E under the viewer, which puts Africa and Arabia in the frame. */
const START_LONGITUDE_DEGREES = 20;
const PHASE_START = Math.round(START_LONGITUDE_DEGREES / 360 * PHASE_UNITS);

// --- pixel packing ---------------------------------------------------------

/**
 * Which byte of a 32 bit word `ImageData` puts alpha in. Every platform the
 * workbench ships on is little endian, but the packed write below is the one
 * place where being wrong would be silent and total, so it is measured rather
 * than assumed.
 */
const LITTLE_ENDIAN = (() => {
	const word = new Uint32Array(1);
	new Uint8Array(word.buffer)[0] = 1;
	return word[0] === 1;
})();

const ALPHA_SHIFT = LITTLE_ENDIAN ? 24 : 0;

const packInk = (color: Color): number => {
	const { r, g, b } = color.rgba;
	return (LITTLE_ENDIAN ? (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8)) >>> 0;
};

// --- geometry --------------------------------------------------------------

/**
 * Everything about one globe that does not change between frames.
 *
 * The arrays are parallel and packed - one entry per pixel of the disc, in
 * raster order - so a frame is a linear walk with no branch and no bounds test.
 */
interface IGlobeGeometry {
	/** Index into the pixel buffer. */
	readonly dest: Int32Array;
	/** `row * GLOBE_MASK_WIDTH`, the start of this pixel's latitude in the mask. */
	readonly base: Int32Array;
	/** Longitude, as a fixed point mask column with 7 fractional bits. */
	readonly column: Uint16Array;
	/** Lighting, pre-multiplied by `COVERAGE_LEVELS` so it indexes the tone table directly. */
	readonly shade: Uint16Array;
	/** The row's mean coverage, which a pixel dissolves towards as the sphere turns away. */
	readonly mipTarget: Uint8Array;
	/** How far it has dissolved: 0 where the mask is sampled honestly, 255 at the limb. */
	readonly mipWeight: Uint8Array;
	/** The wash's alpha underneath, so the disc composites onto the ground instead of punching through it. */
	readonly backdrop: Uint8Array;
	readonly count: number;

	readonly centreX: number;
	readonly centreY: number;
	readonly radiusX: number;
	readonly radiusY: number;

	/** The rectangle `putImageData` refreshes: the disc plus its halo, clipped to the buffer. */
	readonly boxX: number;
	readonly boxY: number;
	readonly boxWidth: number;
	readonly boxHeight: number;
}

const clamp = (value: number, low: number, high: number): number => value < low ? low : value > high ? high : value;

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

// --- the transcendentals, once ----------------------------------------------
//
// `buildGeometry` evaluates an `asin`, a `pow` and an `atan2` for every pixel
// of the disc, seventy thousand of them at the stage, and those three were
// most of a 6ms rebuild. Two are functions of one bounded argument and are
// tabled; the third is not, and is approximated instead. None of the three is
// on a per-frame path.

/** Entries per unit of the argument in the two tables below. */
const TABLE_STEPS = 4096;

/**
 * `asin` over [-1, 1], linearly interpolated.
 *
 * The result only has to land on one of `GLOBE_MASK_HEIGHT` rows, and the
 * interpolation is there for the poles, where `asin` runs vertical and a plain
 * lookup would be a row out.
 */
const ASIN_TABLE = (() => {
	const table = new Float32Array(TABLE_STEPS + 1);
	for (let index = 0; index <= TABLE_STEPS; index++) {
		table[index] = Math.asin(index / TABLE_STEPS * 2 - 1);
	}
	return table;
})();

const asinOf = (value: number): number => {
	const scaled = (clamp(value, -1, 1) + 1) * (TABLE_STEPS / 2);
	const index = Math.min(TABLE_STEPS - 1, Math.floor(scaled));
	const fraction = scaled - index;
	return ASIN_TABLE[index] + (ASIN_TABLE[index + 1] - ASIN_TABLE[index]) * fraction;
};

/**
 * `pow(nz, LIMB_DARKENING)` over [0, 1]. A plain lookup: the quantity feeds a
 * 128-level shade table, and `nz` is only near zero at the limb, where the
 * geometric fade has already taken the pixel to nothing.
 */
const LIMB_TABLE = (() => {
	const table = new Float32Array(TABLE_STEPS + 1);
	for (let index = 0; index <= TABLE_STEPS; index++) {
		table[index] = Math.pow(index / TABLE_STEPS, LIMB_DARKENING);
	}
	return table;
})();

const limbOf = (nz: number): number => LIMB_TABLE[Math.floor(clamp(nz, 0, 1) * TABLE_STEPS)];

/**
 * The rim's radial profile. Tabled for the same reason the limb is: it is
 * evaluated once per pixel of the disc during a rebuild, and a `Math.pow` there
 * costs more than the whole lighting term around it.
 */
const RIM_TABLE = (() => {
	const table = new Float32Array(TABLE_STEPS + 1);
	for (let index = 0; index <= TABLE_STEPS; index++) {
		table[index] = Math.pow(index / TABLE_STEPS, RIM_POWER);
	}
	return table;
})();

const rimOf = (rho: number): number => RIM_TABLE[Math.floor(clamp(rho, 0, 1) * TABLE_STEPS)];

/**
 * `atan` over [0, 1], as an odd minimax polynomial. Worst error 1.7e-6 radians
 * over the whole plane once folded through {@link atan2Of}, which is under a
 * hundredth of one fixed-point longitude unit - and half the cost of the
 * intrinsic, which was a fifth of the rebuild on its own.
 */
const atanOf = (t: number): number => {
	const t2 = t * t;
	return t * (0.99997726 + t2 * (-0.33262347 + t2 * (0.19354346 + t2 * (-0.11643287 + t2 * (0.05265332 + t2 * -0.01172120)))));
};

/** `Math.atan2`, through {@link atanOf} and the usual octant folding. */
const atan2Of = (y: number, x: number): number => {
	const ax = Math.abs(x);
	const ay = Math.abs(y);
	if (ax === 0 && ay === 0) {
		return 0;
	}

	const swap = ay > ax;
	let angle = atanOf(swap ? ax / ay : ay / ax);
	if (swap) {
		angle = Math.PI / 2 - angle;
	}
	if (x < 0) {
		angle = Math.PI - angle;
	}

	return y < 0 ? -angle : angle;
};

/** Where the globe goes, in buffer coordinates. */
export interface IGlobePlacement {
	readonly centreX: number;
	readonly centreY: number;
	readonly radiusX: number;
	readonly radiusY: number;
}

/**
 * Where the globe goes, in buffer coordinates, for one role and one CSS size.
 *
 * Pure, exported and free of the renderer's state, because this is the one piece
 * of arithmetic in the file whose answer is a *composition* rather than a
 * picture: it is what decides whether the product shows a globe or a smudge, and
 * it is therefore the piece worth a test rather than a screenshot.
 *
 * THE ASPECT CORRECTION, IN BOTH ROLES. A radius is chosen in screen pixels and
 * then divided by the stretch on each axis, which is what corrects the fixed
 * 640x360 buffer being pulled to a host of some other shape: an ellipse here is
 * a circle there. Both roles do it identically, so
 * `radiusX / bufferWidth * cssWidth === radiusY / bufferHeight * cssHeight`
 * holds whatever shape the host is - which is the invariant the stage needed,
 * since a pane is very rarely 16:9.
 *
 * @param role see {@link PrimalMotifRole}. `ground` reproduces the shipped
 * title-strip composition exactly; nothing about it is derived from the stage.
 */
export function computeGlobePlacement(role: PrimalMotifRole, cssWidth: number, cssHeight: number, bufferWidth: number, bufferHeight: number): IGlobePlacement {
	if (role === 'stage') {
		const wanted = STAGE_RADIUS_RATIO * Math.min(cssWidth, cssHeight);
		const stepped = Math.round(wanted / STAGE_RADIUS_STEP_PIXELS) * STAGE_RADIUS_STEP_PIXELS;
		const radius = clamp(stepped, STAGE_RADIUS_MIN_PIXELS, STAGE_RADIUS_MAX_PIXELS);

		return {
			centreX: STAGE_CENTRE_X_RATIO * bufferWidth,
			// A ratio, and not the ground role's fixed pixel offset: a stage has
			// no fixed strip to be a third of the way down, and its height is
			// whatever the editor group leaves it.
			centreY: STAGE_CENTRE_Y_RATIO * bufferHeight,
			radiusX: radius * bufferWidth / cssWidth,
			radiusY: radius * bufferHeight / cssHeight
		};
	}

	const radius = clamp(RADIUS_RATIO * cssHeight, RADIUS_MIN_PIXELS, RADIUS_MAX_PIXELS);

	return {
		centreX: CENTRE_X_RATIO * bufferWidth,
		centreY: CENTRE_Y_PIXELS * bufferHeight / cssHeight,
		radiusX: radius * bufferWidth / cssWidth,
		radiusY: radius * bufferHeight / cssHeight
	};
}


/**
 * The atmosphere's ink alpha at a point, before the theme's own alpha.
 *
 * `rho` is the distance from the centre in radii, `nx` and `up` the direction
 * there in screen space, so the ring brightens towards the same light the
 * sphere is lit by.
 */
/** The rim's alpha at radius `rho` inside the disc, facing the light. */
const rimAlpha = (rho: number, nx: number, up: number): number => {
	const facing = Math.max(0, (nx * LIGHT_X + up * LIGHT_Y) / Math.max(1e-3, rho));
	return RIM_ALPHA * rimOf(rho) * facing;
};

const haloAlpha = (rho: number, nx: number, up: number): number => {
	const drop = (rho - 1) / HALO_FALLOFF;
	if (drop < -HALO_REACH || drop > HALO_REACH) {
		return 0;
	}

	const facing = Math.max(0, (nx * LIGHT_X + up * LIGHT_Y) / Math.max(1e-3, rho));
	return HALO_ALPHA * Math.exp(-drop * drop) * (HALO_AMBIENT + (1 - HALO_AMBIENT) * facing);
};

/**
 * The globe's ink, which is every motif's ink: `readMotifInk` in
 * `motifPaint.ts`, re-exported under the name `globePlacement.test.ts` has
 * always held this motif to.
 *
 * Not a wrapper and not a copy. This file used to carry its own `parseToken`
 * and `readGlobeInk`, byte for byte the same logic as `motifPaint.ts` - and a
 * second copy of the ink rule is exactly how the accent fallback got into one
 * motif without getting into the others. The doctrine lives in one function
 * and this is that function.
 */
export const readGlobeInk = readMotifInk;

// --- the renderer ----------------------------------------------------------

class GlobeMotifRenderer implements IMotifRenderer {

	readonly id = PRIMAL_MOTIF_WORLD_ID;
	readonly label = localize('primalCode.motif.world.label', "World");
	readonly kind: PrimalMotifKind = 'canvas2d';

	private context: CanvasRenderingContext2D | undefined;
	private image: ImageData | undefined;
	private pixels: Uint32Array | undefined;

	private bufferWidth = 0;
	private bufferHeight = 0;

	/** `foreground`, packed without its alpha, and that alpha kept aside for the tables. */
	private ink = 0;
	private inkAlpha = 1;

	/** Alpha for every (lighting, coverage) pair, `SHADE_LEVELS * COVERAGE_LEVELS` of them. */
	private tone: Uint8Array | undefined;

	private wash: Uint8Array | undefined;
	/** The wash's shape put into the theme's ink, one entry per possible byte, so no pixel pass does float work. */
	private washTone: Uint8Array | undefined;
	private mip: IGlobeMaskMip | undefined;
	private geometry: IGlobeGeometry | undefined;

	private cssWidth = DEFAULT_CSS_WIDTH;
	private cssHeight = DEFAULT_CSS_HEIGHT;

	/**
	 * The kind of ground this renderer was handed, fixed at `create`.
	 *
	 * A host change rebuilds the renderer rather than mutating it (see
	 * `ensureSurface` in primalMotifScheduler.ts), so this never changes under a
	 * live picture and `ground` stays the answer for every window that has not
	 * offered a stage.
	 */
	private role: PrimalMotifRole = 'ground';

	/** Eased milliseconds of motion this renderer has been handed, wrapped to one turn. */
	private spinMs = 0;

	/**
	 * The next `paint` must upload the whole buffer, not the disc's rectangle.
	 *
	 * Set by {@link rebuild}, which rewrites the wash where the previous globe
	 * was and the halo where the new one is - two rectangles, of which a frame's
	 * own upload covers only the second. Cleared by the paint that honours it.
	 */
	private uploadAll = false;

	create(host: IMotifHost): boolean {
		// Both refusals come before the `try`, deliberately. A context that would
		// not initialise and a palette with no ink in it are facts about this
		// surface and this theme, and the scheduler has a recoverable path for
		// each (`markRefused`); the `catch` below is the terminal path, and a
		// missing token must never be able to reach it. `motifRegistry.test.ts`
		// holds every motif to that distinction.
		const context = acquireMotifContext(host);
		if (!context) {
			return false;
		}

		const ink = readMotifInk(host.palette);
		if (!ink) {
			// A theme that defines no foreground at all is a theme this cannot be
			// drawn from. Reporting it rather than guessing a colour is the same
			// call primalWallpaperPaint.ts makes when its tokens are missing.
			//
			// A refusal, not a failure: `host.fail` is deliberately not called,
			// because nothing is wrong with the graphics stack and the next theme
			// may well define the token. The scheduler records the refusal against
			// this motif and this palette and asks again when either changes (see
			// `markRefused` in primalMotifScheduler.ts).
			return false;
		}

		try {
			this.context = context;
			this.role = host.role;
			this.bufferWidth = host.bufferWidth;
			this.bufferHeight = host.bufferHeight;
			this.ink = packInk(ink);
			this.inkAlpha = ink.rgba.a;
			this.image = context.createImageData(host.bufferWidth, host.bufferHeight);
			this.pixels = new Uint32Array(this.image.data.buffer);
			this.wash = getGroundWash(host.role, host.bufferWidth, host.bufferHeight);
			this.washTone = this.buildWashTone();
			this.tone = this.buildTone();

			this.rebuild();
			return true;
		} catch (error) {
			host.fail(`a globe it could not build (${error})`);
			return false;
		}
	}

	/**
	 * The globe is a fixed size on screen, so a layout change is a change of
	 * *buffer* size: the fixed 640x360 buffer is stretched to the window, and
	 * these tables carry the correction that keeps a circle circular.
	 *
	 * Nothing is painted here. The scheduler owns when a frame happens, and it
	 * paints one resting frame after any layout that changed a surface's size
	 * while no frame chain is armed (`flushLayouts` in primalMotifScheduler.ts),
	 * so a resize at rest never leaves a stretched picture on screen and no
	 * motif has to repaint itself to prevent it. This used to end in a full
	 * `putImageData`, which was one upload for the rebuild and a second for the
	 * frame that followed.
	 */
	resize(width: number, height: number): void {
		if (!(width > 0) || !(height > 0) || !this.context) {
			return;
		}

		this.cssWidth = width;
		this.cssHeight = height;

		// A layout that moved the globe by less than half a buffer pixel is not
		// worth a rebuild, and a window drag is a great many such layouts.
		const geometry = this.geometry;
		const placement = this.placement();
		if (geometry
			&& Math.abs(placement.radiusX - geometry.radiusX) < REBUILD_EPSILON
			&& Math.abs(placement.radiusY - geometry.radiusY) < REBUILD_EPSILON
			&& Math.abs(placement.centreY - geometry.centreY) < REBUILD_EPSILON) {
			return;
		}

		this.rebuild();
	}

	render(frame: IMotifFrame): void {
		// `delta` and not `time`: the scheduler restarts its burst clock on every
		// trigger, so a globe driven by `time` would snap back to its starting
		// meridian each time the window regained focus. The delta is already eased
		// by the settle curve, so accumulating it settles this motif for free.
		this.spinMs += frame.delta;
		if (this.spinMs >= ROTATION_PERIOD_MS) {
			this.spinMs -= ROTATION_PERIOD_MS;
		}

		this.paint(this.uploadAll);
		this.uploadAll = false;
	}

	dispose(): void {
		// The surface removes the canvas and zeroes its backing store; all this
		// owns is about 1MB of typed arrays, and they go with it.
		this.context = undefined;
		this.image = undefined;
		this.pixels = undefined;
		this.tone = undefined;
		this.washTone = undefined;
		this.mip = undefined;
		this.geometry = undefined;
	}

	// --- tables -------------------------------------------------------------

	/**
	 * Alpha for every quantised (lighting, coverage) pair.
	 *
	 * Land and sea are the same ink at different strengths, so coverage
	 * interpolates between two alpha curves rather than between two colours -
	 * which is what reduces a frame's inner loop to a lookup and a blend.
	 */
	private buildTone(): Uint8Array {
		const tone = new Uint8Array(SHADE_LEVELS * COVERAGE_LEVELS);

		for (let shade = 0; shade < SHADE_LEVELS; shade++) {
			// The shared response, then each material's own answer to it.
			const lit = Math.pow(shade / (SHADE_LEVELS - 1), TONE_GAMMA);

			// Water: dark across the terminator, with a broad glint where it faces
			// the sun. The glint is clamped so the sheen cannot exceed opaque ink.
			const sheen = SEA_SHEEN_ALPHA * Math.pow(lit, SEA_SHEEN_TIGHTNESS);
			const sea = Math.min(1, SEA_ALPHA * Math.pow(lit, SEA_GAMMA) + sheen) * this.inkAlpha;

			// Land: matte, holding its shape into the terminator, and still zero
			// where there is no light at all.
			const land = LAND_ALPHA * Math.pow(lit, LAND_GAMMA) * this.inkAlpha;

			for (let coverage = 0; coverage < COVERAGE_LEVELS; coverage++) {
				const share = coverage / (COVERAGE_LEVELS - 1);
				tone[(shade << COVERAGE_SHIFT) + coverage] = Math.round(255 * (sea + share * (land - sea)));
			}
		}

		return tone;
	}

	/** The wash's alpha shape, put into this theme's ink once instead of per pixel. */
	private buildWashTone(): Uint8Array {
		const tone = new Uint8Array(256);
		for (let shape = 0; shape < tone.length; shape++) {
			tone[shape] = Math.round(shape * this.inkAlpha);
		}

		return tone;
	}

	/**
	 * Where the globe goes, in buffer coordinates. The arithmetic itself is
	 * {@link computeGlobePlacement}, which is pure and tested; this is only the
	 * renderer's current state handed to it.
	 */
	private placement(): IGlobePlacement {
		return computeGlobePlacement(this.role, this.cssWidth, this.cssHeight, this.bufferWidth, this.bufferHeight);
	}

	/**
	 * Rebuilds the mask mip and the per-pixel tables, and lays the wash and the
	 * halo back into the buffer, ready for the next paint to upload.
	 *
	 * This is the only expensive path in the file - one filtered pass over the
	 * 32K mask, one trigonometric pass over the pixels of the disc, and one pass
	 * over the previous disc's rectangle to lay the wash down. It runs on
	 * `create` and on a resize that moved the globe by more than half a buffer
	 * pixel, and never from a frame; {@link GLOBE_STAGE_REBUILD_COST_MS} is what
	 * it costs, and the resize suite in `motifBudget.test.ts` holds it there.
	 */
	private rebuild(): void {
		const context = this.context;
		const pixels = this.pixels;
		const image = this.image;
		const wash = this.wash;
		const washTone = this.washTone;
		if (!context || !pixels || !image || !wash || !washTone) {
			return;
		}

		const previous = this.geometry;
		const { centreX, centreY, radiusX, radiusY } = this.placement();

		this.mip = buildGlobeMaskMip(radiusX, radiusY);
		this.geometry = this.buildGeometry(centreX, centreY, radiusX, radiusY, wash);

		// The wash goes down first, because it is also what takes the previous
		// globe's halo back off the ground. Only where that globe was, though: the
		// rest of the buffer has never been anything but wash, and repainting all
		// 230,400 pixels of it on every step of a window drag would be the most
		// expensive thing in the file by an order of magnitude.
		this.restoreWash(previous);
		this.paintHalo();
		this.uploadAll = true;
	}

	/**
	 * Lays the wash down over one globe's rectangle, or over the whole buffer
	 * when there was no previous globe and the buffer is still transparent.
	 */
	private restoreWash(previous: IGlobeGeometry | undefined): void {
		const pixels = this.pixels;
		const wash = this.wash;
		const washTone = this.washTone;
		if (!pixels || !wash || !washTone) {
			return;
		}

		const ink = this.ink;

		if (!previous) {
			for (let i = 0; i < pixels.length; i++) {
				pixels[i] = ink | (washTone[wash[i]] << ALPHA_SHIFT);
			}
			return;
		}

		for (let y = previous.boxY; y < previous.boxY + previous.boxHeight; y++) {
			const row = y * this.bufferWidth;
			for (let x = previous.boxX; x < previous.boxX + previous.boxWidth; x++) {
				pixels[row + x] = ink | (washTone[wash[row + x]] << ALPHA_SHIFT);
			}
		}
	}

	/**
	 * The atmosphere: an ink ring immediately outside the limb, falling off over
	 * a tenth of the radius and brighter where the light strikes.
	 *
	 * It is static - the sphere turns inside it - so it is baked into the buffer
	 * with the wash rather than recomputed per frame. It is also what gives the
	 * globe a crisp circular edge while the sphere itself dissolves into the
	 * ground, which is the read that survives being seen through a 35 pixel slot.
	 */
	private paintHalo(): void {
		const pixels = this.pixels;
		const geometry = this.geometry;
		const wash = this.wash;
		if (!pixels || !geometry || !wash) {
			return;
		}

		const washTone = this.washTone;
		if (!washTone) {
			return;
		}

		const { centreX, centreY, radiusX, radiusY, boxX, boxY, boxWidth, boxHeight } = geometry;
		const outer = 1 + HALO_WIDTH;
		const ink = this.ink;
		const boxRight = boxX + boxWidth;

		for (let y = boxY; y < boxY + boxHeight; y++) {
			const ny = (y + 0.5 - centreY) / radiusY;
			const ny2 = ny * ny;
			if (ny2 >= outer * outer) {
				continue;
			}

			// The ring's extent along this row, solved rather than searched: the
			// disc inside it is seventy thousand pixels at the stage, and walking
			// them only to `continue` was most of this pass.
			const spanOuter = Math.sqrt(outer * outer - ny2) * radiusX;
			const spanInner = ny2 < 1 ? Math.sqrt(1 - ny2) * radiusX : 0;

			this.paintHaloRun(y, ny, Math.max(boxX, Math.floor(centreX - spanOuter)), Math.min(boxRight, Math.ceil(centreX - spanInner) + 1), outer, ink, pixels, wash, washTone, centreX, radiusX);
			this.paintHaloRun(y, ny, Math.max(boxX, Math.floor(centreX + spanInner) - 1), Math.min(boxRight, Math.ceil(centreX + spanOuter) + 1), outer, ink, pixels, wash, washTone, centreX, radiusX);
		}
	}

	/** One horizontal run of the ring: `[from, to)` on row `y`, with the exact test still applied per pixel. */
	private paintHaloRun(y: number, ny: number, from: number, to: number, outer: number, ink: number, pixels: Uint32Array, wash: Uint8Array, washTone: Uint8Array, centreX: number, radiusX: number): void {
		for (let x = from; x < to; x++) {
			const nx = (x + 0.5 - centreX) / radiusX;
			const rho = Math.sqrt(nx * nx + ny * ny);
			if (rho < 1 || rho > outer) {
				continue;
			}

			const halo = Math.round(255 * haloAlpha(rho, nx, -ny) * this.inkAlpha);
			if (halo <= 0) {
				continue;
			}

			const index = y * this.bufferWidth + x;
			const under = washTone[wash[index]];
			pixels[index] = ink | ((halo + (((255 - halo) * under) >> 8)) << ALPHA_SHIFT);
		}
	}

	/**
	 * The projection, once.
	 *
	 * For a pixel inside the disc, `(nx, -ny, nz)` on the unit sphere is both the
	 * surface point and its normal - that is what makes an orthographic sphere
	 * worth its arithmetic. Latitude is that point's angle to the tilted axis;
	 * longitude is its angle in the plane perpendicular to the axis, measured
	 * from the meridian under the viewer, so that adding a constant to it is
	 * exactly what rotating the planet does.
	 */
	private buildGeometry(centreX: number, centreY: number, radiusX: number, radiusY: number, wash: Uint8Array): IGlobeGeometry {
		const mip = this.mip;
		const width = this.bufferWidth;
		const height = this.bufferHeight;

		const halo = Math.ceil(radiusX * HALO_WIDTH) + 1;
		const boxX = clamp(Math.floor(centreX - radiusX - halo), 0, width);
		const boxRight = clamp(Math.ceil(centreX + radiusX + halo) + 1, 0, width);
		const boxY = clamp(Math.floor(centreY - radiusY - halo), 0, height);
		const boxBottom = clamp(Math.ceil(centreY + radiusY + halo) + 1, 0, height);

		// How many pixels the loops below can possibly record, by the tighter of
		// the two bounds that hold.
		//
		// The first is the area of the ellipse plus a perimeter's worth of slack:
		// the number of lattice points inside a conic exceeds its area by at most
		// its boundary, and running out would silently clip a wedge off the
		// sphere. The second is the clipped box the loops actually walk, which
		// visits each `(x, y)` once and so cannot record more than its own area.
		//
		// Both are exact upper bounds, so the smaller is safe, and which one is
		// smaller depends on the role. A ground globe sits inside the buffer and
		// the ellipse binds. A stage globe is centred at 86%/88% of a fixed
		// 640x360 buffer with a radius several times the ground's, so it always
		// runs off the right and bottom edges: more than half of the ellipse's
		// area is outside the buffer, and sizing seven parallel arrays from it
		// allocated over a megabyte per rebuild that was never written to.
		const boxArea = (boxRight - boxX) * (boxBottom - boxY);
		const ellipseArea = Math.ceil(Math.PI * radiusX * radiusY) + Math.ceil(4 * (radiusX + radiusY)) + 16;
		const capacity = Math.max(1, Math.min(ellipseArea, boxArea));
		const dest = new Int32Array(capacity);
		const base = new Int32Array(capacity);
		const column = new Uint16Array(capacity);
		const shade = new Uint16Array(capacity);
		const mipTarget = new Uint8Array(capacity);
		const mipWeight = new Uint8Array(capacity);
		const backdrop = new Uint8Array(capacity);

		const fadeFrom = 1 - LIMB_FADE_PIXELS / Math.max(LIMB_FADE_PIXELS * 2, radiusX);
		const columnsPerRadian = GLOBE_MASK_WIDTH / (2 * Math.PI);
		let count = 0;

		for (let y = boxY; y < boxBottom && count < capacity; y++) {
			const ny = (y + 0.5 - centreY) / radiusY;
			if (ny <= -1 || ny >= 1) {
				continue;
			}

			for (let x = boxX; x < boxRight && count < capacity; x++) {
				const nx = (x + 0.5 - centreX) / radiusX;
				const rho2 = nx * nx + ny * ny;
				if (rho2 >= 1) {
					continue;
				}

				const nz = Math.sqrt(1 - rho2);
				const rho = Math.sqrt(rho2);
				const up = -ny;

				// Latitude off the tilted axis (0, cos T, sin T); longitude in the
				// plane it spans with (1, 0, 0) and (0, -sin T, cos T), which is
				// oriented so that east runs to the right of the screen.
				const sinLatitude = up * COS_TILT + nz * SIN_TILT;
				const across = -up * SIN_TILT + nz * COS_TILT;
				const longitude = atan2Of(nx, across);
				const latitude = asinOf(sinLatitude);

				let row = Math.floor((0.5 - latitude / Math.PI) * GLOBE_MASK_HEIGHT);
				row = clamp(row, 0, GLOBE_MASK_HEIGHT - 1);

				let fixed = Math.round((longitude + Math.PI) / (2 * Math.PI) * PHASE_UNITS) % PHASE_UNITS;
				if (fixed < 0) {
					fixed += PHASE_UNITS;
				}

				// How many mask columns this pixel actually covers, from the exact
				// derivative of the longitude along x. Near the limb it runs away,
				// which is precisely where the mask has to stop being believed.
				const cosLatitude2 = Math.max(1e-4, nx * nx + across * across);
				const spread = Math.abs((across + nx * nx * COS_TILT / Math.max(1e-3, nz)) / cosLatitude2) / radiusX * columnsPerRadian;
				const filtered = mip ? mip.rowWidth[row] : 1;

				const diffuse = Math.max(0, nx * LIGHT_X + up * LIGHT_Y + nz * LIGHT_Z);
				const fade = smoothstep(clamp((1 - rho) / (1 - fadeFrom), 0, 1));
				const lit = (AMBIENT + (1 - AMBIENT) * diffuse) * limbOf(nz) * fade;

				const index = y * width + x;
				dest[count] = index;
				base[count] = row * GLOBE_MASK_WIDTH;
				column[count] = fixed;
				shade[count] = clamp(Math.round(lit * (SHADE_LEVELS - 1)), 0, SHADE_LEVELS - 1) << COVERAGE_SHIFT;
				mipTarget[count] = mip ? mip.rowMean[row] : 0;
				mipWeight[count] = Math.round(255 * clamp(spread / filtered - 1, 0, 1));
				// The ring, from the inside. `washTone` is a table, so the composite
				// is spelled out here rather than looked up.
				const glow = (haloAlpha(rho, nx, up) + rimAlpha(rho, nx, up)) * this.inkAlpha;
				const under = wash[index] / 255 * this.inkAlpha;
				backdrop[count] = Math.round(255 * (glow + under * (1 - glow)));
				count++;
			}
		}

		return {
			dest, base, column, shade, mipTarget, mipWeight, backdrop, count,
			centreX, centreY, radiusX, radiusY,
			boxX, boxY, boxWidth: Math.max(0, boxRight - boxX), boxHeight: Math.max(0, boxBottom - boxY)
		};
	}

	// --- the frame ----------------------------------------------------------

	/**
	 * One frame: a linear walk of the disc's pixels, two mask taps each, no
	 * branch, no allocation, no trigonometry.
	 *
	 * `full` uploads the whole buffer, which happens on a rebuild; every other
	 * frame uploads only the rectangle the globe and its halo occupy, so the
	 * wash is copied to the GPU once rather than thirty times a second.
	 */
	private paint(full: boolean): void {
		const context = this.context;
		const image = this.image;
		const pixels = this.pixels;
		const geometry = this.geometry;
		const tone = this.tone;
		const mip = this.mip;
		if (!context || !image || !pixels || !geometry || !tone || !mip) {
			return;
		}

		const phase = this.phase();
		const mask = mip.coverage;
		const wrap = GLOBE_MASK_WIDTH - 1;
		const ink = this.ink;
		const { dest, base, column, shade, mipTarget, mipWeight, backdrop, count } = geometry;

		for (let k = 0; k < count; k++) {
			const offset = column[k] + phase;
			const start = base[k];
			const first = (offset >> PHASE_FRACTION_BITS) & wrap;

			const near = mask[start + first];
			const far = mask[start + ((first + 1) & wrap)];

			// Linear in longitude between two mask columns. The globe turns by a
			// fifth of a column per frame; without this it would step.
			let coverage = near + (((far - near) * (offset & (PHASE_FRACTION - 1))) >> PHASE_FRACTION_BITS);
			coverage += ((mipTarget[k] - coverage) * mipWeight[k]) >> 8;

			const alpha = tone[shade[k] + (coverage >> COVERAGE_QUANTISE)];
			const under = backdrop[k];
			pixels[dest[k]] = ink | ((alpha + (((255 - alpha) * under) >> 8)) << ALPHA_SHIFT);
		}

		if (full) {
			context.putImageData(image, 0, 0);
		} else if (geometry.boxWidth > 0 && geometry.boxHeight > 0) {
			context.putImageData(image, 0, 0, geometry.boxX, geometry.boxY, geometry.boxWidth, geometry.boxHeight);
		}
	}

	/**
	 * The rotation, as a fixed point mask column offset.
	 *
	 * It runs backwards: the meridian under the viewer moves west as the planet
	 * turns east, which is what puts the continents across the frame from left to
	 * right - the direction the Earth is seen to turn from orbit with north up.
	 */
	private phase(): number {
		const turned = this.spinMs / ROTATION_PERIOD_MS * PHASE_UNITS;
		let phase = (PHASE_START - turned) % PHASE_UNITS;
		if (phase < 0) {
			phase += PHASE_UNITS;
		}

		return Math.floor(phase);
	}
}

registerMotif({
	id: PRIMAL_MOTIF_WORLD_ID,
	label: localize('primalCode.motif.world', "World"),
	description: localize('primalCode.motif.world.description', "A globe in the ground behind the workbench, turning once every three minutes, drawn from the active theme's foreground at low opacity. Land, sea and light are all the same ink - no second colour is introduced."),
	kind: 'canvas2d',
	allowsPerpetual: true,
	frameCostMs: GLOBE_FRAME_COST_MS,
	create: () => new GlobeMotifRenderer()
});
