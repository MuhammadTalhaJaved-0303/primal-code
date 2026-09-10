#!/usr/bin/env node --experimental-strip-types
/**
 * Colour-vision-deficiency simulation: protanopia, deuteranopia, tritanopia.
 *
 * The owner of this product is colour blind - amber reads as green to him - so
 * "can the user tell an error from a warning apart" is not a question the theme
 * generator is allowed to answer by eye. It has to be measured, and measuring it
 * means being able to render a colour the way a dichromat sees it.
 *
 * METHOD
 *
 *   Brettel, Viénot & Mollon (1997), "Computerized simulation of color appearance
 *   for dichromats", J. Opt. Soc. Am. A 14(10), pp. 2647-2655.
 *   Viénot, Brettel & Mollon (1999), "Digital video colourmaps for checking the
 *   legibility of displays by dichromats", Color Research & Application 24(4),
 *   pp. 243-252.
 *
 * A dichromat lacks one of the three cone classes, so every colour he can perceive
 * lies on a plane through the origin of LMS cone space, not in the volume. Brettel
 * builds that plane from the neutral axis (the white point) hinged with an anchor
 * stimulus, and projects each colour onto it ALONG the axis of the missing cone -
 * which is precisely the direction the dichromat cannot sense. So:
 *
 *   sRGB -> linear RGB -> LMS -> replace the missing cone's response with the value
 *   the plane dictates for the other two -> LMS -> linear RGB -> sRGB
 *
 * WHY THIS FILE DERIVES ITS MATRICES INSTEAD OF PASTING THEM
 *
 * The projection coefficients are widely circulated as three magic constant pairs,
 * and one of the circulated tritanopia pairs is wrong - it puts pure red on a plane
 * that renders it as yellow, which no tritanope sees. A transcribed constant is a
 * silent, permanent bias in every measurement downstream. So the planes are built
 * here, at load, from the LMS matrix and the anchor stimuli, with cross products;
 * --self-test then checks the derived protanopia and deuteranopia coefficients
 * against the values Viénot et al. published, to four decimal places. If the
 * derivation ever stops agreeing with the paper, that fails loudly.
 *
 * TWO NOTES ON FIDELITY, both deliberate:
 *
 *  - The projection runs in LINEAR light. Viénot's method is defined on linear RGB;
 *    the many JavaScript ports that push gamma-encoded bytes straight into the LMS
 *    matrix are wrong in the direction that makes dark colours look more separable
 *    than they are. We would rather reject a theme we could have shipped than ship
 *    one the owner cannot read.
 *
 *  - Brettel's construction has TWO half-planes per deficiency, hinged on the
 *    neutral axis, because his anchors are monochromatic lights. With display
 *    primaries as anchors the two half-planes coincide exactly - the second anchor
 *    is the complement of the first, so it spans the same plane - and the method
 *    collapses into Viénot's single-plane simplification. That is the simplification
 *    Viénot et al. published for protanopia and deuteranopia, and it is what this
 *    file implements for all three. It is a legibility gate, not a rendering: it is
 *    used only to ask "are these two colours still far apart", and the single-plane
 *    form does not flatter that answer.
 *
 * Pure and dependency-free - primal/theme/validateTheme.ts runs this over every
 * generated theme, and node builtins only is the house rule for primal/*.
 *
 *   node --experimental-strip-types primal/theme/cvd.ts --self-test
 */

/** A colour in sRGB, channels 0..255. Not necessarily integral: simulation output is continuous. */
import {
	applyMatrix3,
	CVD_LINEAR_RGB_FROM_LMS,
	CVD_LMS_FROM_LINEAR_RGB,
	CVD_MISSING_CONE,
	CVD_PLANE_COEFFICIENTS,
	CVD_TYPES,
	linearToSrgb,
	linearTripleToRgb,
	rgbToLinearTriple,
	simulateCvd,
	srgbToLinear,
	type CvdType,
	type Rgb,
	type Vector3
} from "../../src/vs/base/common/primalColorScience.ts";

// ---------------------------------------------------------------------------
// Where the maths lives now
// ---------------------------------------------------------------------------
//
// The derivation described above used to be implemented here. It moved to
// src/vs/base/common/primalColorScience.ts so the WORKBENCH can run the same
// simulation at runtime - the theme gallery scores every installed theme for a
// dichromat, which is the one check the build-time validator could never reach.
// There is one implementation. This file re-exports it under the names the
// generator has always used and keeps the --self-test below, which is what ties
// the derived planes to the published coefficients.

