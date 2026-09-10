#!/usr/bin/env node --experimental-strip-types
/**
 * Expands a palette seed into a complete Primal colour theme.
 *
 * primal/theme/tokenMap.ts states WHICH palette slot every one of the 449
 * workbench colours and 33 tokenColors comes from. This file fills those slots
 * and writes the JSON: it resolves the surfaces a seed omits, SYNTHESISES the
 * semantic colours, proves the result before returning it, and serialises it
 * byte-identically for a given input.
 *
 * WHY THE SEMANTICS ARE SYNTHESISED RATHER THAN SEEDED
 *
 * The owner is colour blind - amber reads as green - so error / warning / info /
 * added / untracked / deleted / modified / conflict cannot be told apart by hue.
 * They have to differ in LIGHTNESS. A hand-authored palette cannot promise that,
 * and measuring the six themes that shipped shows it never happened:
 *
 *     ink     warning #8A651C (L 0.5322) vs added #4C7A44 (L 0.5325)  dL 0.0003
 *     ridge   warning #8A6520 (L 0.5322) vs conflict #9A5B22 (L 0.5329) dL 0.0007
 *     basalt  added   #86B384 (L 0.7224) vs info  #8AA9C8 (L 0.7231)  dL 0.0007
 *     fern    warning #D2BC7E (L 0.7998) vs added #9CCDAA (L 0.8043)  dL 0.0045
 *
 * Those pairs are the SAME SHADE. Under a red-green deficiency they are the
 * same colour, full stop - a warning triangle and an added-line marker become
 * indistinguishable. Every one of the six themes has at least one such pair,
 * and ink's is 0.0003 apart, which is below 8-bit quantisation.
 *
 * Worse, `gitDecoration.untrackedResourceForeground` and
 * `gitDecoration.addedResourceForeground` were the SAME HEX in all twenty-one
 * themes - 0.00 dE00, to anyone - because the map routed both to one slot.
 *
 * So the generator takes the palette's own hues and re-lights them onto ladders
 * whose spacing is MEASURED, not assumed: each role goes at the first lightness
 * that is at least the gate's own 11 dE00 from every role already placed, under
 * normal, protanopic, deuteranopic and tritanopic vision, on the emitted 8-bit
 * hex. Roles whose hues collapse under a red-green deficiency - warning, error,
 * added, conflict, deleted - additionally have to clear that distance on
 * LIGHTNESS ALONE, so no residual hue is doing the work for them. The six
 * semi-transparent diff washes are solved the same way after compositing.
 *
 * That deliberately changes those values in the six original vibes, which this
 * file's `--check` prints in full, slot by slot, before and after.
 *
 * Run the fidelity gate, which is this file's acceptance test:
 *
 *   node --experimental-strip-types primal/theme/generateTheme.ts --check
 *
 * It reports three things separately, and they must not be conflated:
 *   1. The map path. Generating with the hand-authored semantics pinned must
 *      reproduce the record in tokenMap.test-fixture.json, except at the tokens
 *      tokenMap.REROUTED_TOKENS declares. A failure here is a bug in the map.
 *   2. The ladder. Generating with synthesised semantics changes exactly the
 *      tokens that hang off a semantic slot, and every change is listed. That
 *      is the intended improvement, not a failure.
 *   3. What shipped. The theme file on disk must BE the synthesised output, so
 *      a semantic colour cannot be hand-edited back in.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	MODE_SLOT_IDS,
	SEED_SLOT_IDS,
	REROUTED_TOKENS,
	SEMANTIC_SLOT_IDS,
	SURFACE_FALLBACKS,
	SURFACE_SLOT_IDS,
	WORKBENCH_TOKENS,
	buildColors,
	buildTokenColors,
	resolveModeSlots,
	type Palette,
	type SemanticSlotId,
	type SlotId,
	type SurfaceSlotId,
	type SeedSlotId,
	type SyntaxEmphasis,
	type ThemeMode,
	type TokenColorEntry
} from "./tokenMap.ts";

import {
	contrastRatio,
	effectiveContrast,
	formatHex,
	relativeLuminance,
	hexToOklch,
	lightness,
	maxChroma,
	mixHexSrgb,
	oklchToHex,
	parseHex,
	type Rgb
} from "./color.ts";

// The gate's own CIEDE2000 and its own observer list, imported from the module
// validateTheme.ts imports them from, rather than reimplemented. The generator
// has to optimise the number the validator will report, or the two files agree
// about a theme only by luck — and when they disagreed by an 8-bit rounding
// step they did exactly that. See worstObserverDistance.
import { OBSERVERS, perceptualDistance } from "../../src/vs/base/common/primalColorScience.ts";

// ---------------------------------------------------------------------------
// The semantic ladders.
//
// THE COLOUR-BLINDNESS REASON, stated once, because every constant below is
// downstream of it:
//
// Under a red-green deficiency (the owner's: amber reads as green) red, orange,
// amber and green all collapse onto one washed-out yellow axis; under the rarer
// blue-yellow deficiency blue and green collapse instead. Between the three
// dichromacies validateTheme.ts simulates, NO pair of hues can be relied on, so
// lightness is the only channel that always survives.
//
// WHAT REPLACED THE FIXED STEP. This file used to place seven roles on one grid
// at a constant 0.06 of OKLab L. That is a proxy for the thing that matters and
// it was the wrong size: validateTheme requires 11 dE00 under the worst of four
// observers, and 0.06 OKLab L buys 6.2-6.5 CIELAB L*, which is 4-6 dE00 at the
// lightness these colours sit at. Every adjacent pair failed the gate, and
// buildThemes.ts forgave the failures with a one-step tolerance. Nothing in the
// pipeline ever asserted the property the product exists to deliver.
//
// So the ladder is no longer a grid. Each role is placed at the FIRST lightness,
// walking away from the background, at which it measures >= SEMANTIC_TARGET_DELTA_E
// from every role already placed - measured with validateTheme's own CIEDE2000
// under normal, protanopic, deuteranopic and tritanopic vision, on the emitted
// 8-bit hex. The generator therefore asserts exactly what the validator checks,
// on exactly the bytes that ship. Where hue survives a deficiency the step comes
// out small; where it does not, the step comes out large. That is the point.
//
// WHY TWO LADDERS AND NOT ONE. Seven roles on one ladder does not fit any real
// background: it needs five rungs of pure-lightness separation stacked above a
// 4.5:1 contrast floor, which is more lightness than sRGB has above a near-black
// or below a paper-white plane. It also is not what the product needs. Walk
// validateTheme's SEMANTIC_GROUPS and every group is drawn from exactly one of
// two sets:
//
//   severity  error, warning, info
//             editorError/Warning/Info, problemsErrorIcon and its siblings,
//             notification icons, debug console, ruler diagnostics, status bar,
//             list severities, inputValidation borders, output tokens
//   diff      added, untracked, conflict, modified, deleted
//             gutter bars, ruler diff marks, gitDecoration.*, markup diff tokens
//
// No widget in VS Code puts an error squiggle and an added-line marker in the
// same alphabet, and no group in the gate pairs them. Separating the two sets
// from each other would buy nothing and cost the room the diff set needs. So
// each ladder is solved independently, and they are free to overlap.
//
// THE ORDER of the roles on each ladder - which one sits nearest the background,
// quietest and lowest contrast, and which sits furthest - is fixed for every
// theme, so a rung means the same thing whichever vibe is loaded. It is the one
// order of the 60 with `added` before `deleted` that fits inside
// [SEMANTIC_LIGHTNESS_FLOOR, SEMANTIC_LIGHTNESS_CEILING] for all twenty-one
// palettes AND keeps the furthest rung nearest the plane; the search that
// produced it is reproducible from the constants in this file.
// ---------------------------------------------------------------------------

/**
 * The separation the generator builds in, in dE00 under the worst of the four
 * observers.
 *
 * validateTheme.ts fails a pair below 11. This is that number plus two tenths.
 * The headroom is small on purpose: the generator measures the exact 8-bit hex
 * it is about to write, through validateTheme's own exported CIEDE2000 and the
 * same dichromacy model, so the two measurements are the same arithmetic on the
 * same bytes and the only thing the margin has to absorb is a JSON round trip.
 * Every tenth above the gate is lightness taken out of a palette's budget, and
 * the tightest plane in the corpus (Pewter's #2D2D2D, which leaves the least
 * room on either side) does not have tenths to spare.
 *
 * It is a floor the generator holds itself to, never a relaxation of the gate:
 * `assertLadder` re-checks against the gate's own number, not against this one.
 */
