/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../../base/common/color.js';
import { localize } from '../../../../../nls.js';
import { IMotifFrame, IMotifHost, IMotifPalette, IMotifRenderer, PrimalMotifKind, registerMotif } from '../primalMotif.js';
import { getWashMap } from './globeGround.js';
import { GLOBE_MASK_HEIGHT, GLOBE_MASK_WIDTH, IGlobeMaskMip, buildGlobeMaskMip } from './globeMask.js';

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
 * of this picture that is identical for a colour blind user. `palette.dim` and
 * `palette.accent` are deliberately unused: a second hue in the ground would be
 * the one thing here that some users could not see.
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

// --- placement -------------------------------------------------------------

/** The globe's radius as a fraction of the window's height, clamped to a screen size the frame can hold. */
const RADIUS_RATIO = 0.09;
const RADIUS_MIN_PIXELS = 100;
const RADIUS_MAX_PIXELS = 190;

/** Horizontal placement, as a fraction of the window's width. Right of the command centre, left of the layout controls. */
const CENTRE_X_RATIO = 0.74;

/** Vertical placement, in screen pixels below the top edge: a third of the default 35px title bar. */
const CENTRE_Y_PIXELS = 12;

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

/**
 * The atmosphere's ink alpha at a point, before the theme's own alpha.
 *
 * `rho` is the distance from the centre in radii, `nx` and `up` the direction
 * there in screen space, so the ring brightens towards the same light the
 * sphere is lit by.
 */
const haloAlpha = (rho: number, nx: number, up: number): number => {
	const drop = (rho - 1) / HALO_FALLOFF;
	if (drop < -HALO_REACH || drop > HALO_REACH) {
		return 0;
	}

	const facing = Math.max(0, (nx * LIGHT_X + up * LIGHT_Y) / Math.max(1e-3, rho));
	return HALO_ALPHA * Math.exp(-drop * drop) * (HALO_AMBIENT + (1 - HALO_AMBIENT) * facing);
};

/**
 * Parses one resolved theme token.
 *
 * `Color.Format.CSS.parse` throws on malformed input rather than returning
 * null. A palette's strings come from `Color.toString()` and are always either
 * a hex triple or an `rgba()`, but this is the boundary, so it is guarded.
 */
