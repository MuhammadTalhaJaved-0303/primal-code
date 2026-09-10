/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Colour science shared by the build-time theme generator and the workbench.
 *
 * WHY THIS FILE IS IN `src/vs/base/common` AND NOT IN `primal/`
 *
 * `primal/theme/validateTheme.ts` enforces WCAG contrast, an ANSI-separation
 * floor and colour-blindness simulation — but only at build time, over the
 * themes this repository generates. Every theme a user installs bypasses the
 * product's own accessibility rule entirely. To answer "is this theme readable"
 * at runtime the workbench needs the same maths, and the workbench may only
 * import from `src/vs` (`base` -> `platform` -> `editor` -> `workbench`).
 * Moving the pure maths down here and having the build scripts import THIS file
 * keeps exactly one implementation. The `primal/*` scripts run under
 * `node --experimental-strip-types` and import it by relative `.ts` path; that
 * is why this module has NO imports of its own — a `.js` specifier (which every
 * other file in `src/vs` uses) is not resolvable by the type-stripping loader.
 * Keep it dependency-free.
 *
 * WHAT IS HERE
 *
 *   - hex parsing/formatting, non-throwing (a malformed hex is data, not a crash)
 *   - the sRGB transfer function and linear-light compositing
 *   - WCAG 2.x relative luminance and contrast ratio
 *   - OKLab / OKLCH, including gamut-mapped conversion back to sRGB
 *   - CIELAB and CIEDE2000
 *   - dichromat simulation (protanopia / deuteranopia / tritanopia)
 *
 * The long-form arguments for each choice live with their callers:
 * `primal/theme/color.ts` (why OKLab rather than CIELAB, why compositing runs in
 * linear light) and `primal/theme/cvd.ts` (why the Brettel/Vienot planes are
 * derived here rather than transcribed). Those two files re-export from this one
 * and keep their `--check` / `--self-test` suites, which are what verify this
 * code against published reference data.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * sRGB, channels nominally 0..255. Not necessarily integral: dichromat
 * simulation returns continuous values so a distance measured on a simulated
 * colour is not quantised by an 8-bit round trip.
 */
export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** An sRGB colour with straight (non-premultiplied) alpha in 0..1. */
export interface Rgba extends Rgb {
	readonly alpha: number;
}

/** Linear-light sRGB, channels in 0..1 (may fall outside when out of gamut). */
export interface LinearRgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** OKLab. L in 0..1, a/b roughly -0.4..0.4. */
export interface Oklab {
	readonly L: number;
	readonly a: number;
	readonly b: number;
}

/** OKLCH: OKLab in polar form. L in 0..1, C >= 0, h in degrees 0..360. */
export interface Oklch {
	readonly L: number;
	readonly C: number;
	readonly h: number;
}

/** CIELAB, D65. L* in 0..100. */
export interface Lab {
	readonly l: number;
	readonly a: number;
	readonly b: number;
}

/** The three dichromacies this module can simulate. */
export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

/** An observer a measurement can be taken for. */
export type Observer = CvdType | 'normal';

/** The three dichromacies, in the order reports should list them. */
export const CVD_TYPES: readonly CvdType[] = ['protanopia', 'deuteranopia', 'tritanopia'];

/** Every observer a separation check runs for, trichromat first. */
export const OBSERVERS: readonly Observer[] = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];

// ---------------------------------------------------------------------------
// Hex parsing and formatting
// ---------------------------------------------------------------------------

const HEX_PATTERN = /^#?([0-9a-fA-F]{3,8})$/;

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

function byte(value: number): number {
	return clamp(Math.round(value), 0, 255);
}

/**
 * Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`.
 *
 * Returns `undefined` — never a substitute colour — for anything else. The
 * workbench's own `Color.fromHex` answers an unparseable value with
 * `Color.red`, which reports a parse failure by hue: invisible to a colour-blind
 * reader and indistinguishable from a theme that really did ask for red. Callers
 * here get `undefined` and must say so in words.
 */
