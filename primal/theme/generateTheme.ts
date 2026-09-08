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
 * The owner is colour blind - amber reads as green - so error / warning /
 * info / added / deleted / modified / conflict cannot be distinguished by hue.
 * They have to differ in LIGHTNESS. A hand-authored palette cannot promise
 * that, and measuring the six shipping themes shows it never happened:
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
 * So the generator takes the palette's own hues and re-lights them onto a
 * ladder, which makes the separation true by construction and measurable
 * afterwards. That deliberately changes those values in the six shipping
 * themes; `--check` prints the before/after for every one.
 *
 * Run the fidelity gate, which is this file's acceptance test:
 *
 *   node --experimental-strip-types primal/theme/generateTheme.ts --check
 *
 * It reports two things separately, and they must not be conflated:
 *   1. The map path. Generating with the shipping semantics pinned must
 *      reproduce all six theme files BYTE for byte. A failure here is a bug.
 *   2. The ladder. Generating with synthesised semantics changes exactly the
 *      tokens that hang off a semantic slot, and every change is listed. That
 *      is the intended improvement, not a failure.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	MODE_SLOT_IDS,
	SEED_SLOT_IDS,
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
	effectiveContrast,
	hexToOklch,
	lightness,
	maxChroma,
	mixHexSrgb,
	oklchToHex,
	parseHex
} from "./color.ts";

// ---------------------------------------------------------------------------
// The semantic lightness ladder.
//
// THE COLOUR-BLINDNESS REASON, stated once, because every constant below is
// downstream of it:
//
// Under a red-green deficiency (the owner's: amber reads as green) red, orange,
// amber and green all collapse onto one washed-out yellow axis. Five of the
// seven semantic roles - error, deleted, conflict, warning, added - live on
// that axis, so for this user they have NO hue difference at all and lightness
// is the only channel left. Blue survives the deficiency, so info and modified
// keep a real hue difference from the warm five and only need separating from
// each other.
//
// Hence two ladders on one grid:
//
//   grid position   0        1         2       3        4
//   warm ladder     warning  conflict  added   deleted  error
//   cool ladder          0.5 modified       2.5 info
//
// Position 0 is the rung NEAREST the editor background (quietest, lowest
// contrast) and position 4 is furthest (loudest). The role order is not
// arbitrary:
//
//   - warning sits at 0 because it also drives the find-match washes
//     (editor.findMatchBackground at 55 alpha, and five more). Dragging it to
//     a high rung turns a light theme's find highlight into a dark smear.
//   - error sits at 4 because it is the one colour that must never be missed,
//     and the far rung is the highest-contrast one.
//   - added sits between warning and error, so the owner's specifically named
//     confusion - amber vs green - gets TWO steps rather than one, and green
//     vs red gets two.
//   - the cool pair is offset by half a step so that no two semantic colours
//     anywhere in the theme land on the same lightness. That protects the
//     (much rarer) blue-yellow deficiency too, at no cost to the warm budget.
// ---------------------------------------------------------------------------

/**
 * The smallest lightness gap, in OKLab L (0 = black, 1 = white), allowed
 * between two semantic colours that share a hue axis under red-green colour
 * blindness.
 *
 * 0.06 is not a taste call: it is the LARGEST step the tightest palette can
 * afford. A light theme has to fit five warm rungs between the 4.5:1 contrast
 * floor (around L 0.55 on paper) and the point where a colour stops reading as
 * a colour at all (the floor below), which is about 0.25 of lightness - so
 * 4 * 0.06 = 0.24 uses essentially all of it. It buys roughly 1.28:1 WCAG
 * contrast between adjacent rungs, which survives being rendered as a 1px
 * gutter bar or a single glyph.
 */
export const SEMANTIC_LADDER_STEP = 0.06;

/**
 * Where the cool pair sits between warm rungs, as a fraction of a step. Half a
 * step is the most it can be without landing on a warm rung on one side or the
 * other.
 */
export const COOL_LADDER_OFFSET = 0.5;

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
 * cannot fit its ladder between them is rejected loudly rather than squeezed.
 */
