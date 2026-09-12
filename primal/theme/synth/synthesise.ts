#!/usr/bin/env node --experimental-strip-types
/**
 * spec + depth -> a complete Primal seed, a theme, and the proof that it holds.
 *
 * IT RETURNS A RESULT. IT NEVER THROWS ON THE BUILD PATH.
 *
 * Feasibility here is a greedy sixteen-slot packing over 120 CIEDE2000 pairs in
 * a non-convex gamut, then a semantic ladder solve, then six composited washes,
 * then twenty highlight checks. There is no closed form for "will this spec
 * work", so there is no `admits(spec)` predicate anywhere in this file - the
 * only honest one is "call `synthesise` and read the answer". Every failure
 * comes back as an `Infeasible` naming the stage, the slot and the axis a repair
 * should move, so `--repair` has somewhere to go and `buildCatalogue` can
 * collect every broken family into one report rather than throwing on the first.
 *
 * READABILITY IS A CONSTRUCTION, NOT A REJECTION SAMPLE.
 *
 * Every ink in here starts at its own contrast frontier and only ever moves
 * further from the plane. Every ANSI slot is placed against every slot already
 * placed, measured with `perceptualDistanceOfHex` - the gate's own function, on
 * the emitted hex - so the generator and the gate compute the identical number.
 * The validator at the end is confirming, not deciding.
 *
 * SYNTAX HUE IS NOT FREE, AND THAT IS THE MEASUREMENT MOST LIKELY TO SURPRISE.
 *
 * The six shipping vibes hold every chromatic syntax slot within 38 degrees of
 * the editor plane's OWN hue (ink 0, basalt 0, ridge 7, fern 26, tide 35, dusk
 * 38) and separate the roles by CHROMA and LIGHTNESS. Five of the six chromatic
 * roles share one hue to within 4 degrees, with exactly one role kicked out by
 * 26 to 30 degrees. A generator with a free 360-degree syntax wheel produces
 * three times as many "families" and none of them are Primal themes: it makes a
 * blue ground with orange keywords, which no vibe in the product has ever
 * shipped. So the wheel is locked to the plane and the identity is carried by
 * `register` - which roles alias, and how loud the survivors are.
 *
 *   node --experimental-strip-types primal/theme/synth/synthesise.ts --self-test
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OBSERVERS, perceptualDistance } from "../../../src/vs/base/common/primalColorScience.ts";
import { effectiveContrast, hexToOklch, lightness, parseHex } from "../color.ts";
import { CVD_TYPES } from "../cvd.ts";
import { expandSeed, type ColorTheme, type SemanticLadder, type Seed } from "../generateTheme.ts";
import { ANSI_MIN_CONTRAST, ANSI_MIN_SEPARATION, type Depth } from "../importPalette.ts";
import type { SeedSlotId, ThemeMode } from "../tokenMap.ts";
import { perceptualDistanceOfHex, validate } from "../validateTheme.ts";
import { buildInk, buildPlanes, buildSelection, type Ink, type Planes } from "./ground.ts";
import { placeAt, solveContrast, solveRamp, type RampSlot } from "./ramp.ts";
import {
	ANSI_CHROMATIC_NAMES,
	HOUSE_ANSI_CHROMA,
	HOUSE_ANSI_HUE,
	err,
	ok,
	type FamilySpec,
	type Register,
	type Result,
	type SlackReport
} from "./spec.ts";

// ---------------------------------------------------------------------------
// Constants of the construction
// ---------------------------------------------------------------------------

/**
 * The contrast floor every chromatic syntax ink starts at.
 *
 * `validateTheme.MIN_SYNTAX_CONTRAST_WARN` is 4.5; this is 4.6 so the
 * construction clears the gate rather than landing on it, and so that quantising
 * to 8 bits cannot push a slot back across the line.
 */
export const SYNTAX_MIN_CONTRAST = 4.6;

/**
 * The contrast floor for `comment`, and it is DELIBERATELY BELOW the 4.5 warn
 * line.
 *
 * All six shipping vibes warn on comment contrast - measured 3.24 (basalt), 3.29
 * (tide), 3.33 (dusk), 3.41 (fern), 4.15 (ridge), 4.41 (ink). A synthesiser that
 * "did better" than the product would ship comments that shout, and a comment
 * that shouts is a comment the reader's eye cannot skip. Matching the house
 * means accepting a warning; `validateTheme.MIN_COMMENT_CONTRAST_ERROR` is 3.0
 * and that is the line that must not be crossed.
 */
export const COMMENT_MIN_CONTRAST = 3.2;

/**
 * How far two syntax roles that are NOT aliased must sit apart, in dE00 under
 * the worst of the four observers.
 *
 * 2.3 is the repo's own quoted just-noticeable difference for ordinary viewing
 * (`validateTheme.ts:98-101`). Two roles closer than that are one role wearing
 * two names, and once the generator owns all seven slots nothing else in the
 * tree would notice.
 *
 * ALIASED PAIRS ARE EXEMPT, and that is not a loophole. The house aliases
 * deliberately and identically in every vibe - `keyword = type = operator =
 * accent = editorFg` for the ink-led register, `function = type` and `accent =
 * keyword` for the keyword-led one - so an aliased pair is a declared decision,
 * not a collision. `validateTheme` reports every close pair including the
 * identical ones, as a WARNING, because the shipping vibes would fail an
 * error-level check on day one; this file asserts the non-aliased pairs as an
 * ERROR, because a synthesised family has no such history to respect.
 */
export const SYNTAX_MIN_SEPARATION = 2.3;