export function tryParseHexColor(value: string): Rgba | undefined {
	const match = HEX_PATTERN.exec(value.trim());
	if (match === null) {
		return undefined;
	}
	const digits = match[1];
	const expand = (pair: string): number => parseInt(pair.length === 1 ? pair + pair : pair, 16);

	switch (digits.length) {
		case 3:
			return { r: expand(digits[0]), g: expand(digits[1]), b: expand(digits[2]), alpha: 1 };
		case 4:
			return { r: expand(digits[0]), g: expand(digits[1]), b: expand(digits[2]), alpha: expand(digits[3]) / 255 };
		case 6:
			return { r: expand(digits.slice(0, 2)), g: expand(digits.slice(2, 4)), b: expand(digits.slice(4, 6)), alpha: 1 };
		case 8:
			return {
				r: expand(digits.slice(0, 2)),
				g: expand(digits.slice(2, 4)),
				b: expand(digits.slice(4, 6)),
				alpha: expand(digits.slice(6, 8)) / 255
			};
		default:
			return undefined; // 5 or 7 digits: not a colour syntax anything accepts
	}
}

function hex2(value: number): string {
	return byte(value).toString(16).toUpperCase().padStart(2, '0');
}

/** Formats as uppercase `#RRGGBB`. Alpha is dropped; use {@link formatHexaColor} to keep it. */
export function formatHexColor(rgb: Rgb): string {
	return `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
}

/** Formats as `#RRGGBB`, or `#RRGGBBAA` when alpha is below 1. */
export function formatHexaColor(rgba: Rgba): string {
	const base = formatHexColor(rgba);
	return rgba.alpha >= 1 ? base : base + hex2(rgba.alpha * 255);
}

/** Drops the alpha channel, keeping the colour's own components. */
export function opaqueOf(rgba: Rgba): Rgb {
	return { r: rgba.r, g: rgba.g, b: rgba.b };
}

// ---------------------------------------------------------------------------
// sRGB transfer function
// ---------------------------------------------------------------------------

/** sRGB 0..1 -> linear-light 0..1. The IEC 61966-2-1 piecewise curve. */
export function srgbToLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Linear-light 0..1 -> sRGB 0..1. Inverse of {@link srgbToLinear}. */
export function linearToSrgb(channel: number): number {
	return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/** 8-bit sRGB -> linear-light. */
export function rgbToLinear(rgb: Rgb): LinearRgb {
	return {
		r: srgbToLinear(rgb.r / 255),
		g: srgbToLinear(rgb.g / 255),
		b: srgbToLinear(rgb.b / 255)
	};
}

/** Linear-light -> 8-bit sRGB, clamped into gamut. Use {@link inGamut} to test first. */
export function linearToRgb(linear: LinearRgb): Rgb {
	return {
		r: byte(linearToSrgb(clamp01(linear.r)) * 255),
		g: byte(linearToSrgb(clamp01(linear.g)) * 255),
		b: byte(linearToSrgb(clamp01(linear.b)) * 255)
	};
}

/** True when a linear-light colour is representable in sRGB without clipping. */
export function inGamut(linear: LinearRgb, epsilon = 1e-6): boolean {
	return (
		linear.r >= -epsilon && linear.r <= 1 + epsilon &&
		linear.g >= -epsilon && linear.g <= 1 + epsilon &&
		linear.b >= -epsilon && linear.b <= 1 + epsilon
	);
}

// ---------------------------------------------------------------------------
// WCAG relative luminance and contrast
// ---------------------------------------------------------------------------

/** WCAG 2.x relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
	const r = srgbToLinear(clamp01(rgb.r / 255));
	const g = srgbToLinear(clamp01(rgb.g / 255));
	const b = srgbToLinear(clamp01(rgb.b / 255));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1..21. Order of the arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------
// Alpha compositing
// ---------------------------------------------------------------------------

/**
 * Composites `fg` over an opaque `bg` using source-over, in LINEAR light.
 *
 * Compositing in gamma-encoded sRGB — the naive `fg*a + bg*(1-a)` on 8-bit
 * values — is what makes a 50%-alpha overlay look wrong. Linear light is what
 * the compositor actually does, so this returns the colour the user really
 * sees, which is the only one worth measuring contrast on.
 */
export function compositeOver(fg: Rgba, bg: Rgb): Rgb {
	if (fg.alpha >= 1) {
		return opaqueOf(fg);
	}
	if (fg.alpha <= 0) {
		return { r: bg.r, g: bg.g, b: bg.b };
	}
	const f = rgbToLinear(fg);
	const b = rgbToLinear(bg);
	const a = fg.alpha;
	return linearToRgb({
		r: f.r * a + b.r * (1 - a),
		g: f.g * a + b.g * (1 - a),
		b: f.b * a + b.b * (1 - a)
	});
}

/**
 * Composites `fg` over an opaque `bg` in GAMMA-ENCODED sRGB — a straight blend of
 * the 8-bit channels.
 *
 * Physically this is the wrong space, and {@link compositeOver} is the one to
 * reach for when the question is "what light comes out of the display". It is
 * here because it is what a browser actually does with a CSS alpha, and the
 * workbench is a browser: a theme's `#RRGGBBAA` token is flattened by the
 * compositor at `color-interpolation: sRGB`. So this is the colour that ends up
 * on screen, and therefore the one the readability checks measure.
 *
 * The result is intentionally NOT rounded to 8 bits: the caller is measuring a
 * distance, not painting a pixel.
 */
export function compositeOverSrgb(fg: Rgba, bg: Rgb): Rgb {
	const a = fg.alpha;
	return {
		r: fg.r * a + bg.r * (1 - a),
		g: fg.g * a + bg.g * (1 - a),
		b: fg.b * a + bg.b * (1 - a)
	};
}

// ---------------------------------------------------------------------------
// OKLab / OKLCH
// ---------------------------------------------------------------------------
// Matrices from Bjorn Ottosson's original derivation (2020). The forward path
// is linear sRGB -> LMS -> cube root -> OKLab; the inverse cubes and undoes it.

/** Linear-light sRGB -> OKLab. */
export function linearToOklab(linear: LinearRgb): Oklab {
	const l = 0.4122214708 * linear.r + 0.5363325363 * linear.g + 0.0514459929 * linear.b;
	const m = 0.2119034982 * linear.r + 0.6806995451 * linear.g + 0.1073969566 * linear.b;
	const s = 0.0883024619 * linear.r + 0.2817188376 * linear.g + 0.6299787005 * linear.b;

	const lRoot = Math.cbrt(l);
	const mRoot = Math.cbrt(m);
	const sRoot = Math.cbrt(s);

	return {
		L: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
		a: 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
		b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot
	};
}

/** OKLab -> linear-light sRGB. May fall outside the gamut. */
export function oklabToLinear(lab: Oklab): LinearRgb {
	const lRoot = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
	const mRoot = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
	const sRoot = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;

	const l = lRoot * lRoot * lRoot;
	const m = mRoot * mRoot * mRoot;
	const s = sRoot * sRoot * sRoot;

	return {
		r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
	};
}

/** OKLab -> OKLCH. A colour with no chroma is pinned to hue 0 so round trips stay deterministic. */
export function oklabToOklch(lab: Oklab): Oklch {
	const C = Math.hypot(lab.a, lab.b);
	const h = C < 1e-7 ? 0 : ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
	return { L: lab.L, C, h };
}

/** OKLCH -> OKLab. */
export function oklchToOklab(lch: Oklch): Oklab {
	const radians = (lch.h * Math.PI) / 180;
	return { L: lch.L, a: Math.cos(radians) * lch.C, b: Math.sin(radians) * lch.C };
}

/** 8-bit sRGB -> OKLCH. */
export function rgbToOklch(rgb: Rgb): Oklch {
	return oklabToOklch(linearToOklab(rgbToLinear(rgb)));
}

/**
 * OKLCH -> 8-bit sRGB, gamut-mapped by reducing chroma.
 *
 * Naive channel clipping shifts hue (clipping only the blue channel of an
 * out-of-gamut purple turns it pink). Instead: hold L and h, bisect C down to
 * the largest in-gamut value. Fixed iteration count, so the result is
 * deterministic — the generator must emit byte-identical JSON for a given seed.
 */
export function oklchToRgb(lch: Oklch): Rgb {
	const L = clamp01(lch.L);
	const direct = oklabToLinear(oklchToOklab({ L, C: lch.C, h: lch.h }));
	if (inGamut(direct)) {
		return linearToRgb(direct);
	}

	let lo = 0;
	let hi = lch.C;
	for (let i = 0; i < 28; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklabToLinear(oklchToOklab({ L, C: mid, h: lch.h })))) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return linearToRgb(oklabToLinear(oklchToOklab({ L, C: lo, h: lch.h })));
}

/**
 * The largest chroma sRGB can show at this lightness and hue — the gamut cusp
 * along one L/h line. Bisection at a fixed iteration count, so it is deterministic.
 */
export function maxChroma(L: number, h: number): number {
	let lo = 0;
	let hi = 0.5; // comfortably outside sRGB at every hue
	for (let i = 0; i < 28; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklabToLinear(oklchToOklab({ L: clamp01(L), C: mid, h })))) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return lo;
}

