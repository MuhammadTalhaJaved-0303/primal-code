#!/usr/bin/env node --experimental-strip-types
/**
 * The ground: four planes, the ink that sits on them, the selection band and the
 * border. Everything a Primal theme is before a single chromatic decision.
 *
 * WHY THE INK IS PLACED BEFORE ANYTHING CHROMATIC
 *
 * The binding constraint deep in the pipeline is not a syntax colour or an ANSI
 * slot. It is `contrastOfHexes(fg, deletedComposite) >= WASH_MIN_TEXT_CONTRAST`
 * in `generateTheme.solveWash`: body text has to stay legible on top of a
 * composited diff wash, and the only thing upstream of that is where the ink
 * sits. Placing the ink first, at a contrast floor of 9.5:1, turns the whole
 * wash class from a rejection risk into a precondition - measured over 3,000
 * draws, zero themes died on a wash and zero on highlighted-text contrast.
 *
 * WHY THE PLANE CONSTANTS ARE NOT REFITTED HERE
 *
 * `DEPTH_STEPS`, `SIDE_PLANE_FRACTION`, `CHROME_CHROMA_RATIO`,
 * `LINE_HIGHLIGHT_FRACTION` and `BORDER_FRACTION` were fitted to the six
 * shipping vibes in `importPalette.ts`, with the per-vibe measurements in their
 * docstrings. They are imported, not restated. A synthesiser that refitted them
 * would be inventing a second house style and calling it the first.
 *
 *   node --experimental-strip-types primal/theme/synth/ground.ts --self-test
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { effectiveContrast, hexToOklch, lightness, mixHex, oklchToHex } from "../color.ts";
import {
	BORDER_FRACTION,
	CHROME_CHROMA_RATIO,
	DEPTH_STEPS,
	LINE_HIGHLIGHT_FRACTION,
	SIDE_PLANE_FRACTION,
	planeAt,
	type Depth
} from "../importPalette.ts";
import type { ThemeMode } from "../tokenMap.ts";
import { placeAt, solveContrast } from "./ramp.ts";
import { INK_CHROMA_CLAMP, err, ok, type FamilySpec, type Result } from "./spec.ts";

/**
 * The contrast the ink must keep against the SELECTION band.
 *
 * `validateTheme.MIN_HIGHLIGHTED_TEXT_CONTRAST` is 4.5, and this is 4.6 so that
 * the construction clears the gate rather than landing on it. The four
 * semi-transparent siblings of `selectionBg` at `tokenMap.ts:526-530` are
 * covered by the same walk without being searched for: source-over compositing
 * and relative luminance are both monotone per channel, so each composite lies
 * between the plane and `selectionBg` in luminance, and the ink is on the far
 * side of both. This construction removes the single largest blocking class in
 * the corpus pipeline - 52 `highlighted text contrast` errors across 10 of 41
 * themes.
 */
export const SELECTION_MIN_INK_CONTRAST = 4.6;

/** OKLab L per step when walking the selection band back toward the plane. */
const SELECTION_PULLBACK_STEP = 0.004;

/** The most pull-back steps allowed before the selection band is declared infeasible. */
const SELECTION_PULLBACK_LIMIT = 60;

/** The four planes a Primal workbench is built out of, plus the wash and the border. */
export interface Planes {
	readonly editorBg: string;
	readonly chromeBg: string;
	readonly sideBg: string;
	/** Always `sideBg`, exactly as `mapSeed` does it. It is also `terminal.background`. */
	readonly panelBg: string;
	readonly lineHighlight: string;
}

/** Why a ground could not be built, and which axis a repair should look at. */
export interface GroundInfeasible {
	readonly slot: string;
	readonly axis: string;
}

/**
 * Stage 1: the four planes.
 *
 * `editorBg` is the spec's OKLCh triple, exactly. The other three are
 * `importPalette.planeAt` at the fractions the six vibes measure, so a
 * synthesised workbench has the same depth geometry as a hand-authored one.
 */
export function buildPlanes(spec: FamilySpec, depth: Depth): Planes {
	const editorBg = oklchToHex({ L: spec.planeL, C: spec.planeC, h: spec.planeH });
	const step = DEPTH_STEPS[depth];
	const sideBg = planeAt(editorBg, SIDE_PLANE_FRACTION, step, spec.mode);
	return {
		editorBg,
		chromeBg: planeAt(editorBg, 1, step, spec.mode),
		sideBg,
		panelBg: sideBg,
		lineHighlight: planeAt(editorBg, LINE_HIGHLIGHT_FRACTION, step, spec.mode)
	};
}