export const SEMANTIC_TARGET_DELTA_E = 11.2;

/**
 * The number validateTheme.ts actually fails on. Duplicated here rather than
 * imported as a constant because validateTheme keeps it private; `assertLadder`
 * asserts against THIS value, so if the two ever drift apart the assertion
 * fails loudly on the next build instead of shipping a theme the gate rejects.
 */
export const SEMANTIC_GATE_DELTA_E = 11;

/**
 * How finely the placement search walks lightness, in OKLab L.
 *
 * 0.0015 is below the 8-bit quantisation of a mid-tone (~0.002 of L), so the
 * search cannot step over a lightness the emitted hex could have expressed.
 * Smaller would only cost time; larger would overshoot and make rungs louder
 * than they need to be.
 */
export const LADDER_SEARCH_STEP = 0.0015;

/**
 * WCAG AA for normal text. These colours are used as body text - the Problems
 * list, `gitDecoration.*ResourceForeground` in the explorer, the debug console -
 * so the icon-and-graphics 3:1 floor is not enough.
 */
export const MIN_SEMANTIC_CONTRAST = 4.5;

/**
 * Hard stops on the ladder. Past these a colour has lost enough chroma to the
 * sRGB gamut boundary that it no longer reads as red or green or amber, only as
 * "very dark" or "very pale" - which would defeat the point. A palette that
 * cannot fit its ladders between them is rejected loudly rather than squeezed.
 */
export const SEMANTIC_LIGHTNESS_FLOOR = 0.24;
export const SEMANTIC_LIGHTNESS_CEILING = 0.92;

/**
 * `conflict` has no ANSI colour of its own, so its hue is mixed from red toward
 * yellow. 0.55 is the mean of what the six hand-authored themes actually did
 * (measured: ink 0.59, basalt 0.69, tide 0.55, dusk 0.64, fern 0.62, ridge 0.55
 * of the way from ansiRed to ansiYellow) rounded to the nearest twentieth. It
 * is the one approximate number in this file, and it is only approximate
 * because it is reproducing a judgement call, not a rule.
 */
export const CONFLICT_HUE_MIX = 0.55;

/**
 * How close to the sRGB gamut wall a re-lit semantic colour is allowed to get,
 * as a fraction of the maximum chroma available at its new lightness.
 *
 * The gamut is much narrower at the ends than in the middle, so carrying a
 * mid-tone red's chroma down to L 0.32 pins it flat against the boundary: ink's
 * error becomes #640100, which reads as "red", not as "ink's red". Capping at
 * 0.85 of the cusp gives a deep oxblood instead - still clearly the palette's
 * own. It only ever bites at the far rungs; at the near rungs the palette's own
 * chroma is well inside the wall and is passed through untouched.
 */
export const MAX_GAMUT_FRACTION = 0.85;

/**
 * The roles whose hues collapse into one washed-out yellow axis under a
 * red-green deficiency - which is the owner's own deficiency, and the one this
 * product exists to serve.
 *
 * Any two of these that share a ladder must be separated by LIGHTNESS ALONE, at
 * the size validateTheme's own `lightness separation` check asks for, on top of
 * the dE00 target. That is a strictly stronger guarantee than the dE00 target
 * gives on its own: dE00 under a simulated dichromat still lets a residual hue
 * difference count, and this does not. It survives protanopia, deuteranopia,
 * tritanopia, monochromacy and a greyscale printout equally.
 *
 * Blue and magenta are deliberately NOT in the set. They survive a red-green
 * deficiency with their hue intact - that is the whole reason `info` and
 * `modified` are blue and `untracked` is magenta - so demanding lightness of
 * them too would spend lightness the diff ladder does not have, to buy a user
 * with red-green deficiency nothing. It is measurable that it cannot be had:
 * requiring it of ALL five diff roles fits none of the twenty-one palettes,
 * requiring it of these three fits every one. Where a pair leans on a hue that
 * survives, validateTheme still says so as a warning, and that warning is left
 * standing rather than suppressed.
 */
const MONOCHROME_SAFE_ROLES: readonly SemanticLadderSlotId[] = ["warning", "error", "added", "conflict", "deleted"];

/**
 * The two ladders, each listed from the rung NEAREST the editor background
 * (quietest, lowest contrast) to the one furthest from it (loudest).
 *
 * severity: warning is quietest because it also drives the find-match washes -
 * `editor.findMatchBackground` and five more take their colour from it - and
 * dragging it to a loud rung turns a light theme's find highlight into a dark
 * smear. error is loudest because it is the one colour that must never be
 * missed.
 *
 * diff: added is quietest because a healthy working tree is mostly additions
 * and they should not shout; deleted is loudest because it is the destructive
 * one. untracked, conflict and modified fall between them in the order the
 * fitting search returned (see the note above the constants).
 */
export const LADDER_FAMILIES: readonly { readonly name: string; readonly order: readonly SemanticLadderSlotId[] }[] = [
	{ name: "severity", order: ["warning", "info", "error"] },
	{ name: "diff", order: ["added", "untracked", "conflict", "modified", "deleted"] }
];

/** Where a semantic role takes its hue and chroma from. */
type HueSource =
	| { readonly kind: "seed"; readonly slot: SeedSlotId }
	| { readonly kind: "blend"; readonly from: SeedSlotId; readonly toward: SeedSlotId; readonly amount: number };

/**
 * The palette's OWN hues, never a fixed red or green. A palette that tints its
 * ANSI ramp toward its planes gets semantics tinted the same way; only the
 * lightness is taken away from it.
 *
 * The identities that are load-bearing and are not negotiable: error and
 * deleted stay warm, added stays green, modified and info stay blue. `untracked`
 * is the one role with no inherited identity - VS Code's own default paints it
 * the same green as `added`, which is exactly the collision this file exists to
 * remove - so it takes the palette's magenta. Magenta is the hue that survives
 * all three dichromacies furthest from green: a protanope and a deuteranope see
 * it as blue-violet, a tritanope as red. It buys the diff ladder a rung it does
 * not have to pay for in lightness, which is what makes five diff roles fit.
 */
const HUE_SOURCE: Readonly<Record<SemanticLadderSlotId, HueSource>> = {
	error: { kind: "seed", slot: "ansiRed" },
	deleted: { kind: "seed", slot: "ansiRed" },
	warning: { kind: "seed", slot: "ansiYellow" },
	conflict: { kind: "blend", from: "ansiRed", toward: "ansiYellow", amount: CONFLICT_HUE_MIX },
	added: { kind: "seed", slot: "ansiGreen" },
	untracked: { kind: "seed", slot: "ansiMagenta" },
	info: { kind: "seed", slot: "ansiBlue" },
	modified: { kind: "seed", slot: "ansiBlue" }
};

// ---------------------------------------------------------------------------
// The diff washes.
//
// Six tokens paint a diff as a semi-transparent background rather than as ink:
// diffEditor.inserted/removedLineBackground, diffEditor.inserted/removedTextBackground
// and inlineChatDiff.inserted/removed. validateTheme measures them AFTER
// compositing over editor.background, and that is the whole difficulty: two
// colours ten percent of the way from the plane are ten percent as far apart as
// the colours themselves. At the alphas this map used to state - 1A, 26 and 33 -
// no pair of underlying colours could reach 11 dE00 on a light plane at all.
// The reachable maximum over Ink's #FAF9F6 at alpha 33 is 5.3 dE00, whatever
// hues you pick, so this was not a palette problem and no seed could have fixed
// it.
//
// So a wash is not "a ladder rung at an alpha" any more. Each of the three
// strengths is solved in COMPOSITED space: the inserted wash is placed a fixed
// perceptual distance off the plane so it reads as a tint, the removed wash is
// walked outward until the composited pair measures SEMANTIC_TARGET_DELTA_E
// apart under all four observers, and the alpha is whatever that construction
// needs. Both washes must also keep editor.foreground above WCAG AA, so a diff
// band never costs the user the code inside it.
//
// COMPOSITING MODEL. These are solved with the same gamma-space source-over the
// gate uses (validateTheme.composite), not with color.ts's linear-light
// flattenOver. The two disagree by a lot - a 10%-alpha near-white over a
// near-black plane is #2A2A2A in gamma space and #5B5B5B in linear - and a
// generator that optimises against one model while the gate measures the other
// produces colours that pass nothing. Gamma-space is also what a browser
// compositor does for a plain alpha fill, so it is the model that describes
// what the user sees. The disagreement inside color.ts is real and is worth
// resolving, but not by having two files quietly assume different physics.
// ---------------------------------------------------------------------------