/**
 * The widest a family's loudest syntax ink may be over its quietest, as a ratio
 * of contrast.
 *
 * Ink's own 16.48:1 body against its 5.47:1 quietest role is 3.01, and it is the
 * widest register the house goes. Past that the palette stops reading as one
 * voice at different volumes and starts reading as two typefaces.
 */
export const SYNTAX_CONTRAST_SPREAD_LIMIT = 3.2;

/**
 * The least chroma a slot may retain of what it asked for.
 *
 * A slot flattened against the gamut wall has not been placed, it has been
 * ground down: `ansiRed` at 0.4 of its requested chroma is not a red any more,
 * it is a dull pink that happens to clear a contrast floor. The same number as
 * `generateTheme.WASH_MIN_CHROMA_RETENTION`, for the same reason.
 */
export const MIN_CHROMA_RETENTION = 0.67;

/** ANSI neutrals never carry more chroma than this, whatever the plane does. */
const ANSI_NEUTRAL_MAX_CHROMA = 0.02;

/** The seven syntax slots, in the order the report prints them. */
export const SYNTAX_SLOTS: readonly SeedSlotId[] =
	["keyword", "string", "function", "comment", "type", "constant", "operator"];

// ---------------------------------------------------------------------------
// Infeasibility
// ---------------------------------------------------------------------------

/** Which part of the construction ran out of room. */
export type Stage = "ground" | "syntax" | "ramp" | "taste" | "ladder" | "validator" | "postcondition";

/**
 * A spec that cannot become a theme, and where to look.
 *
 * `axis` names a field of `FamilySpec` that a bounded, deterministic repair walk
 * may move. The tension between the two commonest failures is real and worth
 * stating out loud: ramp infeasibility wants `ansiChromaScale` DOWN, ladder
 * infeasibility wants it UP. A family pinned between the two has no repair and
 * must be dropped by a human.
 */
export interface Infeasible {
	readonly stage: Stage;
	/** The slot, pair or check that failed. */
	readonly slot: string;
	/** The spec field a repair should move first. */
	readonly axis: string;
	/** One line, for the catalogue error report. */
	readonly detail: string;
}

/**
 * The bounded repair ladder, per stage. `--repair` walks it in order, inside the
 * spec's own box, and writes the changed spec as a reviewable diff. It never
 * runs at build time and never runs automatically.
 */
export const REPAIR_LADDER: Readonly<Record<Stage, readonly string[]>> = {
	ground: ["inkContrast", "planeL"],
	syntax: ["syntaxChroma", "fFunction", "fString", "fConstant", "fComment"],
	ramp: ["ansiChromaScale", "ansiAir", "ansiRungSpread", "planeL"],
	taste: ["ansiChromaScale", "fComment", "syntaxChroma"],
	ladder: ["ansiChromaScale", "planeL"],
	validator: ["ansiChromaScale", "planeL"],
	postcondition: ["ansiAir", "syntaxChroma", "fConstant"]
};

// ---------------------------------------------------------------------------
// Stage 4: the syntax palette
// ---------------------------------------------------------------------------

/** One placed syntax role. */
interface SyntaxRole {
	readonly slot: SeedSlotId;
	/** Contrast as a fraction of `inkContrast`. */
	readonly f: number;
	/** Chroma as a fraction of `syntaxChroma`. */
	readonly c: number;
	/** True for the one role the house kicks off the shared hue. */
	readonly kicked: boolean;
}

/**
 * Which roles each register PLACES, and at what volume. Everything not listed is
 * an alias; see `ALIASES`.
 *
 * The fractions are the spec's, the chroma multipliers are the house's, measured
 * off the six shipping vibes. `constant` is the role every vibe kicks off the
 * shared hue - tide by -26 degrees, dusk by +30, fern by +29 - and it is the
 * only role that ever leaves it.
 */
function placedRoles(spec: FamilySpec): readonly SyntaxRole[] {
	if (spec.register === "inkLed") {
		return [
			{ slot: "function", f: spec.fFunction, c: 1.00, kicked: false },
			{ slot: "string", f: spec.fString, c: 0.75, kicked: false },
			{ slot: "constant", f: spec.fConstant, c: 0.90, kicked: true },
			{ slot: "comment", f: spec.fComment, c: 0.80, kicked: false }
		];
	}
	return [
		{ slot: "function", f: spec.fFunction, c: 0.55, kicked: false },
		{ slot: "string", f: spec.fString, c: 0.75, kicked: false },
		{ slot: "keyword", f: spec.fKeyword ?? 0, c: 1.00, kicked: false },
		{ slot: "constant", f: spec.fConstant, c: 0.85, kicked: true },
		{ slot: "comment", f: spec.fComment, c: 0.78, kicked: false }
	];
}

/**
 * The alias table: which slot each register makes equal to which other.
 *
 * Measured, not chosen. Every shipping vibe has a byte-identical syntax pair and
 * there are exactly two patterns; reproducing them is what makes a synthesised
 * palette read as Primal rather than as a rainbow.
 */
export const ALIASES: Readonly<Record<Register, Readonly<Record<string, SeedSlotId | "editorFg">>>> = {
	inkLed: { keyword: "editorFg", type: "editorFg", operator: "editorFg", accent: "editorFg" },
	keywordLed: { operator: "editorFg", type: "function", accent: "keyword" }
};

/** The seven syntax slots plus `accent`, and what each one actually delivers. */
export interface SyntaxPalette {
	readonly colors: Readonly<Record<string, string>>;
	/** Contrast each of the seven syntax slots keeps against the editor plane. */
	readonly contrasts: Readonly<Record<string, number>>;
	/** Realised over requested chroma, worst over the placed roles. */
	readonly chromaRetention: number;
}