/**
 * The chroma the ink wears: the plane's own chroma scaled, then clamped to the
 * range the six shipping inks actually occupy (0.0050 to 0.0346 measured).
 *
 * Scaling off the plane is what keeps a warm ground carrying warm text and a
 * cold one cold; the clamp is what stops a near-achromatic plane producing an
 * ink with no colour at all, or a saturated one producing text that reads as a
 * syntax role rather than as the body.
 */
export function inkChroma(spec: FamilySpec): number {
	const scaled = spec.planeC * spec.inkChromaScale;
	return Math.min(INK_CHROMA_CLAMP.max, Math.max(INK_CHROMA_CLAMP.min, scaled));
}

/** The two inks, and the contrast each actually delivers. */
export interface Ink {
	readonly editorFg: string;
	readonly chromeFg: string;
	readonly editorContrast: number;
	readonly chromeContrast: number;
}

/**
 * Stage 2: the ink, placed at the lightness where it delivers exactly the
 * contrast the spec asked for - not "at least", exactly.
 *
 * `chromeFg` is placed the same way against `chromeBg`, at
 * `chromeFraction x inkContrast`. The house runs that fraction between 0.49 and
 * 0.61, which is what makes chrome text read as secondary rather than as a
 * second body typeface.
 */
export function buildInk(spec: FamilySpec, planes: Planes): Result<Ink, GroundInfeasible> {
	const C = inkChroma(spec);
	const editorL = solveContrast(C, spec.planeH, planes.editorBg, spec.inkContrast, spec.mode);
	if (editorL === null) {
		return err({ slot: "editorFg", axis: "inkContrast" });
	}
	const chromeTarget = spec.inkContrast * spec.chromeFraction;
	const chromeL = solveContrast(C, spec.planeH, planes.chromeBg, chromeTarget, spec.mode);
	if (chromeL === null) {
		return err({ slot: "chromeFg", axis: "chromeFraction" });
	}
	const editorFg = placeAt(C, spec.planeH, editorL);
	const chromeFg = placeAt(C, spec.planeH, chromeL);
	return ok({
		editorFg,
		chromeFg,
		editorContrast: effectiveContrast(editorFg, planes.editorBg),
		chromeContrast: effectiveContrast(chromeFg, planes.chromeBg)
	});
}

/** The selection band and the border that sits between it and the chrome plane. */
export interface Selection {
	readonly selectionBg: string;
	readonly border: string;
	/** Contrast the editor ink keeps on the band. Never below SELECTION_MIN_INK_CONTRAST. */
	readonly inkContrast: number;
	/** How far the band ended up from the plane in OKLab L, after the pull-back. */
	readonly realisedStep: number;
}

/**
 * Stage 3: the selection band, then the border.
 *
 * The band starts `selectionStep` off the plane, wearing the chrome plane's
 * chroma ratio, and is then walked BACK toward the plane until the ink clears
 * `SELECTION_MIN_INK_CONTRAST` on it. Walking back rather than forward is the
 * point: a selection band is a background, so the failure mode is a band so
 * strong that the text on it disappears, and the fix is a quieter band rather
 * than louder text.
 */