/** How far off the plane the INSERTED wash of each strength is placed, in OKLab L. */
export const WASH_OFFSETS: Readonly<Record<WashStrength, number>> = {
	line: 0.055,
	inline: 0.075,
	text: 0.100
};

/**
 * Fractions of the base offset the solver may fall back to, in order, when a
 * palette cannot carry the full one - a very dark plane with dim body text runs
 * out of room between the wash and the WCAG floor before it runs out of
 * separation. Falling back shrinks the tint; it never shrinks the separation.
 */
export const WASH_OFFSET_FALLBACKS: readonly number[] = [1, 0.82, 0.66, 0.52, 0.4, 0.3];

/** Alphas a wash may be emitted at, smallest first. The solver takes the first that works. */
export const WASH_ALPHA_STEPS: readonly number[] = [
	0x1A, 0x26, 0x33, 0x40, 0x4D, 0x5A, 0x66, 0x73, 0x80, 0x8C, 0x99, 0xA6, 0xB3, 0xBF, 0xCC, 0xD9, 0xE6, 0xF2
];

/**
 * A wash is a tint, not a colour: it carries a fraction of its parent's chroma.
 * At full chroma a 40%-alpha green band reads as a green highlight rather than
 * as "this line changed", and it fights the syntax colours painted on top of it.
 *
 * Three quarters rather than a half because the removed wash sits at the far end
 * of the wash pair, high up the lightness range where the sRGB gamut is narrow -
 * take too much chroma out here and the band composites to a neutral grey, and
 * "removed" stops reading as warm to a trichromat even though it still measures
 * far enough from "inserted" for a dichromat. See WASH_MIN_CHROMA_RETENTION,
 * which is the same problem approached from the other side.
 */
export const WASH_CHROMA_FRACTION = 0.75;

/** WCAG AA for normal text, matching validateTheme's MIN_HIGHLIGHTED_TEXT_CONTRAST. */
export const WASH_MIN_TEXT_CONTRAST = 4.5;

/**
 * The separation a composited wash pair is built to, in dE00. Higher than
 * SEMANTIC_TARGET_DELTA_E, and the difference is not taste.
 *
 * A ladder rung is an 8-bit hex and the gate measures that hex, so generator
 * and gate do identical arithmetic. A wash is measured AFTER compositing, and
 * validateTheme keeps the composite in floating point while this file can only
 * measure the 8-bit colour it is able to write. Half a level of rounding on
 * three channels of two colours is worth up to about three tenths of a dE00,
 * and it cost a real theme: Trench Soft's inline-chat pair measured 11.20 here
 * and 10.98 in the gate. Seven tenths covers the rounding with room, and a wash
 * has the room to spare - unlike the ladder, it is not competing for lightness
 * against four other rungs.
 */
export const WASH_TARGET_DELTA_E = 11.7;

/** How finely the removed wash is walked outward, in OKLab L of the underlying colour. */
export const WASH_SEARCH_STEP = 0.003;

/**
 * How much of the chroma a wash asked for it must actually keep.
 *
 * The solver prefers the smallest alpha that reaches a given tint, and the
 * smallest alpha needs the most extreme underlying colour: on Basalt's near
 * black plane the removed text wash came out #FFFCFB at 25%, which is white -
 * the sRGB gamut has almost no chroma left at that lightness, so the band
 * composited to a neutral grey and "removed" stopped reading as warm at all.
 * A larger alpha reaches the same composited lightness from a less extreme
 * colour, which keeps the hue. So a candidate that has lost more than a third
 * of the chroma it asked for is rejected and the next alpha is tried.
 */
export const WASH_MIN_CHROMA_RETENTION = 0.67;

/** The three wash strengths, and the slot pair each one fills. */
export type WashStrength = "line" | "inline" | "text";

const WASH_PAIRS: Readonly<Record<WashStrength, { readonly added: SemanticSlotId; readonly deleted: SemanticSlotId }>> = {
	line: { added: "addedLineWash", deleted: "deletedLineWash" },
	inline: { added: "addedInlineWash", deleted: "deletedInlineWash" },
	text: { added: "addedTextWash", deleted: "deletedTextWash" }
};

/** The semantic slots that sit on a ladder. The rest are washes. */
export type SemanticLadderSlotId = Exclude<SemanticSlotId,
	"addedLineWash" | "deletedLineWash" | "addedInlineWash" | "deletedInlineWash" | "addedTextWash" | "deletedTextWash">;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A palette seed: all 33 slots a corpus palette can state. */
export type Seed = Readonly<Record<SeedSlotId, string>>;

/** Pinned chrome surfaces. Anything omitted falls back to SURFACE_FALLBACKS. */
export type Surfaces = Readonly<Partial<Record<SurfaceSlotId, string>>>;

/** What a seed cannot say about itself. */
export interface VariantMeta {
	/** Theme display name, e.g. "Primal Ink". Becomes `name` in the JSON. */
	readonly name: string;
	readonly mode: ThemeMode;
	readonly syntaxEmphasis: SyntaxEmphasis;
}

export interface ExpandOptions {
	/**
	 * Replaces the synthesised semantics with fixed values. The ONLY caller is
	 * the fidelity gate, which uses it to reproduce the hand-authored themes so
	 * that a map bug and a deliberate ladder change cannot be mistaken for each
	 * other. Production generation must never pass this - a pinned semantic is
	 * exactly the unprovable thing this file exists to remove.
	 */
	readonly pinnedSemantics?: Readonly<Record<SemanticSlotId, string>>;
	/** Skips the ladder assertions. Only for reporting on a pinned palette. */
	readonly skipLadderCheck?: boolean;
}

/** The shape written to disk. Key order here is the key order in the file. */
export interface ColorTheme {
	readonly $schema: string;
	readonly name: string;
	readonly type: ThemeMode;
	readonly colors: Record<string, string>;
	readonly tokenColors: readonly TokenColorEntry[];
	readonly semanticHighlighting: boolean;
}

// ---------------------------------------------------------------------------
// Semantic synthesis
// ---------------------------------------------------------------------------

/** One semantic colour, with everything needed to audit it. */
export interface LadderRung {
	readonly slot: SemanticSlotId;
	/** Which ladder it sits on: "severity", "diff" or "wash". */
	readonly family: string;
	/** Index from the rung nearest the background. */
	readonly position: number;
	readonly hex: string;
	readonly lightness: number;
	readonly contrast: number;
}

/** One measured pair, so a near miss can be read next to the pairs that passed. */
export interface LadderPair {
	readonly family: string;
	readonly a: SemanticSlotId;
	readonly b: SemanticSlotId;
	readonly deltaE: number;
	readonly observer: string;
	/**
	 * For a pair that must survive a red-green deficiency on lightness alone:
	 * whether it does. `null` for a pair carried by a hue that survives, where
	 * the question does not apply.
	 */
	readonly lightnessAlone: boolean | null;
}

/** The whole ladder set, measured off the emitted hexes rather than the intent. */
export interface SemanticLadder {
	readonly mode: ThemeMode;
	readonly backgroundHex: string;
	readonly rungs: readonly LadderRung[];
	/** Every pair the gate will measure, as this generator measured it. */
	readonly pairs: readonly LadderPair[];
	/** Smallest dE00 over every measured pair, under the worst observer. The load-bearing number. */
	readonly minDeltaE: number;
	/** Smallest |ΔL| between two colours on the same ladder. Diagnostic, not a gate. */
	readonly minDeltaLightness: number;
	/** Kept for the catalogue report: the same number as minDeltaLightness, restricted to the diff ladder. */
	readonly minConfusableDeltaLightness: number;
	/** Worst contrast any ladder rung has against the editor background. */
	readonly minContrast: number;
	/** Worst contrast body text keeps on any composited wash. */
	readonly minWashTextContrast: number;
	/**
	 * Families whose plane could not carry the lightness-alone guarantee, so
	 * their red-green confusable pairs are separated by measured dE00 under each
	 * dichromacy instead. Empty is the normal, and better, case.
	 */
	readonly hueAssistedFamilies: readonly string[];
}