/**
 * Stage 4: place every syntax role at the lightness where it delivers the
 * contrast its role asked for, on one hue locked to the plane.
 *
 * `max(floor, inkContrast x f)` rather than `inkContrast x f` alone, because a
 * quiet role on a high-contrast plane would otherwise be placed below the
 * legibility floor - the fractions describe a RELATIONSHIP between roles, and
 * the floor describes the reader's eyes, and where they disagree the eyes win.
 */
export function buildSyntax(spec: FamilySpec, planes: Planes, ink: Ink): Result<SyntaxPalette, Infeasible> {
	const baseHue = (spec.planeH + spec.syntaxHueOffset + 360) % 360;
	const kickedHue = (baseHue + spec.constantKick + 360) % 360;
	const colors: Record<string, string> = {};
	const contrasts: Record<string, number> = {};
	let retention = 1;

	for (const role of placedRoles(spec)) {
		const floor = role.slot === "comment" ? COMMENT_MIN_CONTRAST : SYNTAX_MIN_CONTRAST;
		const target = Math.max(floor, spec.inkContrast * role.f);
		const C = spec.syntaxChroma * role.c;
		const h = role.kicked ? kickedHue : baseHue;
		const L = solveContrast(C, h, planes.editorBg, target, spec.mode);
		if (L === null) {
			return err({
				stage: "syntax",
				slot: role.slot,
				axis: role.slot === "comment" ? "fComment" : `f${role.slot[0].toUpperCase()}${role.slot.slice(1)}`,
				detail: `no lightness at hue ${h.toFixed(1)} reaches ${target.toFixed(2)}:1 on ${planes.editorBg}`
			});
		}
		const hex = placeAt(C, h, L);
		colors[role.slot] = hex;
		contrasts[role.slot] = effectiveContrast(hex, planes.editorBg);
		if (C > 1e-6) {
			retention = Math.min(retention, hexToOklch(hex).C / C);
		}
	}

	for (const [slot, source] of Object.entries(ALIASES[spec.register])) {
		colors[slot] = source === "editorFg" ? ink.editorFg : colors[source];
	}
	for (const slot of SYNTAX_SLOTS) {
		if (contrasts[slot] === undefined) {
			contrasts[slot] = effectiveContrast(colors[slot], planes.editorBg);
		}
	}
	return ok({ colors, contrasts, chromaRetention: retention });
}

// ---------------------------------------------------------------------------
// Stage 5: the ANSI ramp
// ---------------------------------------------------------------------------

/**
 * The sixteen slots in the order they are placed along the lightness axis,
 * outward from the terminal plane.
 *
 * The order IS the SGR convention, and it is mode-dependent because "outward"
 * is. On a dark plane outward is lighter, so black sits nearest the plane and
 * bright white furthest; on a light plane outward is darker and the whole list
 * reverses, which is the single change a light theme needs and the one the
 * corpus importer never made - run unreversed, the walk puts `ansiBlack` at the
 * light end and breaks the one part of the convention a program can rely on.
 *
 * The six normals are placed before the six brights so that every bright slot is
 * further from the plane than every normal one, which is what "bright" means.
 */
function ansiOrder(mode: ThemeMode): readonly SeedSlotId[] {
	const normals: readonly SeedSlotId[] = ["ansiRed", "ansiGreen", "ansiYellow", "ansiBlue", "ansiMagenta", "ansiCyan"];
	const brights: readonly SeedSlotId[] = ["ansiBrightRed", "ansiBrightGreen", "ansiBrightYellow", "ansiBrightBlue", "ansiBrightMagenta", "ansiBrightCyan"];
	if (mode === "dark") {
		return ["ansiBlack", "ansiBrightBlack", ...normals, ...brights, "ansiWhite", "ansiBrightWhite"];
	}
	return ["ansiBrightWhite", "ansiWhite", ...brights, ...normals, "ansiBrightBlack", "ansiBlack"];
}

/** Which chromatic name a slot wears, or `null` for one of the four neutrals. */
function chromaticIndex(slot: SeedSlotId): number {
	const name = slot.replace(/^ansi(Bright)?/, "").toLowerCase();
	return ANSI_CHROMATIC_NAMES.indexOf(name as typeof ANSI_CHROMATIC_NAMES[number]);
}

/** The sixteen placed ANSI colours, plus what the placement cost. */
export interface AnsiRamp {
	readonly colors: Readonly<Record<string, string>>;
	/** Worst of the 120 pairs under a trichromat. */
	readonly worstPair: number;
	/** Worst contrast any of the sixteen keeps on the terminal plane. */
	readonly minContrast: number;
	/** How many of the 120 pairs a dichromat cannot resolve. Best-effort, never a guarantee. */
	readonly dichromatCollisions: number;
	/** Realised over requested chroma, worst over the twelve chromatic slots. */
	readonly chromaRetention: number;
}

/**
 * Stage 5: place all sixteen jointly, against every pair the gate measures.
 *
 * This replaces `importPalette.separateFrom`, which guards 8 of the 120 pairs
 * `validateTheme` actually measures - and that gap is why 181 corpus schemes are
 * rejected downstream for collisions nothing upstream was looking for.
 */