export type { CvdType, Rgb, Vector3 };
export { CVD_TYPES, linearToSrgb, simulateCvd, srgbToLinear };

/** sRGB 0..255 -> linear RGB 0..1. */
export const toLinear = rgbToLinearTriple;

/** linear RGB 0..1 -> sRGB 0..255, clipped to the displayable cube. */
export const fromLinear = linearTripleToRgb;

const LMS_FROM_LINEAR_RGB = CVD_LMS_FROM_LINEAR_RGB;
const LINEAR_RGB_FROM_LMS = CVD_LINEAR_RGB_FROM_LMS;
const MISSING_CONE = CVD_MISSING_CONE;
const PLANE_COEFFICIENTS = CVD_PLANE_COEFFICIENTS;
const apply3 = applyMatrix3;

// ---------------------------------------------------------------------------
// Self-test. Not a substitute for validateTheme.ts's checks: it exists so that a
// broken matrix shows up here, loudly, rather than as a theme that quietly passes.
// ---------------------------------------------------------------------------

/**
 * The coefficients Viénot, Brettel & Mollon (1999) print for the two red-green
 * deficiencies. The derivation above must reproduce them; that is what ties this
 * file to the published method rather than to somebody's blog post.
 */
const VIENOT_PUBLISHED: Readonly<Record<string, readonly [number, number]>> = {
	protanopia: [2.02344, -2.52581], // L = 2.02344 M - 2.52581 S
	deuteranopia: [0.494207, 1.24827], // M = 0.494207 L + 1.24827 S
};