/** Shortest-arc hue interpolation, in degrees. */
function mixHue(from: number, toward: number, amount: number): number {
	const delta = ((toward - from + 540) % 360) - 180;
	return (from + delta * amount + 360) % 360;
}

/** Chroma and hue for a role, taken from the seed. Lightness comes from the ladder. */
function hueAndChroma(seed: Seed, slot: SemanticLadderSlotId): { readonly C: number; readonly h: number } {
	const source = HUE_SOURCE[slot];
	if (source.kind === "seed") {
		const lch = hexToOklch(seed[source.slot]);
		return { C: lch.C, h: lch.h };
	}
	const from = hexToOklch(seed[source.from]);
	const toward = hexToOklch(seed[source.toward]);
	return {
		C: from.C + (toward.C - from.C) * source.amount,
		h: mixHue(from.h, toward.h, source.amount)
	};
}

/**
 * Places a role's hue at a given lightness: the palette's own chroma, held back
 * from the gamut wall by MAX_GAMUT_FRACTION. This is the single place a
 * semantic colour is constructed, so the contrast search and the emitted value
 * cannot disagree about what colour a lightness produces.
 */
function placeOnLadder(C: number, h: number, L: number): string {
	return oklchToHex({ L, C: Math.min(C, MAX_GAMUT_FRACTION * maxChroma(L, h)), h });
}

/**
 * Perceptual distance between two emitted hexes under the worst of the four
 * observers validateTheme.ts simulates.
 *
 * This calls `perceptualDistance` — the gate's own entry point — once per
 * observer, on the parsed triples. It used to simulate each observer here and
 * push the result back through `formatHex` before measuring, which re-quantised
 * the simulated colour to 8 bits; the gate measures the unrounded triple, and
 * `simulateCvd` says so in as many words ("distances measured on simulated
 * colours are not quantised by an 8-bit round trip").
 *
 * The docstring that used to sit here claimed the two numbers "cannot drift".
 * They did: over 200,000 random pairs the generator read between 0.96 dE00
 * below and 1.14 dE00 above the gate, and 0.099% of pairs landed on the wrong
 * side of the threshold. Because the ladder search stops at the FIRST lightness
 * clearing its target, it selects for boundary pairs on purpose, so the error
 * concentrated exactly where it did damage: 4.91% of themes whose `assertLadder`
 * passed were then failed by `validate` on semantic separation.
 *
 * Measuring the way the gate measures makes the disagreement identically zero
 * rather than something a tolerance has to cover.
 */
function worstObserverDistance(a: string, b: string): { readonly deltaE: number; readonly observer: string } {
	const parsedA = parseHex(a);
	const parsedB = parseHex(b);
	let deltaE = Number.POSITIVE_INFINITY;
	let observer = "normal";
	for (const type of OBSERVERS) {
		const distance = perceptualDistance(parsedA, parsedB, type);
		if (distance < deltaE) {
			deltaE = distance;
			observer = type;
		}
	}
	return { deltaE, observer };
}

/**
 * Source-over compositing in gamma-encoded sRGB, byte for byte what
 * validateTheme.composite does.
 *
 * color.ts has flattenOver, which composites in linear light. It is not used
 * here on purpose: see the note above WASH_OFFSETS. A wash solved against one
 * model and measured against the other passes neither.
 */
function compositeGamma(fgHex: string, bgHex: string): string {
	const fg = parseHex(fgHex);
	const bg = parseHex(bgHex);
	const alpha = fg.alpha;
	return formatHex({
		r: fg.r * alpha + bg.r * (1 - alpha),
		g: fg.g * alpha + bg.g * (1 - alpha),
		b: fg.b * alpha + bg.b * (1 - alpha)
	});
}

/**
 * The composite the GATE measures: source-over in gamma sRGB, left in floating
 * point.
 *
 * compositeGamma rounds to eight bits, because it returns a hex and a hex is
 * what the theme file has to carry. validateTheme never rounds - it composites
 * the emitted alpha colour over the plane and measures THAT. For dE00 the
 * disagreement is absorbed by WASH_TARGET_DELTA_E's 0.7 margin, but the
 * lightness-alone rule is a hard inequality with no margin, and the rounding was
 * worth 0.34 L*: Nightshade's line wash measured 15.65 L* here against 15.53
 * required and was accepted, while the gate measured 15.31 against 15.52 and
 * warned. The generator believed it had solved a pair the gate then reported as
 * hue-assisted, and buildThemes printed "lightness-alone all" for a theme that
 * was not. Measuring the unrounded composite is what makes the two agree.
 */
function compositeGammaExact(fgHex: string, bgHex: string): Rgb {
	const fg = parseHex(fgHex);
	const bg = parseHex(bgHex);
	const alpha = fg.alpha;
	return {
		r: fg.r * alpha + bg.r * (1 - alpha),
		g: fg.g * alpha + bg.g * (1 - alpha),
		b: fg.b * alpha + bg.b * (1 - alpha)
	};
}

/**
 * Is this wash pair separated by lightness alone once composited, as the gate
 * measures it?
 *
 * Takes the emitted alpha hexes and the plane rather than pre-composited hexes,
 * so that no rounding happens between what is written to the theme file and what
 * is measured. See compositeGammaExact.
 */
function washLightnessSeparated(addedHex: string, deletedHex: string, backgroundHex: string): boolean {
	const a = cielabLightnessRgb(compositeGammaExact(addedHex, backgroundHex));
	const b = cielabLightnessRgb(compositeGammaExact(deletedHex, backgroundHex));
	return Math.abs(a - b) >= requiredLightnessDelta((a + b) / 2);
}

/** WCAG contrast between two opaque hexes. */
function contrastOfHexes(a: string, b: string): number {
	return contrastRatio(parseHex(a), parseHex(b));
}

/**
 * CIELAB L* of an emitted hex.
 *
 * CIE L* is a function of Y alone, and Y for a D65 white point is exactly the
 * relative luminance WCAG already defines, so this is color.ts's own number put
 * through the CIELAB transfer function rather than a second colour pipeline.
 */
function cielabLightness(hex: string): number {
	return cielabLightnessRgb(parseHex(hex));
}

/** CIELAB L* of an RGB triple that has not been quantised to eight bits. */
function cielabLightnessRgb(rgb: Rgb): number {
	const y = relativeLuminance(rgb);
	const epsilon = (6 / 29) ** 3;
	return 116 * (y > epsilon ? Math.cbrt(y) : y / (3 * (6 / 29) ** 2) + 4 / 29) - 16;
}

/**
 * The lightness difference that is worth SEMANTIC_GATE_DELTA_E on its own at a
 * given mean lightness.
 *
 * This is validateTheme's `requiredLightnessDelta` - CIEDE2000 divides the
 * lightness term by SL >= 1, so a difference is worth its face value only at
 * L* 50 and less everywhere else - restated here because the validator keeps it
 * private. The two must agree; `assertLadder` re-derives the check from this
 * function on the emitted bytes, so a drift shows up as a failed build.
 */
function requiredLightnessDelta(lBar: number): number {
	return SEMANTIC_GATE_DELTA_E * (1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2));
}

const MONOCHROME_SAFE_SET: ReadonlySet<string> = new Set<string>(MONOCHROME_SAFE_ROLES);

/** Do these two roles have to be told apart with the hue channel switched off? */
function needsLightnessAlone(a: SemanticSlotId, b: SemanticSlotId): boolean {
	return MONOCHROME_SAFE_SET.has(a) && MONOCHROME_SAFE_SET.has(b);
}

/** Is this pair far enough apart in lightness alone? */
function lightnessSeparated(aHex: string, bHex: string): boolean {
	const a = cielabLightness(aHex);
	const b = cielabLightness(bHex);
	return Math.abs(a - b) >= requiredLightnessDelta((a + b) / 2);
}

