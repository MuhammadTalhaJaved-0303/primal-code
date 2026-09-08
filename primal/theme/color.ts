#!/usr/bin/env node --experimental-strip-types
/**
 * Colour maths for the theme generator. Pure functions, no I/O, no dependencies.
 *
 * WHY THIS FILE EXISTS
 *
 * The six shipping themes were hand-authored, so nothing ever proved that a
 * warning and an "added" marker are actually distinguishable, or that a
 * semi-transparent overlay still clears a contrast floor once it is composited
 * onto the plane underneath. Generated themes have to prove both, mechanically,
 * for every palette in a corpus. That needs real colour maths rather than hex
 * arithmetic, and adding a dependency to a build-time script in this repo is not
 * on the table - so it is written here, once, and unit-tested via --check.
 *
 * WHY OKLCH RATHER THAN CIELAB
 *
 * Both give a perceptually-uniform lightness axis, which is the thing the owner
 * (colour blind: amber reads as green) actually depends on - semantic colours
 * must separate by LIGHTNESS, not hue. OKLab wins on two counts that matter for
 * a generator that must *move* colours rather than only measure them:
 *
 *   1. Hue linearity. CIELAB has a well-known blue-hue problem: changing the
 *      lightness of a saturated blue swings it toward purple. The generator
 *      lifts and drops semantic colours along L while holding their identity,
 *      so a hue that drifts under lightness change would silently retint
 *      "info" from blue to violet. OKLab's hue lines stay straight.
 *   2. Lightness uniformity for the dark end. The Primal dark vibes sit at
 *      L* ~ 8-12 in CIELAB, where CIELAB's linear-segment toe makes equal L*
 *      steps look unequal. OKLab was fitted against modern datasets and holds
 *      its step size down there.
 *
 * Cost: 3x3 matrices and a cube root, about forty lines. Cheap enough.
 *
 * WCAG relative luminance is kept alongside OKLab L rather than replaced by it.
 * They answer different questions - OKLab L is "do these read as different
 * shades", WCAG contrast is "is this legible", and the accessibility floor the
 * product is checked against is stated in WCAG terms. Both are here.
 *
 * Run the unit tests:
 *
 *   node --experimental-strip-types primal/theme/color.ts --check
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** sRGB, 8-bit per channel, the space every theme hex is written in. */
export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** An sRGB colour with an alpha in 0..1. Alpha 1 means an opaque `#RRGGBB`. */
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

// ---------------------------------------------------------------------------
// Hex parsing and formatting
// ---------------------------------------------------------------------------

const HEX_PATTERN = /^#?([0-9a-fA-F]{3,8})$/;

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

function byte(value: number): number {
	return clamp(Math.round(value), 0, 255);
}

/**
 * Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`. Throws on anything else -
 * a malformed hex in a palette is a bug in the palette, not something to
 * silently default away.
 */
export function parseHex(hex: string): Rgba {
	const match = HEX_PATTERN.exec(hex.trim());
	if (match === null) throw new Error(`color: not a hex colour: ${JSON.stringify(hex)}`);
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
			throw new Error(`color: hex colour must have 3, 4, 6 or 8 digits: ${JSON.stringify(hex)}`);
	}
}

function hex2(value: number): string {
	return byte(value).toString(16).toUpperCase().padStart(2, "0");
}