export const SEMANTIC_LIGHTNESS_FLOOR = 0.24;
export const SEMANTIC_LIGHTNESS_CEILING = 0.92;

/**
 * Slack allowed when re-measuring the ladder off the emitted hexes. Rounding an
 * OKLCH colour to 8 bits per channel moves its lightness by up to ~0.002, so an
 * exact >= comparison against the step would fail on quantisation alone.
 */
export const LADDER_QUANTISATION_SLACK = 0.005;

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
 * 0.85 of the cusp gives #5E110B instead - the same deep oxblood, still clearly
 * the palette's own. It only ever bites at the far rungs; at the near rungs the
 * palette's own chroma is well inside the wall and is passed through untouched.
 */
export const MAX_GAMUT_FRACTION = 0.85;

/** Where each semantic role sits on the ladder grid. */
const LADDER_POSITION: Readonly<Record<SemanticSlotId, number>> = {
	warning: 0,
	modified: 0 + COOL_LADDER_OFFSET,
	conflict: 1,
	added: 2,
	info: 2 + COOL_LADDER_OFFSET,
	deleted: 3,
	error: 4
};

/**
 * Roles that collapse onto one hue under a red-green deficiency. Any two of
 * these must be a full step apart; the pairs that also involve a cool role only
 * have to clear the half step.
 */
const RED_GREEN_CONFUSABLE: readonly SemanticSlotId[] = ["warning", "conflict", "added", "deleted", "error"];

/** Where a semantic role takes its hue and chroma from. */
type HueSource =
	| { readonly kind: "seed"; readonly slot: SeedSlotId }
	| { readonly kind: "blend"; readonly from: SeedSlotId; readonly toward: SeedSlotId; readonly amount: number };

/**
 * The palette's OWN hues, never a fixed red or green. A palette that tints its
 * ANSI ramp toward its planes gets semantics tinted the same way; only the
 * lightness is taken away from it.
 */
const HUE_SOURCE: Readonly<Record<SemanticSlotId, HueSource>> = {
	error: { kind: "seed", slot: "ansiRed" },
	deleted: { kind: "seed", slot: "ansiRed" },
	warning: { kind: "seed", slot: "ansiYellow" },
	conflict: { kind: "blend", from: "ansiRed", toward: "ansiYellow", amount: CONFLICT_HUE_MIX },
	added: { kind: "seed", slot: "ansiGreen" },
	info: { kind: "seed", slot: "ansiBlue" },
	modified: { kind: "seed", slot: "ansiBlue" }
};

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
	readonly position: number;
	readonly hex: string;
	readonly lightness: number;
	readonly contrast: number;
}

/** The whole ladder, measured off the emitted hexes rather than the intent. */
export interface SemanticLadder {
	readonly mode: ThemeMode;
	readonly backgroundHex: string;
	readonly anchorLightness: number;
	readonly rungs: readonly LadderRung[];
	/** Smallest |ΔL| between any two semantic colours. */
	readonly minDeltaLightness: number;
	/** Smallest |ΔL| within the red-green confusable five. The load-bearing one. */
	readonly minConfusableDeltaLightness: number;
	/** Worst contrast any rung has against the editor background. */
	readonly minContrast: number;
}

/** Shortest-arc hue interpolation, in degrees. */
function mixHue(from: number, toward: number, amount: number): number {
	const delta = ((toward - from + 540) % 360) - 180;
	return (from + delta * amount + 360) % 360;
}