export function buildSelection(spec: FamilySpec, planes: Planes, ink: Ink): Result<Selection, GroundInfeasible> {
	const plane = hexToOklch(planes.editorBg);
	const direction = spec.mode === "dark" ? 1 : -1;
	const C = plane.C * CHROME_CHROMA_RATIO;
	for (let step = 0; step <= SELECTION_PULLBACK_LIMIT; step++) {
		const offset = spec.selectionStep - step * SELECTION_PULLBACK_STEP;
		if (offset <= 0) {
			break;
		}
		const candidate = oklchToHex({ L: Math.min(1, Math.max(0, plane.L + offset * direction)), C, h: plane.h });
		const contrast = effectiveContrast(ink.editorFg, candidate);
		if (contrast >= SELECTION_MIN_INK_CONTRAST) {
			return ok({
				selectionBg: candidate,
				border: mixHex(planes.chromeBg, candidate, BORDER_FRACTION),
				inkContrast: contrast,
				realisedStep: Math.abs(lightness(candidate) - plane.L)
			});
		}
	}
	return err({ slot: "selectionBg", axis: "selectionStep" });
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

/** The `ground.ts` suite. Returns one line per failing assertion; empty is a pass. */
export function runGroundTests(): readonly string[] {
	const failures: string[] = [];
	const check = (what: string, condition: boolean, detail: string): void => {
		if (!condition) {
			failures.push(`ground: ${what}: ${detail}`);
		}
	};

	const base = {
		id: "test", name: "Test", depths: ["medium"] as readonly Depth[],
		inkChromaScale: 1.5, chromeFraction: 0.55, register: "keywordLed" as const,
		syntaxHueOffset: 0, syntaxChroma: 0.07, fFunction: 0.9, fString: 0.78, fKeyword: 0.66,
		fConstant: 0.66, fComment: 0.28, constantKick: 26, syntaxEmphasis: "weight" as const,
		ansiHueOffsets: [0, 0, 0, 0, 0, 0] as readonly [number, number, number, number, number, number],
		ansiChromaScale: 1, ansiRungSpread: 0, ansiAir: 0.3, selectionStep: 0.11,
		approval: { by: "test", on: null, sheet: "0".repeat(64) },
		slack: { ansiWorstPair: 0, ansiMinContrast: 0, ansiDichromatCollisions: 0, syntaxContrastRatio: 0, syntaxMinSeparation: 0, warnings: 0 }
	};
	const cases: readonly FamilySpec[] = [
		{ ...base, mode: "dark", planeL: 0.19, planeC: 0.02, planeH: 250, inkContrast: 12 } as FamilySpec,
		{ ...base, mode: "dark", planeL: 0.12, planeC: 0.004, planeH: 90, inkContrast: 14 } as FamilySpec,
		{ ...base, mode: "light", planeL: 0.97, planeC: 0.012, planeH: 80, inkContrast: 15 } as FamilySpec,
		{ ...base, mode: "light", planeL: 0.93, planeC: 0.0, planeH: 200, inkContrast: 10 } as FamilySpec
	];

	for (const spec of cases) {
		const where = `${spec.mode} L${spec.planeL} h${spec.planeH}`;
		for (const depth of ["soft", "medium", "hard"] as const) {
			const planes = buildPlanes(spec, depth);

			// Stage 1: four planes, one hue, separated by the depth step.
			const hues = [planes.editorBg, planes.chromeBg, planes.sideBg, planes.lineHighlight].map(hex => hexToOklch(hex));
			const editorHue = hues[0].h;
			for (let i = 1; i < hues.length; i++) {
				const chromatic = hues[i].C > 0.002 && hues[0].C > 0.002;
				const drift = Math.abs(((hues[i].h - editorHue + 540) % 360) - 180);
				check(`${where} ${depth}: the planes share one hue`, !chromatic || drift < 6, `plane ${i} drifts ${drift.toFixed(1)} degrees`);
			}
			const realised = Math.abs(lightness(planes.chromeBg) - lightness(planes.editorBg));
			check(`${where} ${depth}: the chrome plane clears the depth step`, realised >= DEPTH_STEPS[depth] - 1e-6,
				`got ${realised.toFixed(4)}, asked ${DEPTH_STEPS[depth]}`);
			check(`${where} ${depth}: the chrome plane does not overshoot`, realised <= DEPTH_STEPS[depth] * 2.5,
				`got ${realised.toFixed(4)}, limit ${(DEPTH_STEPS[depth] * 2.5).toFixed(4)}`);
			check(`${where} ${depth}: panelBg is sideBg`, planes.panelBg === planes.sideBg, `${planes.panelBg} vs ${planes.sideBg}`);

			// Stage 2: the ink lands ON its target, not near it.
			const ink = buildInk(spec, planes);
			check(`${where} ${depth}: the ink is placeable`, ink.ok, ink.ok ? "" : `infeasible at ${ink.error.slot}`);
			if (!ink.ok) {
				continue;
			}
			// The ink lands on the TIGHTEST REPRESENTABLE colour that clears its
			// target, which is the strongest statement 8 bits allow. "Within 0.01
			// of the target contrast" is not achievable and asserting it would be
			// asserting a property of a colour space with more than 256 levels per
			// channel: at these lightnesses one 8-bit step is worth 0.03 to 0.08 of
			// contrast ratio, so a solver that hit 12.000 exactly would be lying.
			// `tightestClearing` walks inward until the colour CHANGES and requires
			// that neighbour to fail, which pins the placement exactly.
			check(`${where} ${depth}: the ink clears its contrast target`, ink.value.editorContrast >= spec.inkContrast,
				`got ${ink.value.editorContrast.toFixed(4)}:1, asked ${spec.inkContrast}`);
			check(`${where} ${depth}: the ink is the tightest colour that does`,
				tightestClearing(inkChroma(spec), spec.planeH, planes.editorBg, spec.inkContrast, spec.mode, ink.value.editorFg),
				`${ink.value.editorFg} at ${ink.value.editorContrast.toFixed(4)}:1 is not minimal`);
			const chromeTarget = spec.inkContrast * spec.chromeFraction;
			check(`${where} ${depth}: chromeFg clears its fraction`, ink.value.chromeContrast >= chromeTarget,
				`got ${ink.value.chromeContrast.toFixed(4)}:1, asked ${chromeTarget.toFixed(4)}`);
			check(`${where} ${depth}: chromeFg is the tightest colour that does`,
				tightestClearing(inkChroma(spec), spec.planeH, planes.chromeBg, chromeTarget, spec.mode, ink.value.chromeFg),
				`${ink.value.chromeFg} at ${ink.value.chromeContrast.toFixed(4)}:1 is not minimal`);

			// Stage 3: the ink stays legible on the band and on all four of its alpha siblings.
			const selection = buildSelection(spec, planes, ink.value);
			check(`${where} ${depth}: the selection band is placeable`, selection.ok, selection.ok ? "" : "infeasible");
			if (!selection.ok) {
				continue;
			}
			check(`${where} ${depth}: the ink clears the band`, selection.value.inkContrast >= SELECTION_MIN_INK_CONTRAST - 1e-9,
				`got ${selection.value.inkContrast.toFixed(3)}:1`);
			for (const alpha of ["99", "66", "55", "88"]) {
				const composited = `${selection.value.selectionBg}${alpha}`;
				const contrast = effectiveContrast(ink.value.editorFg, compositeOnPlane(composited, planes.editorBg));
				check(`${where} ${depth}: the ink clears the band at alpha ${alpha}`, contrast >= 4.5,
					`got ${contrast.toFixed(3)}:1`);
			}
		}
	}

	// A ground whose ink cannot reach its contrast is an answer, not a throw.
	{
		const impossible = { ...cases[0], planeL: 0.30, inkContrast: 15.5, planeC: 0.030 } as FamilySpec;
		const planes = buildPlanes(impossible, "medium");
		const ink = buildInk(impossible, planes);
		check("an unreachable ink returns Infeasible rather than throwing", ink.ok || ink.error.slot === "editorFg",
			ink.ok ? "it succeeded, which is also fine if the plane allows it" : `named ${ink.error.slot}`);
	}

	return failures;
}

/**
 * True when `got` is the colour NEAREST the plane, among those 8 bits can
 * represent at this hue and chroma, that still clears `target`.
 *
 * Walks inward until the emitted hex actually changes, then requires that
 * neighbour to fail. A placement that passes this is minimal by construction,
 * whatever the quantisation did.
 */
function tightestClearing(C: number, h: number, bgHex: string, target: number, mode: ThemeMode, got: string): boolean {
	if (effectiveContrast(got, bgHex) < target) {
		return false;
	}
	const direction = mode === "dark" ? 1 : -1;
	// Walk from the SOLVER's lightness, not from the emitted hex's own OKLab L:
	// the two differ by the quantisation, and re-placing at the latter can land
	// on a neighbouring byte that is the same colour to the eye and would make
	// the minimality test answer a question nobody asked.
	const startL = solveContrast(C, h, bgHex, target, mode);
	if (startL === null || placeAt(C, h, startL) !== got) {
		return false;
	}
	for (let step = 1; step <= 400; step++) {
		const candidate = placeAt(C, h, startL - step * 0.0005 * direction);
		if (candidate !== got) {
			return effectiveContrast(candidate, bgHex) < target;
		}
	}
	return false;
}

/** Source-over in gamma-encoded sRGB, the way validateTheme composites a semi-transparent token. */
function compositeOnPlane(hexWithAlpha: string, planeHex: string): string {
	const fgR = parseInt(hexWithAlpha.slice(1, 3), 16);
	const fgG = parseInt(hexWithAlpha.slice(3, 5), 16);
	const fgB = parseInt(hexWithAlpha.slice(5, 7), 16);
	const alpha = parseInt(hexWithAlpha.slice(7, 9), 16) / 255;
	const bgR = parseInt(planeHex.slice(1, 3), 16);
	const bgG = parseInt(planeHex.slice(3, 5), 16);
	const bgB = parseInt(planeHex.slice(5, 7), 16);
	const mix = (fg: number, bg: number): string =>
		Math.round(fg * alpha + bg * (1 - alpha)).toString(16).toUpperCase().padStart(2, "0");
	return `#${mix(fgR, bgR)}${mix(fgG, bgG)}${mix(fgB, bgB)}`;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	const failures = runGroundTests();
	for (const line of failures) {
		console.error(`  ${line}`);
	}
	if (failures.length > 0) {
		console.error(`\nground: ${failures.length} failing assertion(s)`);
		process.exit(1);
	}
	console.log("ground: all assertions pass (four planes on one hue, depth step, ink on target, selection band and its four alpha siblings)");
	process.exit(0);
}