// ---------------------------------------------------------------------------
// CIELAB and CIEDE2000
// ---------------------------------------------------------------------------

/** Linear sRGB -> CIEXYZ (IEC 61966-2-1, D65). */
const XYZ_FROM_LINEAR_SRGB: ReadonlyArray<readonly [number, number, number]> = [
	[0.4124564, 0.3575761, 0.1804375],
	[0.2126729, 0.7151522, 0.072175],
	[0.0193339, 0.119192, 0.9503041]
];

/**
 * The reference white, taken as the matrix's own response to linear white rather
 * than as the tabulated D65 triple. They differ in the seventh decimal, which is
 * enough to give a pure grey a non-zero a* and b* — harmless in itself, but it
 * would mean neutrals never test as exactly neutral, and a check nobody can
 * state exactly is a check nobody trusts.
 */
const XYZ_WHITE: readonly [number, number, number] = [
	XYZ_FROM_LINEAR_SRGB[0][0] + XYZ_FROM_LINEAR_SRGB[0][1] + XYZ_FROM_LINEAR_SRGB[0][2],
	XYZ_FROM_LINEAR_SRGB[1][0] + XYZ_FROM_LINEAR_SRGB[1][1] + XYZ_FROM_LINEAR_SRGB[1][2],
	XYZ_FROM_LINEAR_SRGB[2][0] + XYZ_FROM_LINEAR_SRGB[2][1] + XYZ_FROM_LINEAR_SRGB[2][2]
];