/** Chroma and hue for a role, taken from the seed. Lightness comes from the ladder. */
function hueAndChroma(seed: Seed, slot: SemanticSlotId): { readonly C: number; readonly h: number } {
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

/**
 * Builds the seven semantic colours: the palette's hues, the ladder's lightness.
 *
 * The anchor is chosen so that EVERY rung clears the contrast floor, not just
 * the nearest one - a saturated blue and a saturated yellow at the same OKLab L
 * have very different luminance, so the frontier is computed per role and the
 * ladder is placed at the most demanding of them.
 */
export function synthesiseSemantics(seed: Seed, mode: ThemeMode): { readonly colors: Record<SemanticSlotId, string>; readonly ladder: SemanticLadder } {
	const bg = seed.editorBg;
	const direction = mode === "dark" ? 1 : -1;

	// Each role's own frontier, translated back to where the anchor would have
	// to sit for that role to clear the floor at its own grid position.
	let anchor = direction * -Infinity;
	for (const slot of SEMANTIC_SLOT_IDS) {
		const { C, h } = hueAndChroma(seed, slot);
		const frontier = contrastFrontier(C, h, bg, MIN_SEMANTIC_CONTRAST, mode);
		const required = frontier - direction * LADDER_POSITION[slot] * SEMANTIC_LADDER_STEP;
		anchor = mode === "dark" ? Math.max(anchor, required) : Math.min(anchor, required);
	}

	const colors = {} as Record<SemanticSlotId, string>;
	const rungs: LadderRung[] = [];
	for (const slot of SEMANTIC_SLOT_IDS) {
		const { C, h } = hueAndChroma(seed, slot);
		const target = anchor + direction * LADDER_POSITION[slot] * SEMANTIC_LADDER_STEP;
		if (target < SEMANTIC_LIGHTNESS_FLOOR || target > SEMANTIC_LIGHTNESS_CEILING) {
			throw new Error(
				`generateTheme: semantic "${slot}" needs lightness ${target.toFixed(3)}, outside the usable band ` +
				`[${SEMANTIC_LIGHTNESS_FLOOR}, ${SEMANTIC_LIGHTNESS_CEILING}]. The palette's editor background ` +
				`(${bg}) leaves too little room for a ${SEMANTIC_SLOT_IDS.length}-rung ladder at step ` +
				`${SEMANTIC_LADDER_STEP} and a ${MIN_SEMANTIC_CONTRAST}:1 floor.`
			);
		}
		const hex = placeOnLadder(C, h, target);
		colors[slot] = hex;
		rungs.push({ slot, position: LADDER_POSITION[slot], hex, lightness: lightness(hex), contrast: effectiveContrast(hex, bg) });
	}

	return { colors, ladder: measureLadder(rungs, mode, bg, anchor) };
}

/** Measures a ladder off the emitted hexes - what shipped, not what was intended. */
function measureLadder(rungs: readonly LadderRung[], mode: ThemeMode, backgroundHex: string, anchorLightness: number): SemanticLadder {
	let minDelta = Infinity;
	let minConfusable = Infinity;
	for (let i = 0; i < rungs.length; i++) {
		for (let j = i + 1; j < rungs.length; j++) {
			const delta = Math.abs(rungs[i].lightness - rungs[j].lightness);
			minDelta = Math.min(minDelta, delta);
			if (RED_GREEN_CONFUSABLE.includes(rungs[i].slot) && RED_GREEN_CONFUSABLE.includes(rungs[j].slot)) {
				minConfusable = Math.min(minConfusable, delta);
			}
		}
	}
	return {
		mode,
		backgroundHex,
		anchorLightness,
		rungs: [...rungs].sort((a, b) => a.position - b.position),
		minDeltaLightness: minDelta,
		minConfusableDeltaLightness: minConfusable,
		minContrast: Math.min(...rungs.map(r => r.contrast))
	};
}

/** Measures an arbitrary set of semantics - used to report on the hand-authored ones. */
export function measureSemantics(colors: Readonly<Record<SemanticSlotId, string>>, mode: ThemeMode, backgroundHex: string): SemanticLadder {
	const rungs = SEMANTIC_SLOT_IDS.map(slot => ({
		slot,
		position: LADDER_POSITION[slot],
		hex: colors[slot],
		lightness: lightness(colors[slot]),
		contrast: effectiveContrast(colors[slot], backgroundHex)
	}));
	return measureLadder(rungs, mode, backgroundHex, Number.NaN);
}

/**
 * The guarantee, re-checked against the bytes that will be written. Throws with
 * the whole table, because a near-miss is only diagnosable next to its peers.
 */
export function assertLadder(ladder: SemanticLadder): void {
	const confusableFloor = SEMANTIC_LADDER_STEP - LADDER_QUANTISATION_SLACK;
	const anyFloor = SEMANTIC_LADDER_STEP * COOL_LADDER_OFFSET - LADDER_QUANTISATION_SLACK;
	const contrastFloor = MIN_SEMANTIC_CONTRAST - 0.01;

	const problems: string[] = [];
	if (ladder.minConfusableDeltaLightness < confusableFloor) {
		problems.push(`two red-green confusable semantics are only ΔL ${ladder.minConfusableDeltaLightness.toFixed(4)} apart (floor ${confusableFloor.toFixed(4)})`);
	}
	if (ladder.minDeltaLightness < anyFloor) {
		problems.push(`two semantics are only ΔL ${ladder.minDeltaLightness.toFixed(4)} apart (floor ${anyFloor.toFixed(4)})`);
	}
	if (ladder.minContrast < contrastFloor) {
		problems.push(`a semantic sits at ${ladder.minContrast.toFixed(2)}:1 against ${ladder.backgroundHex} (floor ${MIN_SEMANTIC_CONTRAST})`);
	}
	if (problems.length === 0) return;

	const table = ladder.rungs
		.map(r => `    ${r.slot.padEnd(9)} pos ${r.position.toFixed(1)}  ${r.hex}  L ${r.lightness.toFixed(4)}  ${r.contrast.toFixed(2)}:1`)
		.join("\n");
	throw new Error(`generateTheme: the semantic ladder does not hold:\n  - ${problems.join("\n  - ")}\n${table}`);
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

function loadFixturePalettes(): Map<string, Record<string, string>> {
	const fixture = JSON.parse(readFileSync(join(HERE, "tokenMap.test-fixture.json"), "utf8")) as { readonly vibes: readonly FixtureVibe[] };
	return new Map(fixture.vibes.map(v => [v.id, v.palette]));
}

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
		console.log(`      ${rung.slot.padEnd(9)} pos ${rung.position.toFixed(1)}  ${rung.hex}  L ${rung.lightness.toFixed(4)}  ${rung.contrast.toFixed(2)}:1`);
	}
	console.log(`      min ΔL (red-green confusable) ${ladder.minConfusableDeltaLightness.toFixed(4)}   min ΔL (any pair) ${ladder.minDeltaLightness.toFixed(4)}   min contrast ${ladder.minContrast.toFixed(2)}:1`);
}

