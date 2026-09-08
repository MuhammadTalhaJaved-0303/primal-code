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
export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

export type CvdType = "protanopia" | "deuteranopia" | "tritanopia";

/** The three dichromacies, in the order reports should list them. */
export const CVD_TYPES: readonly CvdType[] = ["protanopia", "deuteranopia", "tritanopia"];

type Vector3 = readonly [number, number, number];
type Matrix3 = readonly [Vector3, Vector3, Vector3];

/**
 * Linear RGB -> LMS cone response.
 *
 * Smith & Pokorny cone fundamentals as tabulated by Viénot et al. (1999) for a
 * standard display primary set. The absolute scale is arbitrary and cancels: the
 * pipeline goes straight back out through the inverse.
 */
const LMS_FROM_LINEAR_RGB: Matrix3 = [
	[17.8824, 43.5161, 4.11935],
	[3.45565, 27.1554, 3.86714],
	[0.0299566, 0.184309, 1.46709],
];

/** Which cone is missing, as an index into an LMS triple. */
const MISSING_CONE: Readonly<Record<CvdType, 0 | 1 | 2>> = {
	protanopia: 0, // no L cone
	deuteranopia: 1, // no M cone
	tritanopia: 2, // no S cone
};

/**
 * The anchor stimulus each dichromatic plane is hinged to, in linear RGB.
 *
 * Brettel's anchors are monochromatic lights: 475nm and 575nm for protanopes and
 * deuteranopes, 485nm and 660nm for tritanopes. The nearest thing a display can
 * actually emit is its own primaries, and each anchor pair reduces to one plane:
 * blue and yellow for the red-green deficiencies, red and cyan for tritanopia.
 * Only one of each pair is needed - the other is its complement about the white
 * point and spans the same plane.
 */
const PLANE_ANCHOR: Readonly<Record<CvdType, Vector3>> = {
	protanopia: [0, 0, 1], // blue primary
	deuteranopia: [0, 0, 1], // blue primary
	tritanopia: [1, 0, 0], // red primary
};

function invert3(m: Matrix3): Matrix3 {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		throw new Error(`cvd: cone-response matrix is singular (det=${det}); cannot invert`);
	}
	return [
		[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
		[(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
		[(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
	];
}

function apply3(m: Matrix3, v: Vector3): Vector3 {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

function cross(a: Vector3, b: Vector3): Vector3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const LINEAR_RGB_FROM_LMS: Matrix3 = invert3(LMS_FROM_LINEAR_RGB);

/** LMS of equal-energy display white: the neutral axis every dichromatic plane contains. */
const WHITE_LMS: Vector3 = apply3(LMS_FROM_LINEAR_RGB, [1, 1, 1]);

/**
 * The two coefficients that reconstruct the missing cone's response from the other
 * two, i.e. the equation of the dichromatic plane, solved for the missing axis.
 *
 * The plane through the origin containing white and the anchor has normal
 * n = white x anchor. Requiring n . lms = 0 and holding the two present cone
 * responses fixed gives the missing one as a linear combination of them.
 */
function derivePlaneCoefficients(type: CvdType): readonly [number, number] {
	const missing = MISSING_CONE[type];
	const anchorLms = apply3(LMS_FROM_LINEAR_RGB, PLANE_ANCHOR[type]);
	const normal = cross(WHITE_LMS, anchorLms);
	if (Math.abs(normal[missing]) < 1e-9) {
		throw new Error(
			`cvd: the ${type} plane is parallel to the missing cone axis; anchor ${PLANE_ANCHOR[type].join()} cannot define it`
		);
	}
	const present = [0, 1, 2].filter((i) => i !== missing) as [number, number];
	return [-normal[present[0]] / normal[missing], -normal[present[1]] / normal[missing]];
}

const PLANE_COEFFICIENTS: Readonly<Record<CvdType, readonly [number, number]>> = {
	protanopia: derivePlaneCoefficients("protanopia"),
	deuteranopia: derivePlaneCoefficients("deuteranopia"),
	tritanopia: derivePlaneCoefficients("tritanopia"),
};

/** sRGB electro-optical transfer function (IEC 61966-2-1). Channel in 0..1. */
export function srgbToLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Inverse of srgbToLinear. Channel in 0..1. */
export function linearToSrgb(channel: number): number {
	return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** sRGB 0..255 -> linear RGB 0..1. */
export function toLinear(rgb: Rgb): Vector3 {
	return [
		srgbToLinear(clamp01(rgb.r / 255)),
		srgbToLinear(clamp01(rgb.g / 255)),
		srgbToLinear(clamp01(rgb.b / 255)),
	];
}

/** linear RGB 0..1 -> sRGB 0..255, clipped to the displayable cube. */
export function fromLinear(linear: Vector3): Rgb {
	return {
		r: clamp01(linearToSrgb(clamp01(linear[0]))) * 255,
		g: clamp01(linearToSrgb(clamp01(linear[1]))) * 255,
		b: clamp01(linearToSrgb(clamp01(linear[2]))) * 255,
	};
}

/** Project an LMS triple onto the plane a dichromat of this type can see. */
function projectLms(lms: Vector3, type: CvdType): Vector3 {
	const missing = MISSING_CONE[type];
	const [first, second] = PLANE_COEFFICIENTS[type];
	const present = [0, 1, 2].filter((i) => i !== missing) as [number, number];
	const replaced = first * lms[present[0]] + second * lms[present[1]];
	const out: [number, number, number] = [lms[0], lms[1], lms[2]];
	out[missing] = replaced;
	return out;
}

/**
 * Render `rgb` as a dichromat of the given type sees it.
 *
 * Returns a new colour; the input is never touched. Output channels are continuous
 * (not rounded) so perceptual distances measured on simulated colours are not
 * quantised by an 8-bit round trip.
 */
export function simulateCvd(rgb: Rgb, type: CvdType): Rgb {
	const lms = apply3(LMS_FROM_LINEAR_RGB, toLinear(rgb));
	return fromLinear(apply3(LINEAR_RGB_FROM_LMS, projectLms(lms, type)));
}

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
