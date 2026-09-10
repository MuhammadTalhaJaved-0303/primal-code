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

import {
	compositeOver,
	contrastRatio,
	formatHexColor,
	formatHexaColor,
	inGamut,
	linearToOklab,
	linearToRgb,
	linearToSrgb,
	maxChroma,
	oklabToLinear,
	oklabToOklch,
	oklchToOklab,
	oklchToRgb,
	relativeLuminance,
	rgbToLinear,
	rgbToOklch,
	srgbToLinear,
	tryParseHexColor,
	type LinearRgb,
	type Oklab,
	type Oklch,
	type Rgb,
	type Rgba
} from "../../src/vs/base/common/primalColorScience.ts";

// ---------------------------------------------------------------------------
// Where the maths lives now
// ---------------------------------------------------------------------------
//
// The primitives below used to be implemented in this file. They moved to
// src/vs/base/common/primalColorScience.ts so that the WORKBENCH can compute the
// same verdict at runtime for any theme a user installs - the theme gallery does
// exactly that. There is one implementation; this file re-exports it under the
// names the generator has always used, and keeps the derived helpers and the
// --check suite, which is what verifies the shared code against published
// reference data.
//
// The shared module deliberately has no imports of its own: this file reaches it
// by a relative .ts path under `node --experimental-strip-types`, which cannot
// resolve the `.js` specifiers the rest of src/vs uses.

export type { LinearRgb, Oklab, Oklch, Rgb, Rgba };
export {
	compositeOver,
	contrastRatio,
	inGamut,
	linearToOklab,
	linearToRgb,
	linearToSrgb,
	maxChroma,
	oklabToLinear,
	oklabToOklch,
	oklchToOklab,
	oklchToRgb,
	relativeLuminance,
	rgbToLinear,
	rgbToOklch,
	srgbToLinear
};

/** Formats as uppercase `#RRGGBB`. Alpha is dropped; use `formatHexa` to keep it. */
export const formatHex = formatHexColor;

/** Formats as `#RRGGBB`, or `#RRGGBBAA` when alpha is below 1. */
export const formatHexa = formatHexaColor;

/**
 * Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA`. Throws on anything else - a
 * malformed hex in a palette is a bug in the palette, not something to silently
 * default away. The workbench needs a non-throwing reader instead, so the parse
 * itself lives in the shared module as `tryParseHexColor` and this is its
 * build-time wrapper.
 */
export function parseHex(hex: string): Rgba {
	const parsed = tryParseHexColor(hex);
	if (parsed === undefined) throw new Error(`color: not a hex colour: ${JSON.stringify(hex)}`);
	return parsed;
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

/** Convenience: hex string -> OKLCH, alpha ignored. */
export function hexToOklch(hex: string): Oklch {
	return rgbToOklch(parseHex(hex));
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