/** Formats as uppercase `#RRGGBB`. Alpha is dropped; use `formatHexa` to keep it. */
export function formatHex(rgb: Rgb): string {
	return `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
}

/** Formats as `#RRGGBB`, or `#RRGGBBAA` when alpha is below 1. */
export function formatHexa(rgba: Rgba): string {
	const base = formatHex(rgba);
	if (rgba.alpha >= 1) return base;
	return base + hex2(rgba.alpha * 255);
}

// ---------------------------------------------------------------------------
// sRGB transfer function
// ---------------------------------------------------------------------------

/** sRGB 0..1 -> linear-light 0..1. The IEC 61966-2-1 piecewise curve. */
export function srgbToLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Linear-light 0..1 -> sRGB 0..1. Inverse of `srgbToLinear`. */
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

/** Linear-light -> 8-bit sRGB, clamped into gamut. Use `inGamut` to test first. */
export function linearToRgb(linear: LinearRgb): Rgb {
	return {
		r: byte(linearToSrgb(clamp(linear.r, 0, 1)) * 255),
		g: byte(linearToSrgb(clamp(linear.g, 0, 1)) * 255),
		b: byte(linearToSrgb(clamp(linear.b, 0, 1)) * 255)
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
	const linear = rgbToLinear(rgb);
	return 0.2126 * linear.r + 0.7152 * linear.g + 0.0722 * linear.b;
}

/** WCAG 2.x contrast ratio, 1..21. Order of the arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const lighter = Math.max(la, lb);
	const darker = Math.min(la, lb);
	return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// OKLab / OKLCH
// ---------------------------------------------------------------------------
// Matrices from Bjorn Ottosson's original derivation (2020). The forward path
// is linear sRGB -> LMS -> cube root -> OKLab; the inverse cubes and undoes it.

export function linearToOklab(linear: LinearRgb): Oklab {
	const l = 0.4122214708 * linear.r + 0.5363325363 * linear.g + 0.0514459929 * linear.b;
	const m = 0.2119034982 * linear.r + 0.6806995451 * linear.g + 0.1073969566 * linear.b;
	const s = 0.0883024619 * linear.r + 0.2817188376 * linear.g + 0.6299787005 * linear.b;

	const l_ = Math.cbrt(l);
	const m_ = Math.cbrt(m);
	const s_ = Math.cbrt(s);

	return {
		L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
		a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
		b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
	};
}

export function oklabToLinear(lab: Oklab): LinearRgb {
	const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
	const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
	const s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;

	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;

	return {
		r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
	};
}

export function oklabToOklch(lab: Oklab): Oklch {
	const C = Math.hypot(lab.a, lab.b);
	// A colour with no chroma has no meaningful hue; pin it at 0 so round-trips
	// stay deterministic instead of depending on floating-point noise in atan2.
	const h = C < 1e-7 ? 0 : ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
	return { L: lab.L, C, h };
}

export function oklchToOklab(lch: Oklch): Oklab {
	const radians = (lch.h * Math.PI) / 180;
	return { L: lch.L, a: Math.cos(radians) * lch.C, b: Math.sin(radians) * lch.C };
}

/** 8-bit sRGB -> OKLCH. */
export function rgbToOklch(rgb: Rgb): Oklch {
	return oklabToOklch(linearToOklab(rgbToLinear(rgb)));
}

/** Convenience: hex string -> OKLCH, alpha ignored. */
export function hexToOklch(hex: string): Oklch {
	return rgbToOklch(parseHex(hex));
}

/**
 * OKLCH -> 8-bit sRGB, gamut-mapped by reducing chroma.
 *
 * Naive channel clipping shifts hue (clipping only the blue channel of an
 * out-of-gamut purple turns it pink). Instead: hold L and h, bisect C down to
 * the largest in-gamut value. Fixed iteration count, so the result is
 * deterministic - the generator must emit byte-identical JSON for a given seed.
 */
export function oklchToRgb(lch: Oklch): Rgb {
	const L = clamp(lch.L, 0, 1);
	const direct = oklabToLinear(oklchToOklab({ L, C: lch.C, h: lch.h }));
	if (inGamut(direct)) return linearToRgb(direct);

	let lo = 0;
	let hi = lch.C;
	for (let i = 0; i < 28; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklabToLinear(oklchToOklab({ L, C: mid, h: lch.h })))) lo = mid;
		else hi = mid;
	}
	return linearToRgb(oklabToLinear(oklchToOklab({ L, C: lo, h: lch.h })));
}