/** sRGB -> CIELAB, D65, the white point sRGB is defined against. */
export function rgbToLab(rgb: Rgb): Lab {
	const r = srgbToLinear(clamp01(rgb.r / 255));
	const g = srgbToLinear(clamp01(rgb.g / 255));
	const b = srgbToLinear(clamp01(rgb.b / 255));
	const [xr, yr, zr] = XYZ_FROM_LINEAR_SRGB;
	const x = (xr[0] * r + xr[1] * g + xr[2] * b) / XYZ_WHITE[0];
	const y = (yr[0] * r + yr[1] * g + yr[2] * b) / XYZ_WHITE[1];
	const z = (zr[0] * r + zr[1] * g + zr[2] * b) / XYZ_WHITE[2];
	const epsilon = (6 / 29) ** 3;
	const f = (t: number): number => (t > epsilon ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
	const fx = f(x);
	const fy = f(y);
	const fz = f(z);
	return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * CIEDE2000's lightness weight SL, which is what stops a lightness difference
 * from being worth its face value in dE00.
 *
 * It is >= 1 everywhere and equals 1 only at Lbar 50, so dL* / SL <= dL* always,
 * and the penalty grows towards both ends of the range — which is where dark and
 * light themes put their text. It is factored out of {@link deltaE2000} rather
 * than written twice because the "separate by lightness" rule inverts it: the
 * two must never be able to disagree.
 */
export function lightnessWeight(lBar: number): number {
	return 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
}

/**
 * CIEDE2000 colour difference (CIE 142-2001), kL = kC = kH = 1.
 *
 * Plain euclidean distance in Lab (CIE76) would be simpler, but it badly
 * overestimates differences in the blue region and underestimates them in the
 * neutrals — exactly where a de-saturated editor palette lives.
 */
export function deltaE2000(first: Lab, second: Lab): number {
	const c1 = Math.hypot(first.a, first.b);
	const c2 = Math.hypot(second.a, second.b);
	const cBar = (c1 + c2) / 2;
	const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));

	const a1p = (1 + g) * first.a;
	const a2p = (1 + g) * second.a;
	const c1p = Math.hypot(a1p, first.b);
	const c2p = Math.hypot(a2p, second.b);

	const hue = (a: number, b: number): number => {
		if (a === 0 && b === 0) {
			return 0;
		}
		const h = toDegrees(Math.atan2(b, a));
		return h >= 0 ? h : h + 360;
	};
	const h1p = hue(a1p, first.b);
	const h2p = hue(a2p, second.b);

	const deltaLp = second.l - first.l;
	const deltaCp = c2p - c1p;

	let deltahp: number;
	if (c1p * c2p === 0) {
		deltahp = 0;
	} else if (Math.abs(h2p - h1p) <= 180) {
		deltahp = h2p - h1p;
	} else if (h2p - h1p > 180) {
		deltahp = h2p - h1p - 360;
	} else {
		deltahp = h2p - h1p + 360;
	}
	const deltaHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(toRadians(deltahp) / 2);

	const lBarp = (first.l + second.l) / 2;
	const cBarp = (c1p + c2p) / 2;

	let hBarp: number;
	if (c1p * c2p === 0) {
		hBarp = h1p + h2p;
	} else if (Math.abs(h1p - h2p) <= 180) {
		hBarp = (h1p + h2p) / 2;
	} else if (h1p + h2p < 360) {
		hBarp = (h1p + h2p + 360) / 2;
	} else {
		hBarp = (h1p + h2p - 360) / 2;
	}

	const t =
		1 -
		0.17 * Math.cos(toRadians(hBarp - 30)) +
		0.24 * Math.cos(toRadians(2 * hBarp)) +
		0.32 * Math.cos(toRadians(3 * hBarp + 6)) -
		0.2 * Math.cos(toRadians(4 * hBarp - 63));

	const deltaTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2));
	const rc = 2 * Math.sqrt(cBarp ** 7 / (cBarp ** 7 + 25 ** 7));
	const sl = lightnessWeight(lBarp);
	const sc = 1 + 0.045 * cBarp;
	const sh = 1 + 0.015 * cBarp * t;
	const rt = -Math.sin(toRadians(2 * deltaTheta)) * rc;

	const termL = deltaLp / sl;
	const termC = deltaCp / sc;
	const termH = deltaHp / sh;
	return Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + rt * termC * termH);
}