export function buildAnsi(spec: FamilySpec, planes: Planes): Result<AnsiRamp, Infeasible> {
	const neutralC = Math.min(spec.planeC, ANSI_NEUTRAL_MAX_CHROMA);
	const slots: RampSlot[] = ansiOrder(spec.mode).map(slot => {
		const index = chromaticIndex(slot);
		if (index < 0) {
			return { id: slot, C: neutralC, h: spec.planeH };
		}
		return {
			id: slot,
			C: HOUSE_ANSI_CHROMA[index] * spec.ansiChromaScale,
			h: (HOUSE_ANSI_HUE[index] + spec.ansiHueOffsets[index] + 360) % 360
		};
	});

	const solved = solveRamp(slots, {
		backgroundHex: planes.panelBg,
		mode: spec.mode,
		minContrast: ANSI_MIN_CONTRAST,
		// The gate asks for 10. Overshooting by a per-family amount is what stops
		// every synthesised ramp having the identical internal geometry, which is
		// a clone factory dressed up as a margin.
		minSeparation: ANSI_MIN_SEPARATION + 0.05 + spec.ansiAir,
		minRungSpread: spec.ansiRungSpread
	});
	if (!solved.ok) {
		return err({
			stage: "ramp",
			slot: solved.error.slot,
			axis: solved.error.reason === "contrast" ? "ansiChromaScale" : "ansiAir",
			detail: `ran out of lightness placing ${solved.error.slot} (${solved.error.reason})`
		});
	}

	const colors: Record<string, string> = {};
	let retention = 1;
	let minContrast = Number.POSITIVE_INFINITY;
	for (const placement of solved.value) {
		colors[placement.id] = placement.hex;
		minContrast = Math.min(minContrast, placement.contrast);
		if (placement.requestedC > 1e-6 && chromaticIndex(placement.id as SeedSlotId) >= 0) {
			retention = Math.min(retention, placement.realisedC / placement.requestedC);
		}
	}

	let worstPair = Number.POSITIVE_INFINITY;
	let dichromatCollisions = 0;
	const ids = solved.value.map(p => p.id);
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			worstPair = Math.min(worstPair, perceptualDistanceOfHex(colors[ids[i]], colors[ids[j]]));
			const a = parseHex(colors[ids[i]]);
			const b = parseHex(colors[ids[j]]);
			let worstCvd = Number.POSITIVE_INFINITY;
			for (const type of CVD_TYPES) {
				worstCvd = Math.min(worstCvd, perceptualDistance(a, b, type));
			}
			if (worstCvd < ANSI_MIN_SEPARATION) {
				dichromatCollisions++;
			}
		}
	}
	return { ok: true, value: { colors, worstPair, minContrast, dichromatCollisions, chromaRetention: retention } };
}

// ---------------------------------------------------------------------------
// Stage 6: taste guards
// ---------------------------------------------------------------------------

/**
 * Reject the spec; never repair silently.
 *
 * (a) A chromatic ANSI slot whose REALISED hue has left its house band is no
 *     longer the colour SGR names. Placing only moves lightness, but the gamut
 *     wall can still swing a hue on the way down, so it is measured on the hex.
 * (b) A slot that kept less than `MIN_CHROMA_RETENTION` of the chroma it asked
 *     for has been flattened rather than placed.
 * (c) A palette whose loudest ink is more than `SYNTAX_CONTRAST_SPREAD_LIMIT`
 *     times its quietest has stopped being one voice at different volumes.
 */