function selfCheck(): number {
	const { variants, extension } = loadVariants();
	const fixturePalettes = loadFixturePalettes();
	let hardFailures = 0;
	let totalSemanticChanges = 0;

	console.log("=".repeat(78));
	console.log("PART 1  map path - synthesis off, shipping semantics pinned.");
	console.log("         Must be byte-identical to the shipping theme files.");
	console.log("=".repeat(78));

	for (const variant of variants) {
		const palette = fixturePalettes.get(variant.id);
		if (palette === undefined) {
			console.error(`  ${variant.id}: no fixture palette; cannot pin the shipping semantics`);
			hardFailures++;
			continue;
		}
		const shippedPath = join(REPO, "extensions", extension, "themes", themeFileName(variant.id));
		const shipped = readFileSync(shippedPath, "utf8");
		const { theme } = expandSeed(variant.seed, variant.surfaces, variant.meta, { pinnedSemantics: pinnedSemanticsFrom(palette) });
		const generated = serialiseTheme(theme);

		if (generated === shipped) {
			console.log(`  ${variant.id.padEnd(7)} byte-identical (${generated.length} bytes, ${Object.keys(theme.colors).length} colours, ${theme.tokenColors.length} tokenColors)`);
			continue;
		}
		hardFailures++;
		const shippedTheme = JSON.parse(shipped) as ColorTheme;
		const differing = Object.keys(shippedTheme.colors).filter(k => shippedTheme.colors[k] !== theme.colors[k]);
		console.error(`  ${variant.id.padEnd(7)} DIFFERS (${generated.length} vs ${shipped.length} bytes, ${differing.length} colour key(s))`);
		for (const key of differing.slice(0, 40)) {
			console.error(`      ${key}: generated ${theme.colors[key]}, shipped ${shippedTheme.colors[key]}  [slot ${slotOfToken(key)}]`);
		}
		if (JSON.stringify(shippedTheme.tokenColors) !== JSON.stringify(theme.tokenColors)) {
			console.error("      tokenColors differ");
		}
	}

	console.log("");
	console.log("=".repeat(78));
	console.log("PART 2  ladder path - semantics synthesised. Every change below is");
	console.log("         INTENDED: the hand-authored semantics are not separated by");
	console.log("         lightness, and this is what fixes that. Declared, not hidden.");
	console.log("=".repeat(78));

	for (const variant of variants) {
		const palette = fixturePalettes.get(variant.id);
		const shippedPath = join(REPO, "extensions", extension, "themes", themeFileName(variant.id));
		const shippedTheme = JSON.parse(readFileSync(shippedPath, "utf8")) as ColorTheme;
		const { theme, ladder } = expandSeed(variant.seed, variant.surfaces, variant.meta);

		const differing = Object.keys(shippedTheme.colors).filter(k => shippedTheme.colors[k] !== theme.colors[k]);
		const nonSemantic = differing.filter(k => !(SEMANTIC_SLOT_IDS as readonly string[]).includes(slotOfToken(k)));
		const changedTokenColors = theme.tokenColors.filter((row, i) => JSON.stringify(row) !== JSON.stringify(shippedTheme.tokenColors[i])).length;
		totalSemanticChanges += differing.length;

		console.log(`\n  ${variant.id} (${variant.meta.mode})`);
		console.log(`    ${differing.length} of ${Object.keys(theme.colors).length} workbench colours changed, ${changedTokenColors} of ${theme.tokenColors.length} tokenColors changed`);
		if (nonSemantic.length > 0) {
			hardFailures++;
			console.error(`    !! ${nonSemantic.length} change(s) NOT explained by a semantic slot - that is a bug, not an improvement:`);
			for (const key of nonSemantic.slice(0, 20)) {
				console.error(`       ${key}: ${shippedTheme.colors[key]} -> ${theme.colors[key]}  [slot ${slotOfToken(key)}]`);
			}
		}

		if (palette !== undefined) {
			const before = measureSemantics(pinnedSemanticsFrom(palette), variant.meta.mode, variant.seed.editorBg);
			printLadder("before (hand-authored):", before);
		}
		printLadder("after (synthesised):", ladder);
		assertLadder(ladder);
	}

	console.log("");
	console.log("=".repeat(78));

	// Determinism: byte-identical output for a repeated call on the same input.
	for (const variant of variants) {
		const a = serialiseTheme(expandSeed(variant.seed, variant.surfaces, variant.meta).theme);
		const b = serialiseTheme(expandSeed(variant.seed, variant.surfaces, variant.meta).theme);
		if (a !== b) {
			console.error(`  ${variant.id}: expandSeed is not deterministic`);
			hardFailures++;
		}
	}

	if (hardFailures > 0) {
		console.error(`generateTheme: ${hardFailures} hard failure(s)`);
		return 1;
	}
	console.log(`generateTheme: ${variants.length} vibes reproduce their shipping theme byte for byte with semantics pinned;`);
	console.log(`               synthesis then changes ${totalSemanticChanges} semantic-derived colours across them, by design,`);
	console.log(`               and every generated ladder holds ΔL >= ${(SEMANTIC_LADDER_STEP - LADDER_QUANTISATION_SLACK).toFixed(3)} and >= ${MIN_SEMANTIC_CONTRAST}:1.`);
	console.log(`               expandSeed is deterministic for all ${variants.length}.`);
	return 0;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	process.exit(selfCheck());
}