/** `1A` for 26. Uppercase, two digits, which is the form every other value in the file takes. */
function alphaSuffix(alpha: number): string {
	return alpha.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * The lightness closest to `bgHex` at which `{C, h}` still clears `minRatio`.
 *
 * Bisection with a fixed iteration count, so the answer is deterministic. The
 * search runs outward from the background's own lightness, where the contrast
 * is 1 by construction, toward the endpoint.
 */
function contrastFrontier(C: number, h: number, bgHex: string, minRatio: number, mode: ThemeMode): number {
	const limit = mode === "dark" ? 1 : 0;
	if (effectiveContrast(placeOnLadder(C, h, limit), bgHex) < minRatio) {
		throw new Error(
			`generateTheme: no lightness at hue ${h.toFixed(1)} reaches ${minRatio}:1 against ${bgHex}; ` +
			`the background plane is too close to mid-grey for a legible semantic colour`
		);
	}
	let fail = lightness(bgHex);
	let pass = limit;
	for (let i = 0; i < 24; i++) {
		const mid = (fail + pass) / 2;
		if (effectiveContrast(placeOnLadder(C, h, mid), bgHex) >= minRatio) pass = mid;
		else fail = mid;
	}
	return pass;
}

/** A palette whose plane leaves too little room for the ladder it was asked for. */
export class LadderDoesNotFitError extends Error {}

/**
 * Places one ladder: each role at the first lightness, walking away from the
 * plane, that is far enough from every role already placed.
 *
 * Greedy from the nearest rung outward, which for a fixed order is also optimal
 * - a rung placed any nearer would fail a pair, and placing it further only
 * pushes everything after it further still. Deterministic: same seed, same
 * ladder, always.
 */
function placeLadder(
	seed: Seed,
	mode: ThemeMode,
	family: string,
	order: readonly SemanticLadderSlotId[],
	lightnessAlone: boolean
): readonly LadderRung[] {
	const bg = seed.editorBg;
	const direction = mode === "dark" ? 1 : -1;
	const hues = order.map(slot => hueAndChroma(seed, slot));
	const frontiers = hues.map(({ C, h }) => contrastFrontier(C, h, bg, MIN_SEMANTIC_CONTRAST, mode));

	const rungs: LadderRung[] = [];
	let L = frontiers[0];
	for (let i = 0; i < order.length; i++) {
		// A rung can never sit nearer the plane than its own contrast floor, whatever
		// the rung before it did: a blue and a yellow at the same OKLab L have very
		// different luminance, so the floor is per role.
		L = i === 0 ? L : (direction === 1 ? Math.max(L, frontiers[i]) : Math.min(L, frontiers[i]));
		for (;;) {
			if (L < SEMANTIC_LIGHTNESS_FLOOR || L > SEMANTIC_LIGHTNESS_CEILING) {
				throw new LadderDoesNotFitError(
					`generateTheme: the ${family} ladder cannot place "${order[i]}" inside the usable band ` +
					`[${SEMANTIC_LIGHTNESS_FLOOR}, ${SEMANTIC_LIGHTNESS_CEILING}]` +
					`${lightnessAlone ? " with the red-green roles separated by lightness alone" : ""}. ` +
					`The palette's editor background (${bg}) leaves too little room for ${order.length} roles at ` +
					`${SEMANTIC_TARGET_DELTA_E} dE00 and a ${MIN_SEMANTIC_CONTRAST}:1 floor.`
				);
			}
			const hex = placeOnLadder(hues[i].C, hues[i].h, L);
			const clash = rungs.some(placed =>
				worstObserverDistance(hex, placed.hex).deltaE < SEMANTIC_TARGET_DELTA_E ||
				(lightnessAlone && needsLightnessAlone(order[i], placed.slot) && !lightnessSeparated(hex, placed.hex)));
			if (!clash) {
				rungs.push({ slot: order[i], family, position: i, hex, lightness: lightness(hex), contrast: effectiveContrast(hex, bg) });
				break;
			}
			L += direction * LADDER_SEARCH_STEP;
		}
	}
	return rungs;
}

/** One solved wash pair: the two emitted `#RRGGBBAA` values and what they composite to. */
interface SolvedWash {
	readonly addedHex: string;
	readonly deletedHex: string;
	readonly addedComposite: string;
	readonly deletedComposite: string;
	readonly deltaE: number;
	readonly observer: string;
	readonly textContrast: number;
}

/**
 * Solves one wash strength in composited space.
 *
 * The inserted wash is bisected onto a target composited lightness so the band
 * is a visible tint of a known strength; the removed wash is then walked away
 * from the plane until the composited PAIR clears the target. Alphas are tried
 * smallest first, so a theme pays the least opacity that carries the
 * separation, and the offset falls back only when no alpha can carry the full
 * one without pushing body text below WCAG AA.
 */
function solveWash(
	seed: Seed,
	mode: ThemeMode,
	strength: WashStrength,
	addedParent: string,
	deletedParent: string,
	lightnessAlone: boolean
): SolvedWash {
	const bg = seed.editorBg;
	const fg = seed.editorFg;
	const direction = mode === "dark" ? 1 : -1;
	const backgroundLightness = lightness(bg);

	const tint = (parentHex: string, L: number): string => {
		const { C, h } = hexToOklch(parentHex);
		return placeOnLadder(C * WASH_CHROMA_FRACTION, h, L);
	};
	/** Has the gamut wall eaten the tint's hue at this lightness? */
	const keepsItsHue = (parentHex: string, L: number): boolean => {
		const { C, h } = hexToOklch(parentHex);
		const asked = C * WASH_CHROMA_FRACTION;
		if (asked === 0) return true;
		return hexToOklch(tint(parentHex, L)).C >= asked * WASH_MIN_CHROMA_RETENTION;
	};
	const composited = (parentHex: string, L: number, alpha: number): string =>
		compositeGamma(`${tint(parentHex, L)}${alphaSuffix(alpha)}`, bg);

	for (const fraction of WASH_OFFSET_FALLBACKS) {
		const target = backgroundLightness + direction * WASH_OFFSETS[strength] * fraction;
		for (const alpha of WASH_ALPHA_STEPS) {
			// The underlying lightness whose composite lands on the target tint.
			let low = 0;
			let high = 1;
			for (let i = 0; i < 40; i++) {
				const mid = (low + high) / 2;
				if (lightness(composited(addedParent, mid, alpha)) < target) low = mid;
				else high = mid;
			}
			const addedL = (low + high) / 2;
			const addedComposite = composited(addedParent, addedL, alpha);
			// This alpha cannot reach the tint at all: too little of the wash survives.
			if (Math.abs(lightness(addedComposite) - target) > 0.006) continue;
			if (contrastOfHexes(fg, addedComposite) < WASH_MIN_TEXT_CONTRAST) continue;
			if (!keepsItsHue(addedParent, addedL)) continue;

			const addedHex = `${tint(addedParent, addedL)}${alphaSuffix(alpha)}`;
			let L = addedL;
			for (let step = 0; step <= 600 && L >= 0 && L <= 1; step++) {
				const deletedComposite = composited(deletedParent, L, alpha);
				const deletedHex = `${tint(deletedParent, L)}${alphaSuffix(alpha)}`;
				const { deltaE, observer } = worstObserverDistance(addedComposite, deletedComposite);
				const textContrast = Math.min(contrastOfHexes(fg, addedComposite), contrastOfHexes(fg, deletedComposite));
				// An inserted and a removed band are green and warm: the owner's own
				// deficiency erases the difference between them, so the composited
				// pair carries the same lightness-alone requirement as the rungs.
				//
				// Measured off the emitted hexes with washLightnessSeparated rather
				// than off the rounded composites: this inequality has no margin, so
				// eight-bit rounding here is the difference between solving the pair
				// and only appearing to. See compositeGammaExact.
				if (
					keepsItsHue(deletedParent, L) &&
					deltaE >= WASH_TARGET_DELTA_E &&
					textContrast >= WASH_MIN_TEXT_CONTRAST &&
					(!lightnessAlone || washLightnessSeparated(addedHex, deletedHex, bg))
				) {
					return {
						addedHex,
						deletedHex,
						addedComposite,
						deletedComposite,
						deltaE,
						observer,
						textContrast
					};
				}
				L += direction * WASH_SEARCH_STEP;
			}
		}
	}

	throw new LadderDoesNotFitError(
		`generateTheme: no ${strength} diff wash over ${bg} can be ${WASH_TARGET_DELTA_E} dE00 apart under every ` +
		`observer while keeping editor.foreground (${fg}) at ${WASH_MIN_TEXT_CONTRAST}:1. The plane and the body ink ` +
		`are too close together to carry a diff background at all.`
	);
}

/**
 * Builds every synthesised semantic: the palette's hues, the ladders' lightness,
 * and the three composited wash pairs.
 */
export function synthesiseSemantics(seed: Seed, mode: ThemeMode): { readonly colors: Record<SemanticSlotId, string>; readonly ladder: SemanticLadder } {
	const colors = {} as Record<SemanticSlotId, string>;
	const rungs: LadderRung[] = [];
	const hueAssisted: string[] = [];
	for (const family of LADDER_FAMILIES) {
		// The stronger ladder first: every red-green confusable pair separated by
		// lightness alone. A plane too close to mid-grey - Pewter's #2D2D2D leaves
		// 30 L* above a 4.5:1 floor and the chain needs 32 - cannot pay for it, and
		// then the ladder falls back to the gate's own requirement and SAYS SO. The
		// fallback never lowers the gate: it drops an EXTRA guarantee, records which
		// family lost it, and buildThemes prints that next to the theme.
		let placed: readonly LadderRung[];
		try {
			placed = placeLadder(seed, mode, family.name, family.order, true);
		} catch (error) {
			if (!(error instanceof LadderDoesNotFitError)) throw error;
			placed = placeLadder(seed, mode, family.name, family.order, false);
			hueAssisted.push(family.name);
		}
		for (const rung of placed) {
			colors[rung.slot] = rung.hex;
			rungs.push(rung);
		}
	}

	const washes: LadderRung[] = [];
	let minWashTextContrast = Number.POSITIVE_INFINITY;
	const washPairs: LadderPair[] = [];
	let position = 0;
	for (const strength of ["line", "inline", "text"] as const) {
		const pair = WASH_PAIRS[strength];
		let solved: SolvedWash;
		try {
			solved = solveWash(seed, mode, strength, colors.added, colors.deleted, true);
		} catch (error) {
			if (!(error instanceof LadderDoesNotFitError)) throw error;
			solved = solveWash(seed, mode, strength, colors.added, colors.deleted, false);
			hueAssisted.push(`wash/${strength}`);
		}
		colors[pair.added] = solved.addedHex;
		colors[pair.deleted] = solved.deletedHex;
		washes.push(
			{ slot: pair.added, family: `wash/${strength}`, position: position++, hex: solved.addedHex, lightness: lightness(solved.addedComposite), contrast: effectiveContrast(solved.addedHex, seed.editorBg) },
			{ slot: pair.deleted, family: `wash/${strength}`, position: position++, hex: solved.deletedHex, lightness: lightness(solved.deletedComposite), contrast: effectiveContrast(solved.deletedHex, seed.editorBg) }
		);
		washPairs.push({
			family: `wash/${strength}`,
			a: pair.added,
			b: pair.deleted,
			deltaE: solved.deltaE,
			observer: solved.observer,
			lightnessAlone: washLightnessSeparated(solved.addedHex, solved.deletedHex, seed.editorBg)
		});
		minWashTextContrast = Math.min(minWashTextContrast, solved.textContrast);
	}

	return { colors, ladder: measureLadder([...rungs, ...washes], washPairs, mode, seed.editorBg, minWashTextContrast, hueAssisted) };
}

/** Measures a ladder set off the emitted hexes - what shipped, not what was intended. */
function measureLadder(
	rungs: readonly LadderRung[],
	washPairs: readonly LadderPair[],
	mode: ThemeMode,
	backgroundHex: string,
	minWashTextContrast: number,
	hueAssistedFamilies: readonly string[] = []
): SemanticLadder {
	const ladderRungs = rungs.filter(rung => !rung.family.startsWith("wash/"));
	const pairs: LadderPair[] = [...washPairs];
	let minDeltaLightness = Number.POSITIVE_INFINITY;
	let minDiffDeltaLightness = Number.POSITIVE_INFINITY;
	for (let i = 0; i < ladderRungs.length; i++) {
		for (let j = i + 1; j < ladderRungs.length; j++) {
			if (ladderRungs[i].family !== ladderRungs[j].family) continue;
			const { deltaE, observer } = worstObserverDistance(ladderRungs[i].hex, ladderRungs[j].hex);
			pairs.push({
				family: ladderRungs[i].family,
				a: ladderRungs[i].slot,
				b: ladderRungs[j].slot,
				deltaE,
				observer,
				lightnessAlone: needsLightnessAlone(ladderRungs[i].slot, ladderRungs[j].slot)
					? lightnessSeparated(ladderRungs[i].hex, ladderRungs[j].hex)
					: null
			});
			const delta = Math.abs(ladderRungs[i].lightness - ladderRungs[j].lightness);
			minDeltaLightness = Math.min(minDeltaLightness, delta);
			if (ladderRungs[i].family === "diff") minDiffDeltaLightness = Math.min(minDiffDeltaLightness, delta);
		}
	}
	return {
		mode,
		backgroundHex,
		rungs: [...rungs],
		pairs,
		minDeltaE: Math.min(...pairs.map(pair => pair.deltaE)),
		minDeltaLightness,
		minConfusableDeltaLightness: minDiffDeltaLightness,
		minContrast: Math.min(...ladderRungs.map(rung => rung.contrast)),
		minWashTextContrast,
		hueAssistedFamilies: [...hueAssistedFamilies]
	};
}

/**
 * Measures an arbitrary set of semantics - used to report on the hand-authored
 * ones next to the synthesised ones, which is the whole of the before/after
 * table `--check` prints.
 */
export function measureSemantics(colors: Readonly<Record<SemanticSlotId, string>>, mode: ThemeMode, backgroundHex: string): SemanticLadder {
	const rungs: LadderRung[] = [];
	for (const family of LADDER_FAMILIES) {
		family.order.forEach((slot, index) => {
			const hex = colors[slot];
			rungs.push({ slot, family: family.name, position: index, hex, lightness: lightness(hex), contrast: effectiveContrast(hex, backgroundHex) });
		});
	}
	const washPairs: LadderPair[] = [];
	let minWashTextContrast = Number.POSITIVE_INFINITY;
	let position = 0;
	for (const strength of ["line", "inline", "text"] as const) {
		const pair = WASH_PAIRS[strength];
		const addedComposite = compositeGamma(colors[pair.added], backgroundHex);
		const deletedComposite = compositeGamma(colors[pair.deleted], backgroundHex);
		const { deltaE, observer } = worstObserverDistance(addedComposite, deletedComposite);
		washPairs.push({
			family: `wash/${strength}`,
			a: pair.added,
			b: pair.deleted,
			deltaE,
			observer,
			lightnessAlone: washLightnessSeparated(colors[pair.added], colors[pair.deleted], backgroundHex)
		});
		rungs.push(
			{ slot: pair.added, family: `wash/${strength}`, position: position++, hex: colors[pair.added], lightness: lightness(addedComposite), contrast: effectiveContrast(colors[pair.added], backgroundHex) },
			{ slot: pair.deleted, family: `wash/${strength}`, position: position++, hex: colors[pair.deleted], lightness: lightness(deletedComposite), contrast: effectiveContrast(colors[pair.deleted], backgroundHex) }
		);
		minWashTextContrast = Math.min(minWashTextContrast, deltaE);
	}
	return measureLadder(rungs, washPairs, mode, backgroundHex, minWashTextContrast);
}

/**
 * The guarantee, re-checked against the bytes that will be written. Throws with
 * the whole table, because a near-miss is only diagnosable next to its peers.
 *
 * It asserts against SEMANTIC_GATE_DELTA_E - the number validateTheme.ts fails
 * on - and not against the target the search aimed at, so the assertion says
 * "this theme will pass the gate", which is the claim worth making.
 */
export function assertLadder(ladder: SemanticLadder): void {
	const problems: string[] = [];
	for (const pair of ladder.pairs) {
		if (pair.deltaE < SEMANTIC_GATE_DELTA_E) {
			problems.push(`${pair.family}: ${pair.a} vs ${pair.b} is ${pair.deltaE.toFixed(2)} dE00 under ${pair.observer} (floor ${SEMANTIC_GATE_DELTA_E})`);
		}
		if (pair.lightnessAlone === false && !ladder.hueAssistedFamilies.includes(pair.family)) {
			problems.push(`${pair.family}: ${pair.a} vs ${pair.b} leans on hue, and both roles collapse under a red-green deficiency`);
		}
	}
	if (ladder.minContrast < MIN_SEMANTIC_CONTRAST - 0.01) {
		problems.push(`a semantic sits at ${ladder.minContrast.toFixed(2)}:1 against ${ladder.backgroundHex} (floor ${MIN_SEMANTIC_CONTRAST})`);
	}
	if (problems.length === 0) return;

	const table = ladder.rungs
		.map(r => `    ${r.family.padEnd(11)} ${r.slot.padEnd(18)} pos ${r.position}  ${r.hex.padEnd(9)}  L ${r.lightness.toFixed(4)}  ${r.contrast.toFixed(2)}:1`)
		.join("\n");
	throw new Error(`generateTheme: the semantic ladders do not hold:\n  - ${problems.join("\n  - ")}\n${table}`);
}

// ---------------------------------------------------------------------------
// Palette resolution
// ---------------------------------------------------------------------------

/**
 * Fills the chrome surfaces a seed did not pin, from tokenMap's measured
 * fallbacks. Every shipping vibe pins all eleven, so this path is only reached
 * by a corpus palette - and the fallbacks are approximate by tokenMap's own
 * admission, which is why they carry their measured error there.
 */
export function resolveSurfaces(seed: Seed, pinned: Surfaces, mode: ThemeMode): Record<SurfaceSlotId, string> {
	const out = {} as Record<SurfaceSlotId, string>;
	for (const slot of SURFACE_SLOT_IDS) {
		const supplied = pinned[slot];
		if (supplied !== undefined) {
			out[slot] = normaliseHex(supplied, `surfaces.${slot}`);
			continue;
		}
		const fallback = SURFACE_FALLBACKS[slot];
		const rule = fallback[mode];
		const from = seed[fallback.from as SeedSlotId] ?? out[fallback.from as SurfaceSlotId];
		if (from === undefined) throw new Error(`generateTheme: surface fallback for "${slot}" reads unknown slot "${fallback.from}"`);
		const toward =
			rule.toward === "white" ? "#FFFFFF" :
				rule.toward === "black" ? "#000000" :
					seed[rule.toward as SeedSlotId] ?? out[rule.toward as SurfaceSlotId];
		if (toward === undefined) throw new Error(`generateTheme: surface fallback for "${slot}" mixes toward unknown slot "${rule.toward}"`);
		out[slot] = mixHexSrgb(from, toward, rule.amount);
	}
	return out;
}

/** Assembles every slot the token map can name. */
export function resolvePalette(seed: Seed, surfaces: Surfaces, mode: ThemeMode, options: ExpandOptions = {}): { readonly palette: Palette; readonly ladder: SemanticLadder } {
	const resolvedSurfaces = resolveSurfaces(seed, surfaces, mode);

	const synthesised = synthesiseSemantics(seed, mode);
	const semantics = options.pinnedSemantics ?? synthesised.colors;
	const ladder = options.pinnedSemantics === undefined
		? synthesised.ladder
		: measureSemantics(options.pinnedSemantics, mode, seed.editorBg);
	if (options.skipLadderCheck !== true && options.pinnedSemantics === undefined) assertLadder(ladder);

	const base: Record<string, string> = {};
	for (const slot of SEED_SLOT_IDS) base[slot] = normaliseHex(seed[slot], `seed.${slot}`);
	for (const slot of SURFACE_SLOT_IDS) base[slot] = resolvedSurfaces[slot];
	for (const slot of SEMANTIC_SLOT_IDS) base[slot] = normaliseHex(semantics[slot], `semantics.${slot}`);

	const modeSlots = resolveModeSlots(base, mode);
	for (const slot of MODE_SLOT_IDS) base[slot] = modeSlots[slot];

	return { palette: base as Record<SlotId, string>, ladder };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/** Seed + meta -> the complete theme object. Same input, same output, always. */
export function expandSeed(seed: Seed, surfaces: Surfaces, meta: VariantMeta, options: ExpandOptions = {}): { readonly theme: ColorTheme; readonly ladder: SemanticLadder } {
	validateSeed(seed);
	const { palette, ladder } = resolvePalette(seed, surfaces, meta.mode, options);
	const theme: ColorTheme = {
		$schema: "vscode://schemas/color-theme",
		name: meta.name,
		type: meta.mode,
		colors: buildColors(palette, meta.mode),
		tokenColors: buildTokenColors(palette, meta.syntaxEmphasis),
		semanticHighlighting: true
	};
	return { theme, ladder };
}

/**
 * The exact on-disk form. Tabs and a trailing newline, verified to round-trip
 * all six shipping files unchanged, so a generated theme diffs cleanly against
 * a hand-authored one.
 */
export function serialiseTheme(theme: ColorTheme): string {
	return `${JSON.stringify(theme, null, "\t")}\n`;
}

/** `primal-ink-color-theme.json` for `ink`. */
export function themeFileName(variantId: string): string {
	return `primal-${variantId}-color-theme.json`;
}

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

/** Uppercases and normalises, and rejects anything that is not a hex colour. */
function normaliseHex(value: string, where: string): string {
	try {
		const rgba = parseHex(value);
		return rgba.alpha >= 1
			? `#${[rgba.r, rgba.g, rgba.b].map(c => c.toString(16).toUpperCase().padStart(2, "0")).join("")}`
			: value.toUpperCase();
	} catch {
		throw new Error(`generateTheme: ${where} is not a hex colour: ${JSON.stringify(value)}`);
	}
}

function validateSeed(seed: Seed): void {
	const missing = SEED_SLOT_IDS.filter(slot => typeof seed[slot] !== "string");
	if (missing.length > 0) {
		throw new Error(`generateTheme: seed is missing ${missing.length} slot(s): ${missing.join(", ")}`);
	}
	for (const slot of SEED_SLOT_IDS) normaliseHex(seed[slot], `seed.${slot}`);
}

// ---------------------------------------------------------------------------
// --check: the fidelity gate.
// ---------------------------------------------------------------------------

interface RawVariant {
	readonly id: string;
	readonly label: string;
	readonly mode: string;
	readonly seed: Record<string, string>;
	readonly surfaces?: Record<string, string>;
}

interface RawFamily {
	readonly id: string;
	readonly syntaxEmphasis: string;
	readonly variants: readonly RawVariant[];
}

interface RawVibeTokens {
	readonly version: number;
	readonly colorThemeExtension: string;
	readonly families: readonly RawFamily[];
}

interface LoadedVariant {
	readonly id: string;
	readonly meta: VariantMeta;
	readonly seed: Seed;
	readonly surfaces: Surfaces;
}

interface FixtureVibe {
	readonly id: string;
	readonly palette: Record<string, string>;
	readonly colors: Record<string, string>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

function loadVariants(): { readonly variants: readonly LoadedVariant[]; readonly extension: string } {
	const raw = JSON.parse(readFileSync(join(REPO, "primal", "design", "vibe-tokens.json"), "utf8")) as RawVibeTokens;
	if (raw.version !== 2) throw new Error(`generateTheme: vibe-tokens.json is v${raw.version}; this generator reads v2`);

	const variants: LoadedVariant[] = [];
	for (const family of raw.families) {
		if (family.syntaxEmphasis !== "weight" && family.syntaxEmphasis !== "plain") {
			throw new Error(`generateTheme: family "${family.id}" has unknown syntaxEmphasis ${JSON.stringify(family.syntaxEmphasis)}`);
		}
		for (const variant of family.variants) {
			if (variant.mode !== "light" && variant.mode !== "dark") {
				throw new Error(`generateTheme: variant "${variant.id}" has unknown mode ${JSON.stringify(variant.mode)}`);
			}
			variants.push({
				id: variant.id,
				meta: { name: variant.label, mode: variant.mode, syntaxEmphasis: family.syntaxEmphasis },
				seed: variant.seed as Seed,
				surfaces: (variant.surfaces ?? {}) as Surfaces
			});
		}
	}
	return { variants, extension: raw.colorThemeExtension };
}

function loadFixture(): Map<string, FixtureVibe> {
	const fixture = JSON.parse(readFileSync(join(HERE, "tokenMap.test-fixture.json"), "utf8")) as { readonly vibes: readonly FixtureVibe[] };
	return new Map(fixture.vibes.map(v => [v.id, v]));
}

const REROUTED_TOKEN_SET: ReadonlySet<string> = new Set(REROUTED_TOKENS.map(entry => entry.token));

function pinnedSemanticsFrom(palette: Record<string, string>): Record<SemanticSlotId, string> {
	const out = {} as Record<SemanticSlotId, string>;
	for (const slot of SEMANTIC_SLOT_IDS) {
		const value = palette[slot];
		if (value === undefined) throw new Error(`generateTheme: fixture palette has no "${slot}"`);
		out[slot] = value;
	}
	return out;
}

/** Which slot a workbench token hangs off, for explaining a diff. */
function slotOfToken(token: string): string {
	const entry = WORKBENCH_TOKENS.find(t => t.token === token);
	if (entry === undefined) return "?";
	return "literal" in entry ? "literal" : entry.from;
}

function printLadder(title: string, ladder: SemanticLadder): void {
	console.log(`    ${title}`);
	for (const rung of ladder.rungs) {
		console.log(`      ${rung.family.padEnd(12)} ${rung.slot.padEnd(18)} ${rung.hex.padEnd(9)}  L ${rung.lightness.toFixed(4)}  ${rung.contrast.toFixed(2)}:1`);
	}
	const worst = [...ladder.pairs].sort((a, b) => a.deltaE - b.deltaE)[0];
	const leaning = ladder.pairs.filter(pair => pair.lightnessAlone === false).length;
	console.log(
		`      worst pair ${worst.a} vs ${worst.b} ${worst.deltaE.toFixed(2)} dE00 under ${worst.observer}   ` +
		`min contrast ${ladder.minContrast.toFixed(2)}:1   ` +
		`${leaning} red-green pair(s) leaning on hue`
	);
}

/**
 * The three parts of the gate, which must not be conflated.
 *
 *  1. THE MAP PATH. Generating with the hand-authored semantics pinned must
 *     reproduce the six themes as they were, byte for byte, from the record in
 *     tokenMap.test-fixture.json - except at the tokens tokenMap.REROUTED_TOKENS
 *     declares. A failure here is a bug in the map.
 *
 *     This used to compare against the shipping theme FILES. It cannot any more,
 *     because the shipping files are now generated from the ladder, which is the
 *     point of the change; the fixture is the record of what the six were, and
 *     tokenMap.ts --check is what stops that record from rotting.
 *
 *  2. THE LADDER PATH. Generating with synthesis on changes exactly the tokens
 *     that hang off a semantic slot, and every change is listed with its before
 *     and after. That is the intended improvement, not a failure. A change NOT
 *     explained by a semantic slot is a bug and fails.
 *
 *  3. WHAT SHIPPED. The theme file on disk must be exactly what synthesis
 *     produces, so nobody can hand-edit a semantic colour back in.
 */
function selfCheck(): number {
	const { variants, extension } = loadVariants();
	const fixture = loadFixture();
	let hardFailures = 0;
	let totalSemanticChanges = 0;

	console.log("=".repeat(78));
	console.log("PART 1  map path - synthesis off, hand-authored semantics pinned.");
	console.log("         Must reproduce tokenMap.test-fixture.json, which is the record of");
	console.log("         the six themes as they were before the ladders landed.");
	console.log("=".repeat(78));

	for (const variant of variants) {
		const recorded = fixture.get(variant.id);
		if (recorded === undefined) {
			console.error(`  ${variant.id}: no fixture entry; cannot pin the hand-authored semantics`);
			hardFailures++;
			continue;
		}
		const { theme } = expandSeed(variant.seed, variant.surfaces, variant.meta, { pinnedSemantics: pinnedSemanticsFrom(recorded.palette) });
		const differing = Object.keys(recorded.colors).filter(key => recorded.colors[key].toUpperCase() !== (theme.colors[key] ?? "").toUpperCase());
		const undeclared = differing.filter(key => !REROUTED_TOKEN_SET.has(key));
		if (undeclared.length === 0) {
			console.log(`  ${variant.id.padEnd(7)} reproduces the hand-authored fixture (${Object.keys(theme.colors).length} colours, ${differing.length} declared re-route(s))`);
			continue;
		}
		hardFailures++;
		console.error(`  ${variant.id.padEnd(7)} DIFFERS at ${undeclared.length} undeclared colour key(s)`);
		for (const key of undeclared.slice(0, 40)) {
			console.error(`      ${key}: generated ${theme.colors[key]}, hand-authored ${recorded.colors[key]}  [slot ${slotOfToken(key)}]`);
		}
	}

	console.log("");
	console.log("=".repeat(78));
	console.log("PART 2  ladder path - semantics synthesised. Every change below is");
	console.log("         INTENDED: the hand-authored semantics are not separated by");
	console.log("         lightness, and this is what fixes that. Declared, not hidden.");
	console.log("=".repeat(78));

	for (const variant of variants) {
		const recorded = fixture.get(variant.id);
		const { theme, ladder } = expandSeed(variant.seed, variant.surfaces, variant.meta);
		if (recorded === undefined) continue;

		const differing = Object.keys(recorded.colors).filter(key => recorded.colors[key].toUpperCase() !== (theme.colors[key] ?? "").toUpperCase());
		const nonSemantic = differing.filter(key => !(SEMANTIC_SLOT_IDS as readonly string[]).includes(slotOfToken(key)) && !REROUTED_TOKEN_SET.has(key));
		totalSemanticChanges += differing.length;

		console.log(`\n  ${variant.id} (${variant.meta.mode})`);
		console.log(`    ${differing.length} of ${Object.keys(theme.colors).length} workbench colours changed`);
		if (nonSemantic.length > 0) {
			hardFailures++;
			console.error(`    !! ${nonSemantic.length} change(s) NOT explained by a semantic slot - that is a bug, not an improvement:`);
			for (const key of nonSemantic.slice(0, 20)) {
				console.error(`       ${key}: ${recorded.colors[key]} -> ${theme.colors[key]}  [slot ${slotOfToken(key)}]`);
			}
		}

		// The table the owner actually reads: every synthesised slot, before and after.
		const after = synthesiseSemantics(variant.seed, variant.meta.mode).colors;
		console.log("    slot                before      after");
		for (const slot of SEMANTIC_SLOT_IDS) {
			console.log(`      ${slot.padEnd(18)} ${recorded.palette[slot].padEnd(11)} ${after[slot]}`);
		}
		printLadder("before (hand-authored):", measureSemantics(pinnedSemanticsFrom(recorded.palette), variant.meta.mode, variant.seed.editorBg));
		printLadder("after (synthesised):", ladder);
		assertLadder(ladder);
	}

	console.log("");
	console.log("=".repeat(78));
	console.log("PART 3  what shipped - the theme file on disk must BE the synthesised output.");
	console.log("=".repeat(78));

	for (const variant of variants) {
		const path = join(REPO, "extensions", extension, "themes", themeFileName(variant.id));
		const generated = serialiseTheme(expandSeed(variant.seed, variant.surfaces, variant.meta).theme);
		let onDisk: string;
		try {
			onDisk = readFileSync(path, "utf8");
		} catch {
			console.error(`  ${variant.id.padEnd(7)} MISSING on disk`);
			hardFailures++;
			continue;
		}
		if (onDisk === generated) {
			console.log(`  ${variant.id.padEnd(7)} on disk is byte-identical to the synthesised theme`);
			continue;
		}
		hardFailures++;
		console.error(`  ${variant.id.padEnd(7)} on disk DIFFERS from the synthesised theme; run buildThemes.ts`);
	}

	// Determinism: byte-identical output for a repeated call on the same input.
	for (const variant of variants) {
		const a = serialiseTheme(expandSeed(variant.seed, variant.surfaces, variant.meta).theme);
		const b = serialiseTheme(expandSeed(variant.seed, variant.surfaces, variant.meta).theme);
		if (a !== b) {
			console.error(`  ${variant.id}: expandSeed is not deterministic`);
			hardFailures++;
		}
	}

	console.log("");
	if (hardFailures > 0) {
		console.error(`generateTheme: ${hardFailures} hard failure(s)`);
		return 1;
	}
	console.log(`generateTheme: ${variants.length} vibes reproduce their hand-authored fixture with semantics pinned;`);
	console.log(`               synthesis then changes ${totalSemanticChanges} semantic-derived colours across them, by design,`);
	console.log(`               and every ladder holds >= ${SEMANTIC_GATE_DELTA_E} dE00 under every observer and >= ${MIN_SEMANTIC_CONTRAST}:1.`);
	console.log(`               expandSeed is deterministic for all ${variants.length}.`);
	return 0;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	process.exit(selfCheck());
}