/** OKLCH -> `#RRGGBB`. */
export function oklchToHex(lch: Oklch): string {
	return formatHex(oklchToRgb(lch));
}

/** OKLab lightness of a hex colour, 0..1. The axis the semantic ladder runs on. */
export function lightness(hex: string): number {
	return rgbToOklch(parseHex(hex)).L;
}

/** |ΔL| in OKLab between two hex colours. The colour-blindness separation metric. */
export function deltaLightness(a: string, b: string): number {
	return Math.abs(lightness(a) - lightness(b));
}

/** Returns `hex` re-lightened to OKLab L, holding its hue and as much chroma as fits. */
export function withLightness(hex: string, L: number): string {
	const lch = hexToOklch(hex);
	return oklchToHex({ L: clamp(L, 0, 1), C: lch.C, h: lch.h });
}

/** Returns `hex` with its chroma scaled by `factor`, holding L and hue. */
export function withChromaScaled(hex: string, factor: number): string {
	const lch = hexToOklch(hex);
	return oklchToHex({ L: lch.L, C: Math.max(0, lch.C * factor), h: lch.h });
}

/**
 * The largest chroma sRGB can show at this lightness and hue - the gamut cusp
 * along one L/h line.
 *
 * The generator needs this because the sRGB gamut is far narrower at the light
 * and dark ends than in the middle. Moving a mid-tone colour to an extreme
 * lightness while holding its chroma presses it flat against the boundary,
 * where it stops reading as "this palette's red" and starts reading as "red".
 * Knowing where the wall is lets a caller stop short of it.
 *
 * Bisection at a fixed iteration count, so it is deterministic.
 */
export function maxChroma(L: number, h: number): number {
	let lo = 0;
	let hi = 0.5; // Comfortably outside sRGB at every hue.
	for (let i = 0; i < 28; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklabToLinear(oklchToOklab({ L: clamp(L, 0, 1), C: mid, h })))) lo = mid;
		else hi = mid;
	}
	return lo;
}

// ---------------------------------------------------------------------------
// Alpha compositing
// ---------------------------------------------------------------------------

/**
 * Composites `fg` over an opaque `bg` using source-over, in LINEAR light.
 *
 * Compositing in gamma-encoded sRGB - the naive `fg*a + bg*(1-a)` on 8-bit
 * values - is what makes a 50%-alpha overlay look wrong; it is what the CSS
 * spec calls out and what the GPU actually avoids. Doing it in linear light is
 * what the workbench compositor does, so the number this returns is the colour
 * the user really sees, which is the only one worth measuring contrast on.
 */
export function compositeOver(fg: Rgba, bg: Rgb): Rgb {
	if (fg.alpha >= 1) return { r: fg.r, g: fg.g, b: fg.b };
	if (fg.alpha <= 0) return { r: bg.r, g: bg.g, b: bg.b };
	const f = rgbToLinear(fg);
	const b = rgbToLinear(bg);
	const a = fg.alpha;
	return linearToRgb({
		r: f.r * a + b.r * (1 - a),
		g: f.g * a + b.g * (1 - a),
		b: f.b * a + b.b * (1 - a)
	});
}

/** `compositeOver` on hex strings. `fgHex` may carry an `AA` suffix. */
export function flattenOver(fgHex: string, bgHex: string): string {
	return formatHex(compositeOver(parseHex(fgHex), parseHex(bgHex)));
}

/**
 * The contrast a token ACTUALLY delivers: `fgHex` may be semi-transparent, so
 * it is flattened onto `bgHex` first. A raw contrastRatio() on the unflattened
 * hex overstates every `#RRGGBBAA` token in the theme.
 */
export function effectiveContrast(fgHex: string, bgHex: string): number {
	const bg = parseHex(bgHex);
	const flatBg = bg.alpha >= 1 ? bg : compositeOver(bg, { r: 255, g: 255, b: 255 });
	return contrastRatio(compositeOver(parseHex(fgHex), flatBg), flatBg);
}