// ---------------------------------------------------------------------------
// Colour-vision-deficiency simulation
// ---------------------------------------------------------------------------
//
// Brettel, Vienot & Mollon (1997) and Vienot, Brettel & Mollon (1999). A
// dichromat lacks one cone class, so every colour he can perceive lies on a
// plane through the origin of LMS cone space. The plane is built from the
// neutral axis hinged with an anchor stimulus, and each colour is projected onto
// it along the axis of the missing cone.
//
// The projection coefficients are widely circulated as three magic constant
// pairs, and one of the circulated tritanopia pairs is wrong. A transcribed
// constant is a silent, permanent bias in every measurement downstream, so the
// planes are derived here from the LMS matrix and the anchors with cross
// products; `primal/theme/cvd.ts --self-test` checks the derived protanopia and
// deuteranopia coefficients against the published values.

/** A 3-vector, used for LMS cone responses and linear-RGB triples. */
export type Vector3 = readonly [number, number, number];

/** A 3x3 matrix in row-major order. */
export type Matrix3 = readonly [Vector3, Vector3, Vector3];

/**
 * Linear RGB -> LMS cone response. Smith & Pokorny cone fundamentals as
 * tabulated by Vienot et al. (1999). The absolute scale is arbitrary and
 * cancels: the pipeline goes straight back out through the inverse.
 */
export const CVD_LMS_FROM_LINEAR_RGB: Matrix3 = [
	[17.8824, 43.5161, 4.11935],
	[3.45565, 27.1554, 3.86714],
	[0.0299566, 0.184309, 1.46709]
];

/** Which cone is missing, as an index into an LMS triple. */
export const CVD_MISSING_CONE: Readonly<Record<CvdType, 0 | 1 | 2>> = {
	protanopia: 0, // no L cone
	deuteranopia: 1, // no M cone
	tritanopia: 2 // no S cone
};

/**
 * The anchor stimulus each dichromatic plane is hinged to, in linear RGB: blue
 * for the red-green deficiencies, red for tritanopia. Only one of each of
 * Brettel's anchor pairs is needed — the other is its complement about the white
 * point and spans the same plane.
 */
const PLANE_ANCHOR: Readonly<Record<CvdType, Vector3>> = {
	protanopia: [0, 0, 1],
	deuteranopia: [0, 0, 1],
	tritanopia: [1, 0, 0]
};