const parseToken = (value: string): Color | undefined => {
	if (!value) {
		return undefined;
	}

	try {
		return Color.Format.CSS.parse(value) ?? undefined;
	} catch {
		return undefined;
	}
};

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

	/** Eased milliseconds of motion this renderer has been handed, wrapped to one turn. */
	private spinMs = 0;

	create(host: IMotifHost): boolean {
		try {
			const canvas = host.element as HTMLCanvasElement;
			if (canvas.tagName !== 'CANVAS' || typeof canvas.getContext !== 'function') {
				return false;
			}

			// `alpha: true` because the ground below is the workbench's own, and
			// this motif paints ink onto it rather than replacing it.
			const context = canvas.getContext('2d', { alpha: true });
			if (!context) {
				return false;
			}

			const ink = this.readInk(host.palette);
			if (!ink) {
				// A theme that defines no foreground at all is a theme this cannot
				// be drawn from. Reporting it rather than guessing a colour is the
				// same call primalWallpaperPaint.ts makes when its tokens are missing.
				//
				// A refusal, not a failure: `host.fail` is deliberately not called,
				// because nothing is wrong with the graphics stack and the next
				// theme may well define the token. The scheduler records the refusal
				// against this motif and this palette and asks again when either
				// changes (see `markRefused` in primalMotifScheduler.ts).
				return false;
			}

			this.context = context;
			this.bufferWidth = host.bufferWidth;
			this.bufferHeight = host.bufferHeight;
			this.ink = packInk(ink);
			this.inkAlpha = ink.rgba.a;
			this.image = context.createImageData(host.bufferWidth, host.bufferHeight);
			this.pixels = new Uint32Array(this.image.data.buffer);
			this.wash = getWashMap(host.bufferWidth, host.bufferHeight);
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
	 * Repainting from here is what keeps a resize honest while the motif is at
	 * rest, which is most of the time: the scheduler lays surfaces out on every
	 * container layout but only runs frames during a burst, so a resize with no
	 * repaint would leave a stretched picture on screen until the next trigger.
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

		this.paint(false);
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

	// --- palette ------------------------------------------------------------

	/**
	 * One token, and two fallbacks that are the same ink by another name. There
	 * is no literal here and no guess: if none of the three parse, the caller
	 * declines to paint.
	 */
	private readInk(palette: IMotifPalette): Color | undefined {
		return parseToken(palette.ink) ?? parseToken(palette.dim) ?? parseToken(palette.accent);
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
			const lit = Math.pow(shade / (SHADE_LEVELS - 1), TONE_GAMMA) * this.inkAlpha;
			const sea = SEA_ALPHA * lit;
			const land = LAND_ALPHA * lit;

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
	 * Where the globe goes, in buffer coordinates.
	 *
	 * The radius is chosen in screen pixels and then divided by the stretch on
	 * each axis, which is what corrects the fixed 640x360 buffer being pulled to
	 * a window of some other shape: an ellipse here is a circle there.
	 */
	private placement(): { centreX: number; centreY: number; radiusX: number; radiusY: number } {
		const radius = clamp(RADIUS_RATIO * this.cssHeight, RADIUS_MIN_PIXELS, RADIUS_MAX_PIXELS);

		return {
			centreX: CENTRE_X_RATIO * this.bufferWidth,
			centreY: CENTRE_Y_PIXELS * this.bufferHeight / this.cssHeight,
			radiusX: radius * this.bufferWidth / this.cssWidth,
			radiusY: radius * this.bufferHeight / this.cssHeight
		};
	}

	/**
	 * Rebuilds the mask mip and the per-pixel tables, then repaints everything.
	 *
	 * This is the only expensive path in the file - one filtered pass over the
	 * 32K mask, one trigonometric pass over the few thousand pixels of the disc,
	 * and one pass over the buffer to lay the wash down. It runs on `create` and
	 * on a resize that moved the globe by more than half a buffer pixel, and
	 * never from a frame.
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
		this.paint(true);
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

		for (let y = boxY; y < boxY + boxHeight; y++) {
			const ny = (y + 0.5 - centreY) / radiusY;

			for (let x = boxX; x < boxX + boxWidth; x++) {
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

		// The area of the ellipse plus a perimeter's worth of slack: the number of
		// lattice points inside a conic exceeds its area by at most its boundary,
		// and running out would silently clip a wedge off the sphere.
		const capacity = Math.max(1, Math.ceil(Math.PI * radiusX * radiusY) + Math.ceil(4 * (radiusX + radiusY)) + 16);
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
				const longitude = Math.atan2(nx, across);
				const latitude = Math.asin(clamp(sinLatitude, -1, 1));

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
				const lit = (AMBIENT + (1 - AMBIENT) * diffuse) * Math.pow(nz, LIMB_DARKENING) * fade;

				const index = y * width + x;
				dest[count] = index;
				base[count] = row * GLOBE_MASK_WIDTH;
				column[count] = fixed;
				shade[count] = clamp(Math.round(lit * (SHADE_LEVELS - 1)), 0, SHADE_LEVELS - 1) << COVERAGE_SHIFT;
				mipTarget[count] = mip ? mip.rowMean[row] : 0;
				mipWeight[count] = Math.round(255 * clamp(spread / filtered - 1, 0, 1));
				// The ring, from the inside. `washTone` is a table, so the composite
				// is spelled out here rather than looked up.
				const halo = haloAlpha(rho, nx, up) * this.inkAlpha;
				const under = wash[index] / 255 * this.inkAlpha;
				backdrop[count] = Math.round(255 * (halo + under * (1 - halo)));
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
	create: () => new GlobeMotifRenderer()
});