/**
 * Interpolation in gamma-encoded sRGB - a straight lerp of the 8-bit channels.
 *
 * Physically this is the wrong space, and `mixHex` (linear light) is the one to
 * reach for when blending light. It is here because it is the space a person
 * mixes in when they nudge a hex by eye, and it is the space tokenMap.ts's
 * SURFACE_FALLBACKS were fitted in - reproducing those fits needs the same
 * arithmetic that produced them, not a better one.
 */
export function mixHexSrgb(aHex: string, bHex: string, t: number): string {
	const a = parseHex(aHex);
	const b = parseHex(bHex);
	const k = clamp(t, 0, 1);
	return formatHex({
		r: a.r * (1 - k) + b.r * k,
		g: a.g * (1 - k) + b.g * k,
		b: a.b * (1 - k) + b.b * k
	});
}

/** Linear-light interpolation between two hex colours, `t` in 0..1. */
export function mixHex(aHex: string, bHex: string, t: number): string {
	const a = rgbToLinear(parseHex(aHex));
	const b = rgbToLinear(parseHex(bHex));
	const k = clamp(t, 0, 1);
	return formatHex(linearToRgb({
		r: a.r * (1 - k) + b.r * k,
		g: a.g * (1 - k) + b.g * k,
		b: a.b * (1 - k) + b.b * k
	}));
}

// ---------------------------------------------------------------------------
// Contrast-directed lightness search
// ---------------------------------------------------------------------------

/** Which way a foreground has to travel to gain contrast against its plane. */
export type LightnessDirection = "lighter" | "darker";

/** On a dark plane a foreground gains contrast by lightening, and vice versa. */
export function contrastDirection(bgHex: string): LightnessDirection {
	return relativeLuminance(parseHex(bgHex)) < 0.5 ? "lighter" : "darker";
}

/**
 * Moves `hex` along OKLab L, in `direction` only, until it clears `minRatio`
 * against `bgHex` - then stops. Hue is held; chroma is held until the gamut
 * boundary forces it down.
 *
 * Returns the colour unchanged when it already clears the floor, so a palette
 * that is already legible is never "corrected" into something else. When even
 * the endpoint (pure white / pure black at that hue) cannot reach the ratio,
 * the endpoint is returned - the caller's validator reports the shortfall
 * rather than this function pretending it succeeded.
 *
 * Bisection with a fixed iteration count: deterministic by construction.
 */
export function raiseContrast(hex: string, bgHex: string, minRatio: number, direction: LightnessDirection): string {
	if (effectiveContrast(hex, bgHex) >= minRatio) return hex;

	const start = hexToOklch(hex);
	const limit = direction === "lighter" ? 1 : 0;
	const at = (L: number): string => oklchToHex({ L, C: start.C, h: start.h });

	if (effectiveContrast(at(limit), bgHex) < minRatio) return at(limit);

	let lo = start.L; // known to fail
	let hi = limit; // known to pass
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (effectiveContrast(at(mid), bgHex) >= minRatio) hi = mid;
		else lo = mid;
	}
	return at(hi);
}

// ---------------------------------------------------------------------------
// --check: unit tests for this file.
// ---------------------------------------------------------------------------

interface Failure {
	readonly what: string;
	readonly got: string;
	readonly want: string;
}