function tasteGuards(spec: FamilySpec, ansi: AnsiRamp, syntax: SyntaxPalette): Infeasible | null {
	for (const [slot, hex] of Object.entries(ansi.colors)) {
		const index = chromaticIndex(slot as SeedSlotId);
		if (index < 0) {
			continue;
		}
		const wanted = (HOUSE_ANSI_HUE[index] + spec.ansiHueOffsets[index] + 360) % 360;
		const got = hexToOklch(hex).h;
		const drift = Math.abs(((got - wanted + 540) % 360) - 180);
		if (drift > 6) {
			return {
				stage: "taste",
				slot,
				axis: "ansiChromaScale",
				detail: `realised hue ${got.toFixed(1)} is ${drift.toFixed(1)} degrees off the ${ANSI_CHROMATIC_NAMES[index]} it was placed at`
			};
		}
	}
	if (ansi.chromaRetention < MIN_CHROMA_RETENTION) {
		return {
			stage: "taste",
			slot: "ansi ramp",
			axis: "ansiChromaScale",
			detail: `a chromatic ANSI slot kept only ${(ansi.chromaRetention * 100).toFixed(0)}% of its chroma against the gamut wall`
		};
	}
	if (syntax.chromaRetention < MIN_CHROMA_RETENTION) {
		return {
			stage: "taste",
			slot: "syntax palette",
			axis: "syntaxChroma",
			detail: `a syntax ink kept only ${(syntax.chromaRetention * 100).toFixed(0)}% of its chroma against the gamut wall`
		};
	}
	const contrasts = SYNTAX_SLOTS.map(slot => syntax.contrasts[slot]);
	const spread = Math.max(...contrasts) / Math.min(...contrasts);
	if (spread > SYNTAX_CONTRAST_SPREAD_LIMIT) {
		return {
			stage: "taste",
			slot: "syntax palette",
			axis: "fComment",
			detail: `loudest over quietest syntax ink is ${spread.toFixed(2)}, past the ${SYNTAX_CONTRAST_SPREAD_LIMIT} the house goes (Ink is 3.01)`
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// Post-conditions
// ---------------------------------------------------------------------------

/** Worst-observer distance between two emitted hexes. The gate's own arithmetic. */
export function worstObserverDistanceOfHex(a: string, b: string): number {
	const parsedA = parseHex(a);
	const parsedB = parseHex(b);
	let worst = Number.POSITIVE_INFINITY;
	for (const type of OBSERVERS) {
		worst = Math.min(worst, perceptualDistance(parsedA, parsedB, type));
	}
	return worst;
}

/** Which syntax slots are deliberately the same colour, per register. */
function aliasClass(spec: FamilySpec, slot: string): string {
	const alias = ALIASES[spec.register][slot];
	if (alias === undefined) {
		return slot;
	}
	return alias === "editorFg" ? "editorFg" : aliasClass(spec, alias);
}

/** The closest two NON-ALIASED syntax roles, under the worst observer. */
export function syntaxMinSeparation(spec: FamilySpec, colors: Readonly<Record<string, string>>): number {
	let worst = Number.POSITIVE_INFINITY;
	for (let i = 0; i < SYNTAX_SLOTS.length; i++) {
		for (let j = i + 1; j < SYNTAX_SLOTS.length; j++) {
			const a = SYNTAX_SLOTS[i];
			const b = SYNTAX_SLOTS[j];
			if (aliasClass(spec, a) === aliasClass(spec, b)) {
				continue;
			}
			worst = Math.min(worst, worstObserverDistanceOfHex(colors[a], colors[b]));
		}
	}
	return worst;
}

/**
 * Everything this file claims, re-checked against the bytes that will be
 * written. A near miss is only diagnosable next to the thing it missed, so each
 * one names its own measurement.
 */
function postConditions(spec: FamilySpec, seed: Seed, ansi: AnsiRamp, syntax: SyntaxPalette): Infeasible | null {
	if (ansi.worstPair < ANSI_MIN_SEPARATION) {
		return { stage: "postcondition", slot: "ansi ramp", axis: "ansiAir", detail: `worst ANSI pair ${ansi.worstPair.toFixed(2)} dE00, floor ${ANSI_MIN_SEPARATION}` };
	}
	if (ansi.minContrast < ANSI_MIN_CONTRAST) {
		return { stage: "postcondition", slot: "ansi ramp", axis: "ansiChromaScale", detail: `worst ANSI contrast ${ansi.minContrast.toFixed(2)}:1, floor ${ANSI_MIN_CONTRAST}` };
	}
	const ansiSlots = ansiOrder(spec.mode);
	const lightnesses = ansiSlots.map(slot => lightness(seed[slot]));
	const darkest = ansiSlots[lightnesses.indexOf(Math.min(...lightnesses))];
	const lightest = ansiSlots[lightnesses.indexOf(Math.max(...lightnesses))];
	if (darkest !== "ansiBlack") {
		return { stage: "postcondition", slot: "ansiBlack", axis: "ansiRungSpread", detail: `${darkest} is darker than ansiBlack, which breaks the one part of SGR a program can rely on` };
	}
	if (lightest !== "ansiBrightWhite") {
		return { stage: "postcondition", slot: "ansiBrightWhite", axis: "ansiRungSpread", detail: `${lightest} is lighter than ansiBrightWhite` };
	}
	const separation = syntaxMinSeparation(spec, syntax.colors);
	if (separation < SYNTAX_MIN_SEPARATION) {
		return { stage: "postcondition", slot: "syntax palette", axis: "fConstant", detail: `two non-aliased syntax roles are ${separation.toFixed(2)} dE00 apart, under the ${SYNTAX_MIN_SEPARATION} JND` };
	}
	return null;
}

// ---------------------------------------------------------------------------
// synthesise
// ---------------------------------------------------------------------------

/** Everything a reviewer, a contact sheet or a slack report needs about one build. */
export interface SynthesisReport {
	readonly spec: FamilySpec;
	readonly depth: Depth;
	readonly planes: Planes;
	readonly ink: Ink;
	readonly ansi: AnsiRamp;
	readonly syntax: SyntaxPalette;
	readonly ladder: SemanticLadder;
	readonly warnings: number;
	readonly slack: SlackReport;
}

/** A synthesised family, ready to serialise. */
export interface Synthesised {
	readonly seed: Seed;
	readonly theme: ColorTheme;
	readonly report: SynthesisReport;
}

/**
 * The whole pipeline, in the order that makes the tightest constraint bind
 * first: ground, ink, selection, syntax, ANSI, taste, expansion, validation.
 *
 * `label` names the theme in the emitted JSON and nothing else - the seed does
 * not depend on it, which the determinism suite asserts.
 *
 * Determinism throughout: fixed-iteration bisection and fixed-step walks only,
 * no RNG anywhere. The search that PRODUCES specs is offline; the build is a
 * lookup.
 */
export function synthesise(spec: FamilySpec, depth: Depth, label: string): Result<Synthesised, Infeasible> {
	const planes = buildPlanes(spec, depth);

	const ink = buildInk(spec, planes);
	if (!ink.ok) {
		return err({ stage: "ground", slot: ink.error.slot, axis: ink.error.axis, detail: `the ink cannot reach ${spec.inkContrast}:1 on ${planes.editorBg}` });
	}
	const selection = buildSelection(spec, planes, ink.value);
	if (!selection.ok) {
		return err({ stage: "ground", slot: selection.error.slot, axis: selection.error.axis, detail: `no selection band keeps the ink at ${4.6}:1 on ${planes.editorBg}` });
	}
	const syntax = buildSyntax(spec, planes, ink.value);
	if (!syntax.ok) {
		return err(syntax.error);
	}
	const ansi = buildAnsi(spec, planes);
	if (!ansi.ok) {
		return err(ansi.error);
	}
	const taste = tasteGuards(spec, ansi.value, syntax.value);
	if (taste !== null) {
		return err(taste);
	}

	const seed = {
		editorBg: planes.editorBg,
		chromeBg: planes.chromeBg,
		sideBg: planes.sideBg,
		panelBg: planes.panelBg,
		lineHighlight: planes.lineHighlight,
		editorFg: ink.value.editorFg,
		chromeFg: ink.value.chromeFg,
		selectionBg: selection.value.selectionBg,
		border: selection.value.border,
		accent: syntax.value.colors["accent"],
		keyword: syntax.value.colors["keyword"],
		string: syntax.value.colors["string"],
		function: syntax.value.colors["function"],
		comment: syntax.value.colors["comment"],
		type: syntax.value.colors["type"],
		constant: syntax.value.colors["constant"],
		operator: syntax.value.colors["operator"],
		...ansi.value.colors
	} as Seed;

	const broken = postConditions(spec, seed, ansi.value, syntax.value);
	if (broken !== null) {
		return err(broken);
	}

	let theme: ColorTheme;
	let ladder: SemanticLadder;
	try {
		const expanded = expandSeed(seed, {}, { name: label, mode: spec.mode, syntaxEmphasis: spec.syntaxEmphasis });
		theme = expanded.theme;
		ladder = expanded.ladder;
	} catch (error) {
		return err({
			stage: "ladder",
			slot: "semantics",
			axis: "ansiChromaScale",
			detail: (error as Error).message.split("\n")[0]
		});
	}

	const result = validate(theme as Parameters<typeof validate>[0]);
	if (result.errors.length > 0) {
		const first = result.errors[0];
		return err({
			stage: "validator",
			slot: first.token,
			axis: first.check.startsWith("semantic separation") ? "ansiChromaScale" : "planeL",
			detail: `${result.errors.length} validator error(s), first: ${first.check} | ${first.token} | ${first.measured}`
		});
	}

	const contrasts = SYNTAX_SLOTS.map(slot => syntax.value.contrasts[slot]);
	const report: SynthesisReport = {
		spec,
		depth,
		planes,
		ink: ink.value,
		ansi: ansi.value,
		syntax: syntax.value,
		ladder,
		warnings: result.warnings.length,
		slack: {
			ansiWorstPair: round2(ansi.value.worstPair),
			ansiMinContrast: round2(ansi.value.minContrast),
			ansiDichromatCollisions: ansi.value.dichromatCollisions,
			syntaxContrastRatio: round2(Math.max(...contrasts) / Math.min(...contrasts)),
			syntaxMinSeparation: round2(syntaxMinSeparation(spec, syntax.value.colors)),
			warnings: result.warnings.length
		}
	};
	return ok({ seed, theme, report });
}

/** Two decimal places, so a recorded margin and a re-measured one compare exactly. */
export function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

/** A spec built from plain numbers, for the suites here and in `propose.ts`. */
export function specOf(fields: Record<string, unknown>): FamilySpec {
	return fields as unknown as FamilySpec;
}

/**
 * Tide's own parameters, read off its shipped seed.
 *
 * This is the strongest evidence available that the grammar in this file is the
 * house grammar rather than an invention that happens to pass the gates: fed the
 * numbers Tide actually wears, it reproduces Tide's palette. See
 * `runFidelityTest`.
 */
export const TIDE_PARAMETERS: FamilySpec = specOf({
	id: "tidecheck",
	name: "Tidecheck",
	mode: "dark",
	depths: ["medium"],
	// Measured off tide's shipped seed in primal/design/vibe-tokens.json:
	// plane #0E1621 -> L 0.1980 C 0.0254 h 256.5; ink #D6E2F0 at 13.84:1, chroma
	// 0.0231 = 0.909 x the plane's; chromeFg at 7.71:1 = 0.557 of the ink.
	planeL: 0.1980,
	planeC: 0.0254,
	planeH: 256.5,
	inkContrast: 13.84,
	inkChromaScale: 0.909,
	chromeFraction: 0.557,
	register: "keywordLed",
	// Tide's five shared-hue syntax roles sit 7.8 degrees off the plane, and its
	// constant is kicked a further 27.2 - which is the whole house grammar.
	syntaxHueOffset: -7.8,
	syntaxChroma: 0.0939,
	fFunction: 0.857,
	fString: 0.712,
	fKeyword: 0.600,
	fConstant: 0.647,
	fComment: 0.238,
	constantKick: -27.2,
	syntaxEmphasis: "plain",
	ansiHueOffsets: [0, 0, 0, 0, 0, 0],
	ansiChromaScale: 1,
	ansiRungSpread: 0,
	ansiAir: 0,
	selectionStep: 0.1673,
	approval: { by: "test", on: null, sheet: "0".repeat(64) },
	slack: { ansiWorstPair: 0, ansiMinContrast: 0, ansiDichromatCollisions: 0, syntaxContrastRatio: 0, syntaxMinSeparation: 0, warnings: 0 }
});

/** Tide's shipped syntax colours, from `primal/design/vibe-tokens.json`. */
export const TIDE_SHIPPED: Readonly<Record<string, string>> = {
	editorBg: "#0E1621",
	editorFg: "#D6E2F0",
	keyword: "#7FB4E8",
	string: "#9CC3E8",
	function: "#B8D4F0",
	constant: "#79C0D8",
	comment: "#4A6B92"
};

/**
 * How close the grammar gets to Tide, per channel. These are the MEASURED
 * errors, pinned - not a comfortable margin.
 *
 * Tide's plane and its `keyword` come back BYTE-IDENTICAL; the ink and
 * `constant` are one byte out, `string` and `function` two, `comment` five. That
 * is the strongest evidence available that this file generates Primal-shaped
 * themes rather than arbitrary ones: fed the numbers a theme the owner already
 * approved actually wears, it returns that theme. A change that loosens any
 * number here is a visible diff rather than a silent drift.
 */
export const TIDE_CHANNEL_TOLERANCE: Readonly<Record<string, number>> = {
	editorBg: 0,
	editorFg: 1,
	keyword: 0,
	string: 2,
	function: 2,
	constant: 1,
	comment: 5
};

function maxChannelError(a: string, b: string): number {
	let worst = 0;
	for (let i = 1; i < 7; i += 2) {
		worst = Math.max(worst, Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));
	}
	return worst;
}

/**
 * The fidelity test: does the grammar reproduce a theme the owner already
 * approved, when fed that theme's own parameters?
 *
 * Returns one line per role, so the suite output IS the evidence table.
 */
export function runFidelityTest(): { readonly failures: readonly string[]; readonly table: readonly string[] } {
	const failures: string[] = [];
	const table: string[] = [];
	const planes = buildPlanes(TIDE_PARAMETERS, "medium");
	const ink = buildInk(TIDE_PARAMETERS, planes);
	if (!ink.ok) {
		return { failures: ["synthesise: the fidelity test cannot place Tide's ink"], table };
	}
	const syntax = buildSyntax(TIDE_PARAMETERS, planes, ink.value);
	if (!syntax.ok) {
		return { failures: ["synthesise: the fidelity test cannot place Tide's syntax"], table };
	}
	const produced: Record<string, string> = { editorBg: planes.editorBg, editorFg: ink.value.editorFg, ...syntax.value.colors };
	for (const [role, shipped] of Object.entries(TIDE_SHIPPED)) {
		const got = produced[role];
		const error = maxChannelError(got, shipped);
		const tolerance = TIDE_CHANNEL_TOLERANCE[role];
		table.push(`    ${role.padEnd(9)} synthesised ${got}  shipped ${shipped}  max channel error ${String(error).padStart(3)}  (bound ${tolerance})`);
		if (error > tolerance) {
			failures.push(`synthesise: fidelity: ${role} is ${error} bytes off Tide's shipped ${shipped} (bound ${tolerance}), got ${got}`);
		}
	}
	// The alias pattern is the other half of the grammar, and it is exact.
	if (syntax.value.colors["type"] !== syntax.value.colors["function"]) {
		failures.push("synthesise: fidelity: the keyword-led register must alias type to function, as tide/dusk/fern do");
	}
	if (syntax.value.colors["accent"] !== syntax.value.colors["keyword"]) {
		failures.push("synthesise: fidelity: the keyword-led register must alias accent to keyword");
	}
	if (syntax.value.colors["operator"] !== ink.value.editorFg) {
		failures.push("synthesise: fidelity: the keyword-led register must alias operator to the editor ink");
	}
	// `constant` is the role the house kicks off the shared hue, and it must land
	// on the far side of the other five rather than among them.
	const baseHue = (TIDE_PARAMETERS.planeH + TIDE_PARAMETERS.syntaxHueOffset + 360) % 360;
	const constantHue = hexToOklch(syntax.value.colors["constant"]).h;
	const kick = ((constantHue - baseHue + 540) % 360) - 180;
	table.push(`    constant is kicked ${kick.toFixed(1)} degrees off the shared hue (Tide ships -26)`);
	if (Math.abs(kick - TIDE_PARAMETERS.constantKick) > 8) {
		failures.push(`synthesise: fidelity: the constant kick came out ${kick.toFixed(1)}, not ${TIDE_PARAMETERS.constantKick}`);
	}
	return { failures, table };
}

/**
 * A small, deliberately varied set of specs the invariant suite runs over: both
 * registers, both modes, warm and cold planes, chromatic and near-achromatic.
 *
 * The contrast fractions are SPREAD, not merely in range. Two roles at the same
 * fraction sit at the same lightness and are then separated only by hue and
 * chroma - which is exactly the separation this owner cannot see. The first
 * draft of these samples had `fKeyword === fConstant` and the post-condition
 * measured the pair 0.84 dE00 apart under a protanope. The gates found it; the
 * samples were wrong.
 */
export function sampleSpecs(): readonly FamilySpec[] {
	const common = {
		depths: ["medium"], inkChromaScale: 1.4, chromeFraction: 0.55, syntaxHueOffset: -8,
		syntaxEmphasis: "weight", ansiHueOffsets: [0, 0, 0, 0, 0, 0],
		ansiChromaScale: 1, ansiRungSpread: 0, ansiAir: 0.3, selectionStep: 0.11,
		approval: { by: "test", on: null, sheet: "0".repeat(64) },
		slack: { ansiWorstPair: 0, ansiMinContrast: 0, ansiDichromatCollisions: 0, syntaxContrastRatio: 0, syntaxMinSeparation: 0, warnings: 0 }
	};
	const keywordLed = { register: "keywordLed", fFunction: 0.90, fString: 0.72, fKeyword: 0.62, fConstant: 0.70, fComment: 0.33, constantKick: 26 };
	const inkLed = { register: "inkLed", fFunction: 0.84, fString: 0.57, fConstant: 0.34, fComment: 0.33, constantKick: 0 };
	return [
		specOf({ ...common, ...keywordLed, id: "sa", name: "Sa", mode: "dark", planeL: 0.19, planeC: 0.022, planeH: 250, inkContrast: 11, syntaxChroma: 0.075 }),
		// A warm plane is the hard case, and this sample exists to keep it in the
		// suite: at hue 30 the constant's +26 degree kick buys almost nothing under a
		// protanope, so keyword and constant have to separate on lightness alone and
		// the fractions are pushed further apart than the cold sample needs.
		specOf({ ...common, ...keywordLed, id: "sb", name: "Sb", mode: "dark", planeL: 0.14, planeC: 0.010, planeH: 30, inkContrast: 11, syntaxChroma: 0.060, fKeyword: 0.58, fString: 0.78 }),
		specOf({ ...common, ...inkLed, id: "sc", name: "Sc", mode: "dark", planeL: 0.22, planeC: 0.006, planeH: 120, inkContrast: 11, syntaxChroma: 0.030 }),
		specOf({ ...common, ...keywordLed, id: "sd", name: "Sd", mode: "light", planeL: 0.97, planeC: 0.012, planeH: 80, inkContrast: 14, syntaxChroma: 0.050, fFunction: 0.96, fString: 0.76, fKeyword: 0.58 }),
		specOf({ ...common, ...inkLed, id: "se", name: "Se", mode: "light", planeL: 0.95, planeC: 0.008, planeH: 200, inkContrast: 11, syntaxChroma: 0.030 })
	];
}

/** The `synthesise.ts` suite. Returns one line per failing assertion; empty is a pass. */
export function runSynthesiseTests(): readonly string[] {
	const failures: string[] = [];
	const check = (what: string, condition: boolean, detail: string): void => {
		if (!condition) {
			failures.push(`synthesise: ${what}: ${detail}`);
		}
	};

	failures.push(...runFidelityTest().failures);

	let built = 0;
	for (const spec of sampleSpecs()) {
		const result = synthesise(spec, "medium", `Primal ${spec.name}`);
		if (!result.ok) {
			failures.push(`synthesise: sample ${spec.id} (${spec.mode}) is infeasible at ${result.error.stage}/${result.error.slot}: ${result.error.detail}`);
			continue;
		}
		built++;
		const { seed, theme, report } = result.value;
		const where = `${spec.id} (${spec.mode})`;

		// Every ANSI invariant, measured on the emitted hex.
		check(`${where}: no ANSI pair collides for a trichromat`, report.ansi.worstPair >= ANSI_MIN_SEPARATION,
			`worst pair ${report.ansi.worstPair.toFixed(2)} dE00`);
		check(`${where}: every ANSI slot is readable on the panel`, report.ansi.minContrast >= ANSI_MIN_CONTRAST,
			`worst ${report.ansi.minContrast.toFixed(2)}:1`);
		const order = ansiOrder(spec.mode);
		const ls = order.map(slot => lightness(seed[slot]));
		check(`${where}: ansiBlack is the darkest`, order[ls.indexOf(Math.min(...ls))] === "ansiBlack",
			`${order[ls.indexOf(Math.min(...ls))]} is darker`);
		check(`${where}: ansiBrightWhite is the lightest`, order[ls.indexOf(Math.max(...ls))] === "ansiBrightWhite",
			`${order[ls.indexOf(Math.max(...ls))]} is lighter`);

		// Every syntax invariant.
		for (const slot of SYNTAX_SLOTS) {
			const floor = slot === "comment" ? COMMENT_MIN_CONTRAST : SYNTAX_MIN_CONTRAST;
			check(`${where}: ${slot} clears its floor`, report.syntax.contrasts[slot] >= floor - 1e-9,
				`${report.syntax.contrasts[slot].toFixed(2)}:1 against a floor of ${floor}`);
		}
		check(`${where}: the alias table holds`,
			spec.register === "inkLed"
				? seed.keyword === seed.editorFg && seed.type === seed.editorFg && seed.operator === seed.editorFg
				: seed.type === seed.function && seed.accent === seed.keyword && seed.operator === seed.editorFg,
			"an aliased role is not equal to the role it aliases");
		check(`${where}: non-aliased syntax roles separate`, report.slack.syntaxMinSeparation >= SYNTAX_MIN_SEPARATION,
			`closest pair ${report.slack.syntaxMinSeparation} dE00`);

		// The validator sees zero errors. Not few. Zero.
		const result2 = validate(theme as Parameters<typeof validate>[0]);
		check(`${where}: the validator reports no errors`, result2.errors.length === 0,
			`${result2.errors.length}: ${result2.errors.slice(0, 2).map(e => `${e.check} | ${e.token}`).join("; ")}`);

		// Determinism, and independence from the label.
		const again = synthesise(spec, "medium", `Primal ${spec.name}`);
		check(`${where}: synthesis is deterministic`, again.ok && JSON.stringify(again.value.seed) === JSON.stringify(seed), "two calls disagreed");
		const relabelled = synthesise(spec, "medium", "Something Else");
		check(`${where}: the seed does not depend on the label`, relabelled.ok && JSON.stringify(relabelled.value.seed) === JSON.stringify(seed),
			"the seed moved when only the name changed");
	}
	check("the sample specs all synthesise", built === sampleSpecs().length, `${built} of ${sampleSpecs().length}`);

	// An impossible spec comes back as Infeasible, naming a stage, a slot and an
	// axis that exists - never as a throw.
	{
		const impossible = specOf({
			...sampleSpecs()[0], id: "sx", name: "Sx", planeL: 0.30, planeC: 0.030, inkContrast: 15.5, ansiChromaScale: 1.4, ansiAir: 1.2, ansiRungSpread: 0.02
		});
		let threw = false;
		let outcome: Result<Synthesised, Infeasible> | null = null;
		try {
			outcome = synthesise(impossible, "medium", "Primal Sx");
		} catch {
			threw = true;
		}
		check("an impossible spec never throws", !threw, "it threw");
		if (outcome !== null && !outcome.ok) {
			check("Infeasible names a real repair axis", REPAIR_LADDER[outcome.error.stage] !== undefined,
				`stage ${outcome.error.stage} has no repair ladder`);
			check("Infeasible names a slot", outcome.error.slot.length > 0, "empty slot");
		}
	}

	return failures;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	const fidelity = runFidelityTest();
	console.log("synthesise: the grammar, fed Tide's own parameters:");
	for (const line of fidelity.table) {
		console.log(line);
	}
	console.log("");
	const failures = runSynthesiseTests();
	for (const line of failures) {
		console.error(`  ${line}`);
	}
	if (failures.length > 0) {
		console.error(`\nsynthesise: ${failures.length} failing assertion(s)`);
		process.exit(1);
	}
	console.log("synthesise: all assertions pass (Tide fidelity, ANSI order and separation, syntax floors and aliases, zero validator errors, determinism)");
	process.exit(0);
}