function invert3(m: Matrix3): Matrix3 {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		throw new Error(`primalColorScience: cone-response matrix is singular (det=${det}); cannot invert`);
	}
	return [
		[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
		[(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
		[(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]
	];
}

/** Multiplies a 3x3 matrix by a 3-vector. Exported so the build-time self-test can walk the pipeline. */
export function applyMatrix3(m: Matrix3, v: Vector3): Vector3 {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
	];
}

function cross(a: Vector3, b: Vector3): Vector3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** The inverse of {@link CVD_LMS_FROM_LINEAR_RGB}, computed rather than transcribed. */
export const CVD_LINEAR_RGB_FROM_LMS: Matrix3 = invert3(CVD_LMS_FROM_LINEAR_RGB);

/** LMS of equal-energy display white: the neutral axis every dichromatic plane contains. */
const WHITE_LMS: Vector3 = applyMatrix3(CVD_LMS_FROM_LINEAR_RGB, [1, 1, 1]);

/**
 * The two coefficients that reconstruct the missing cone's response from the
 * other two. The plane through the origin containing white and the anchor has
 * normal `n = white x anchor`; requiring `n . lms = 0` and holding the two
 * present cone responses fixed gives the missing one as a linear combination.
 */
function derivePlaneCoefficients(type: CvdType): readonly [number, number] {
	const missing = CVD_MISSING_CONE[type];
	const anchorLms = applyMatrix3(CVD_LMS_FROM_LINEAR_RGB, PLANE_ANCHOR[type]);
	const normal = cross(WHITE_LMS, anchorLms);
	if (Math.abs(normal[missing]) < 1e-9) {
		throw new Error(`primalColorScience: the ${type} plane is parallel to the missing cone axis`);
	}
	const present = [0, 1, 2].filter(index => index !== missing) as [number, number];
	return [-normal[present[0]] / normal[missing], -normal[present[1]] / normal[missing]];
}

/**
 * The derived plane coefficients, exported so the build-time self-test can check
 * them against the values Vienot, Brettel & Mollon published.
 */
export const CVD_PLANE_COEFFICIENTS: Readonly<Record<CvdType, readonly [number, number]>> = {
	protanopia: derivePlaneCoefficients('protanopia'),
	deuteranopia: derivePlaneCoefficients('deuteranopia'),
	tritanopia: derivePlaneCoefficients('tritanopia')
};

/** sRGB 0..255 -> linear RGB 0..1, clamped into the displayable cube. */
export function rgbToLinearTriple(rgb: Rgb): Vector3 {
	return [
		srgbToLinear(clamp01(rgb.r / 255)),
		srgbToLinear(clamp01(rgb.g / 255)),
		srgbToLinear(clamp01(rgb.b / 255))
	];
}

/** Linear RGB 0..1 -> sRGB 0..255, clipped to the displayable cube, not rounded. */
export function linearTripleToRgb(linear: Vector3): Rgb {
	return {
		r: clamp01(linearToSrgb(clamp01(linear[0]))) * 255,
		g: clamp01(linearToSrgb(clamp01(linear[1]))) * 255,
		b: clamp01(linearToSrgb(clamp01(linear[2]))) * 255
	};
}

/** Project an LMS triple onto the plane a dichromat of this type can see. */
function projectLms(lms: Vector3, type: CvdType): Vector3 {
	const missing = CVD_MISSING_CONE[type];
	const [first, second] = CVD_PLANE_COEFFICIENTS[type];
	const present = [0, 1, 2].filter(index => index !== missing) as [number, number];
	const replaced = first * lms[present[0]] + second * lms[present[1]];
	const out: [number, number, number] = [lms[0], lms[1], lms[2]];
	out[missing] = replaced;
	return out;
}

/**
 * Renders `rgb` as a dichromat of the given type sees it.
 *
 * Returns a new colour; the input is never touched. The projection runs in
 * LINEAR light — the many ports that push gamma-encoded bytes straight into the
 * LMS matrix are wrong in the direction that makes dark colours look more
 * separable than they are. Output channels are continuous so distances measured
 * on simulated colours are not quantised by an 8-bit round trip.
 */
export function simulateCvd(rgb: Rgb, type: CvdType): Rgb {
	const lms = applyMatrix3(CVD_LMS_FROM_LINEAR_RGB, rgbToLinearTriple(rgb));
	return linearTripleToRgb(applyMatrix3(CVD_LINEAR_RGB_FROM_LMS, projectLms(lms, type)));
}

/** Perceptual distance (CIEDE2000) between two opaque colours as one observer sees them. */
export function perceptualDistance(a: Rgb, b: Rgb, observer: Observer): number {
	const seenA = observer === 'normal' ? a : simulateCvd(a, observer);
	const seenB = observer === 'normal' ? b : simulateCvd(b, observer);
	return deltaE2000(rgbToLab(seenA), rgbToLab(seenB));
}