function runTests(): readonly Failure[] {
	const failures: Failure[] = [];
	const check = (what: string, got: unknown, want: unknown): void => {
		if (String(got) !== String(want)) failures.push({ what, got: String(got), want: String(want) });
	};
	const near = (what: string, got: number, want: number, tolerance: number): void => {
		if (!(Math.abs(got - want) <= tolerance)) {
			failures.push({ what, got: got.toFixed(6), want: `${want} +/- ${tolerance}` });
		}
	};

	// Hex parsing.
	check("parseHex #FFF", formatHexa(parseHex("#FFF")), "#FFFFFF");
	check("parseHex #1c1a18 is case insensitive", formatHex(parseHex("#1c1a18")), "#1C1A18");
	check("parseHex keeps alpha", formatHexa(parseHex("#1C1A18B3")), "#1C1A18B3");
	check("parseHex #RGBA", formatHexa(parseHex("#0008")), "#00000088");
	check("formatHexa drops alpha 1", formatHexa({ r: 1, g: 2, b: 3, alpha: 1 }), "#010203");
	let threw = false;
	try { parseHex("not a colour"); } catch { threw = true; }
	check("parseHex rejects junk", threw, true);

	// Transfer function round-trip.
	for (const v of [0, 0.04, 0.5, 1]) near(`srgb round-trip ${v}`, linearToSrgb(srgbToLinear(v)), v, 1e-12);

	// WCAG anchors: the two values every contrast implementation is checked on.
	near("luminance of white", relativeLuminance({ r: 255, g: 255, b: 255 }), 1, 1e-9);
	near("luminance of black", relativeLuminance({ r: 0, g: 0, b: 0 }), 0, 1e-9);
	near("contrast white/black", contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }), 21, 1e-9);
	near("contrast is symmetric", contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21, 1e-9);
	near("contrast of a colour with itself", contrastRatio({ r: 30, g: 40, b: 50 }, { r: 30, g: 40, b: 50 }), 1, 1e-12);
	// #767676 on white is the canonical "just passes AA" grey from the WCAG techniques.
	near("contrast #767676 on white", effectiveContrast("#767676", "#FFFFFF"), 4.542, 0.001);

	// OKLab anchors from Ottosson's reference values.
	near("oklab L of white", linearToOklab(rgbToLinear({ r: 255, g: 255, b: 255 })).L, 1, 1e-5);
	near("oklab L of black", linearToOklab(rgbToLinear({ r: 0, g: 0, b: 0 })).L, 0, 1e-9);
	const whiteLab = linearToOklab(rgbToLinear({ r: 255, g: 255, b: 255 }));
	near("oklab a of white", whiteLab.a, 0, 1e-5);
	near("oklab b of white", whiteLab.b, 0, 1e-5);
	near("oklab L of mid grey #777777", lightness("#777777"), 0.56926, 0.0001);

	// OKLCH round-trips every 8-bit colour it is handed, exactly.
	const samples = ["#000000", "#FFFFFF", "#FAF9F6", "#131211", "#A8382C", "#8A651C", "#3E5F7E", "#7FB4E8", "#0E1621", "#9CCDAA"];
	for (const hex of samples) check(`oklch round-trip ${hex}`, oklchToHex(hexToOklch(hex)), hex);

	// Hue is held when lightness moves - the CIELAB-blue failure this file avoids.
	const blueHue = hexToOklch("#3E5F7E").h;
	near("hue held when lightened", hexToOklch(withLightness("#3E5F7E", 0.8)).h, blueHue, 0.5);
	near("hue held when darkened", hexToOklch(withLightness("#3E5F7E", 0.25)).h, blueHue, 0.5);
	near("withLightness hits its target", lightness(withLightness("#3E5F7E", 0.62)), 0.62, 0.005);

	// maxChroma finds the wall: just inside is representable, just outside is not.
	for (const [L, h] of [[0.5, 29], [0.8, 85], [0.32, 250]] as const) {
		const cusp = maxChroma(L, h);
		check(`maxChroma(${L}, ${h}) is inside the gamut`, inGamut(oklabToLinear(oklchToOklab({ L, C: cusp, h }))), true);
		check(`maxChroma(${L}, ${h}) is the edge`, inGamut(oklabToLinear(oklchToOklab({ L, C: cusp + 0.01, h }))), false);
	}
	// The cusp collapses at the ends: whatever chroma survives there is below one
	// 8-bit step, so the colour is black or white however it is asked for.
	check("the gamut has no room at black", oklchToHex({ L: 0, C: maxChroma(0, 29), h: 29 }), "#000000");
	check("the gamut has no room at white", oklchToHex({ L: 1, C: maxChroma(1, 85), h: 85 }), "#FFFFFF");

	// Out-of-gamut chroma is reduced, not channel-clipped, so the hue survives.
	const wild = oklchToHex({ L: 0.55, C: 0.9, h: 264 });
	near("gamut mapping holds hue", hexToOklch(wild).h, 264, 3);
	check("gamut mapping stays in gamut", inGamut(oklabToLinear(oklchToOklab(hexToOklch(wild)))), true);

	// Compositing.
	check("opaque composite is a no-op", flattenOver("#A8382C", "#FAF9F6"), "#A8382C");
	check("zero alpha shows the plane", flattenOver("#A8382C00", "#FAF9F6"), "#FAF9F6");
	// Half-alpha black over white lands on #BBBBBB in linear light. A naive
	// blend of the 8-bit values gives #7F7F7F - a completely different colour.
	// That gap IS the reason compositing is done in linear light here.
	check("50% black over white blends in linear light", flattenOver("#00000080", "#FFFFFF"), "#BBBBBB");
	near(
		"effective contrast measures the composited colour",
		effectiveContrast("#00000080", "#FFFFFF"),
		contrastRatio(parseHex(flattenOver("#00000080", "#FFFFFF")), { r: 255, g: 255, b: 255 }),
		1e-12
	);
	check("mixHex endpoints", mixHex("#123456", "#654321", 0), "#123456");
	check("mixHex endpoints", mixHex("#123456", "#654321", 1), "#654321");
	check("mixHexSrgb endpoints", mixHexSrgb("#123456", "#654321", 0), "#123456");
	check("mixHexSrgb endpoints", mixHexSrgb("#123456", "#654321", 1), "#654321");
	// The two mixes are genuinely different spaces; keeping both is the point.
	check("mixHexSrgb halfway is a channel average", mixHexSrgb("#000000", "#FFFFFF", 0.5), "#808080");
	check("mixHex halfway is not", mixHex("#000000", "#FFFFFF", 0.5), "#BCBCBC");

	// Contrast search.
	const lifted = raiseContrast("#3A3733", "#131211", 4.5, "lighter");
	check("raiseContrast reaches its floor", effectiveContrast(lifted, "#131211") >= 4.5, true);
	check("raiseContrast only moves as far as it must", lightness(lifted) < 0.75, true);
	check("raiseContrast leaves a passing colour alone", raiseContrast("#FFFFFF", "#131211", 4.5, "lighter"), "#FFFFFF");
	check("contrastDirection on a dark plane", contrastDirection("#131211"), "lighter");
	check("contrastDirection on a light plane", contrastDirection("#FAF9F6"), "darker");
	// Impossible floors return the endpoint rather than lying about success.
	check("raiseContrast returns the endpoint when the floor is unreachable", raiseContrast("#808080", "#FFFFFF", 21, "darker"), "#000000");

	// Determinism: the generator promises byte-identical output for a given seed.
	check("withLightness is deterministic", withLightness("#7FB4E8", 0.42), withLightness("#7FB4E8", 0.42));
	check("raiseContrast is deterministic", raiseContrast("#807A73", "#131211", 7, "lighter"), raiseContrast("#807A73", "#131211", 7, "lighter"));

	return failures;
}

function selfCheck(): number {
	const failures = runTests();
	if (failures.length > 0) {
		for (const f of failures) console.error(`  color: ${f.what}: got ${f.got}, expected ${f.want}`);
		console.error(`\ncolor: ${failures.length} failing assertion(s)`);
		return 1;
	}
	console.log("color: all assertions pass (hex, sRGB transfer, WCAG contrast, OKLab/OKLCH, compositing, contrast search)");
	return 0;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	process.exit(selfCheck());
}