function selfTest(): void {
	const failures: string[] = [];
	const check = (name: string, condition: boolean, detail: string): void => {
		console.log(`  ${condition ? "ok  " : "FAIL"}  ${name} - ${detail}`);
		if (!condition) {
			failures.push(`${name} - ${detail}`);
		}
	};

	// 1. The derived planes agree with the published coefficients.
	for (const [type, published] of Object.entries(VIENOT_PUBLISHED)) {
		const derived = PLANE_COEFFICIENTS[type as CvdType];
		const error = Math.max(Math.abs(derived[0] - published[0]), Math.abs(derived[1] - published[1]));
		check(
			`${type} matches Vienot 1999`,
			error < 5e-5,
			`derived (${derived[0].toFixed(6)}, ${derived[1].toFixed(6)}) vs published (${published[0]}, ${published[1]})`
		);
	}
	console.log(
		`  note  tritanopia plane derived as S = ${PLANE_COEFFICIENTS.tritanopia[0].toFixed(6)} L + ${PLANE_COEFFICIENTS.tritanopia[1].toFixed(6)} M`
	);

	// 2. The computed inverse really is the inverse.
	let worst = 0;
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			const value = [0, 1, 2].reduce((sum, k) => sum + LMS_FROM_LINEAR_RGB[i][k] * LINEAR_RGB_FROM_LMS[k][j], 0);
			worst = Math.max(worst, Math.abs(value - (i === j ? 1 : 0)));
		}
	}
	check("matrix inverse", worst < 1e-9, `max |M M^-1 - I| = ${worst.toExponential(2)}`);

	// 3. The sRGB transfer functions round-trip.
	let transferWorst = 0;
	for (let v = 0; v <= 255; v++) {
		transferWorst = Math.max(transferWorst, Math.abs(linearToSrgb(srgbToLinear(v / 255)) - v / 255));
	}
	check("sRGB transfer round-trip", transferWorst < 1e-12, `max error = ${transferWorst.toExponential(2)}`);

	const dist = (a: Rgb, b: Rgb): number =>
		Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

	// 4. Greys lie on the neutral axis, which is in every plane, so they are fixed points.
	for (const type of CVD_TYPES) {
		let greyWorst = 0;
		for (const v of [0, 32, 64, 128, 192, 255]) {
			const out = simulateCvd({ r: v, g: v, b: v }, type);
			greyWorst = Math.max(greyWorst, Math.abs(out.r - v), Math.abs(out.g - v), Math.abs(out.b - v));
		}
		check(`${type} fixes greys`, greyWorst < 0.6, `max channel shift = ${greyWorst.toFixed(4)}/255`);
	}

	// 5. Anchors are on the plane, so they are fixed points too.
	const anchorSamples: ReadonlyArray<readonly [CvdType, string, Rgb]> = [
		["protanopia", "blue", { r: 0, g: 0, b: 255 }],
		["protanopia", "yellow", { r: 255, g: 255, b: 0 }],
		["deuteranopia", "blue", { r: 0, g: 0, b: 255 }],
		["deuteranopia", "yellow", { r: 255, g: 255, b: 0 }],
		["tritanopia", "red", { r: 255, g: 0, b: 0 }],
		["tritanopia", "cyan", { r: 0, g: 255, b: 255 }],
	];
	for (const [type, label, colour] of anchorSamples) {
		const drift = dist(simulateCvd(colour, type), colour);
		check(`${type} fixes its ${label} anchor`, drift < 0.6, `drift = ${drift.toFixed(4)}/255`);
	}

	// 6. Output must lie on the plane: red-green deficiencies leave only a blue-yellow
	//    axis (R == G), tritanopia only a red-cyan axis (G == B). This is the structural
	//    signature of a correct projection, and it is what makes hue-only distinctions
	//    vanish while lightness differences survive.
	const axisSamples: readonly Rgb[] = [
		{ r: 255, g: 0, b: 0 },
		{ r: 0, g: 255, b: 0 },
		{ r: 255, g: 0, b: 255 },
		{ r: 168, g: 56, b: 44 },
		{ r: 138, g: 101, b: 28 },
		{ r: 76, g: 122, b: 68 },
	];
	for (const type of CVD_TYPES) {
		const collapsed = type === "tritanopia" ? ([1, 2] as const) : ([0, 1] as const);
		const channels = (c: Rgb): readonly number[] => [c.r, c.g, c.b];
		let axisWorst = 0;
		for (const sample of axisSamples) {
			const out = channels(simulateCvd(sample, type));
			// Clipped colours leave the plane by construction; only judge unclipped ones.
			if (out.some((v) => v <= 0.5 || v >= 254.5)) {
				continue;
			}
			axisWorst = Math.max(axisWorst, Math.abs(out[collapsed[0]] - out[collapsed[1]]));
		}
		const axisName = type === "tritanopia" ? "red-cyan (G==B)" : "blue-yellow (R==G)";
		check(`${type} collapses onto ${axisName}`, axisWorst < 1.0, `max channel spread = ${axisWorst.toFixed(4)}/255`);
	}

	// 7. Colours that differ only along the missing cone axis must map to one colour.
	//    This is the definition of a confusion line, and the reason the check exists.
	for (const type of CVD_TYPES) {
		const missing = MISSING_CONE[type];
		const base: Vector3 = apply3(LMS_FROM_LINEAR_RGB, toLinear({ r: 120, g: 120, b: 120 }));
		let confusionWorst = 0;
		for (const delta of [-0.9, -0.3, 0.3, 0.9]) {
			const shifted: [number, number, number] = [base[0], base[1], base[2]];
			shifted[missing] = base[missing] * (1 + delta);
			const rgb = fromLinear(apply3(LINEAR_RGB_FROM_LMS, shifted));
			// Skip perturbations that fall outside the display gamut and get clipped.
			const linear = apply3(LINEAR_RGB_FROM_LMS, shifted);
			if (linear.some((v) => v < 0 || v > 1)) {
				continue;
			}
			confusionWorst = Math.max(confusionWorst, dist(simulateCvd(rgb, type), simulateCvd({ r: 120, g: 120, b: 120 }, type)));
		}
		check(`${type} merges its confusion line`, confusionWorst < 1.0, `max residual = ${confusionWorst.toFixed(4)}/255`);
	}

	// 8. Simulation is idempotent: a colour already on the plane stays there.
	for (const type of CVD_TYPES) {
		let idemWorst = 0;
		for (const sample of axisSamples) {
			const once = simulateCvd(sample, type);
			idemWorst = Math.max(idemWorst, dist(once, simulateCvd(once, type)));
		}
		check(`${type} is idempotent`, idemWorst < 1.0, `max re-simulation drift = ${idemWorst.toFixed(4)}/255`);
	}

	if (failures.length > 0) {
		console.error(`\ncvd self-test FAILED (${failures.length}):`);
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exit(1);
	}
	console.log("\ncvd self-test passed.");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	if (process.argv.includes("--self-test")) {
		selfTest();
	} else {
		console.error("cvd.ts is a library. Run it with --self-test to verify the colour maths.");
		process.exit(2);
	}
}
