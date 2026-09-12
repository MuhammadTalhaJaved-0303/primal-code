#!/usr/bin/env node --experimental-strip-types
/**
 * What a synthesised Primal family IS: a box of numbers, and nothing else.
 *
 * A `FamilySpec` CONTAINS NO HEX. Every colour a synthesised theme ships is
 * placed by `synthesise.ts` against a measured floor, so there is nowhere for a
 * hand-picked value to hide - which is the whole reason the corpus pipeline
 * exists and the whole reason this one does too.
 *
 * Every range below is a measurement of the six shipping vibes, cited in the
 * field's own comment. They are not taste; they are the box the house already
 * occupies, and a spec outside it is not a Primal theme however well it scores.
 *
 * `parseSpec` is the boundary. It fails fast, by field name, because the file it
 * reads is `primal/design/families.json` - hand-reviewable, machine-written, and
 * the one place a typo could otherwise ship sixty themes wearing a wrong number.
 *
 *   node --experimental-strip-types primal/theme/synth/spec.ts --self-test
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Depth } from "../importPalette.ts";
import type { SyntaxEmphasis, ThemeMode } from "../tokenMap.ts";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Success or a named failure. The synthesiser returns one of these rather than
 * throwing, because feasibility is a greedy 16-slot packing over 120 CIEDE2000
 * pairs in a non-convex gamut and there is no closed form for "will this work" -
 * the only honest predicate is "call it and see", and the build has to survive
 * the answer being no.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Wraps a value as a successful `Result`. */
export function ok<T, E>(value: T): Result<T, E> {
	return { ok: true, value };
}

/** Wraps an error as a failed `Result`. */
export function err<T, E>(error: E): Result<T, E> {
	return { ok: false, error };
}

// ---------------------------------------------------------------------------
// The house, measured
// ---------------------------------------------------------------------------

/** The six chromatic ANSI names, in the order every HOUSE_ANSI_* array below uses. */
export const ANSI_CHROMATIC_NAMES: readonly ["red", "yellow", "green", "cyan", "blue", "magenta"] =
	["red", "yellow", "green", "cyan", "blue", "magenta"];

/**
 * Median OKLCh hue of each chromatic ANSI name over all twelve slots of all six
 * shipping vibes. The terminal is NOT an identity axis: SGR 31 has to stay red.
 */
export const HOUSE_ANSI_HUE: readonly [number, number, number, number, number, number] =
	[31.0, 85.5, 153.1, 183.4, 249.2, 323.3];

/**
 * Half-span of the hue range the six vibes already ship for each name. A
 * per-name offset inside this band varies the ramp without leaving the range the
 * approved themes define, which a GLOBAL wheel rotation cannot do: yellow's band
 * is 6.2 degrees and would cap the whole rotation there, while blue alone has
 * 23.8 degrees of demonstrated latitude.
 */
export const HOUSE_ANSI_BAND: readonly [number, number, number, number, number, number] =
	[12.9, 6.2, 11.9, 20.5, 23.8, 15.8];

/** Median OKLCh chroma of each chromatic ANSI name over the six shipping vibes. */
export const HOUSE_ANSI_CHROMA: readonly [number, number, number, number, number, number] =
	[0.112, 0.085, 0.080, 0.059, 0.073, 0.069];

/**
 * Which syntax roles the house aliases, per register.
 *
 * Measured, not chosen: every one of the six shipping vibes ships a
 * byte-identical syntax pair, and there are exactly two patterns.
 *
 *   ink / basalt / ridge : keyword = type = operator = accent = editorFg
 *   tide / dusk / fern   : function = type ;  operator = editorFg ;  accent = keyword
 *
 * This is the real identity axis - which roles collapse, and how loud the
 * survivors are - and it is why `register` is a first-class spec field. It is
 * INDEPENDENT of `syntaxEmphasis`: Ridge ships the ink-led alias pattern with
 * `syntaxEmphasis: "plain"`, so both axes must be sampled separately.
 */
export type Register = "inkLed" | "keywordLed";

/** The two registers, for a search that has to enumerate them. */
export const REGISTERS: readonly Register[] = ["inkLed", "keywordLed"];

/** The two emphases, for a search that has to enumerate them. */
export const EMPHASES: readonly SyntaxEmphasis[] = ["plain", "weight"];

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

/**
 * The margins a family actually achieved, written back by `--propose`.
 *
 * GENERATED. Never hand-edited, and re-measured on every build: if a shared
 * constant moves and a family's margins change, `buildThemes` says so by name
 * rather than shipping a family whose recorded slack is fiction.
 *
 * It exists because a naive floor-hugging placer makes every margin identical -
 * every ramp at 10.0x dE00, every ANSI slot at 3.0x:1 - which is both useless as
 * a review sort key and a clone factory in its own right. `ansiAir` is the knob
 * that stops it, and these are the numbers that prove the knob is turned.
 */
export interface SlackReport {
	/** Worst of the 120 ANSI pairs, trichromat, dE00. Floor 10. */
	readonly ansiWorstPair: number;
	/** Worst ANSI slot contrast against the panel plane. Floor 3.0. */
	readonly ansiMinContrast: number;
	/** How many of the 120 ANSI pairs a dichromat cannot resolve. Best-effort, never a guarantee. */
	readonly ansiDichromatCollisions: number;
	/** Loudest syntax contrast over quietest. The house's own widest is Ink at 3.01. */
	readonly syntaxContrastRatio: number;
	/** Closest two non-aliased syntax roles, dE00 under the worst observer. */
	readonly syntaxMinSeparation: number;
	/** Validator warnings at the medium depth. The six hand-authored vibes carry 43-60. */
	readonly warnings: number;
}

/**
 * Who signed off on this family, and on what.
 *
 * `sheet` is the sha256 of the family's contact-sheet card payload - the
 * identity colours, the syntax palette and the ANSI strip that the card pictures
 * - so a spec that moves invalidates its own approval and `buildThemes --check`
 * says which family needs re-reviewing. The hash covers the ARTEFACT rather than
 * the card's HTML, so a CSS change does not invalidate sixty human decisions.
 */
export interface Approval {
	/** The reviewer. `"unreviewed"` until a human has actually looked at the card. */
	readonly by: string;
	/** ISO date of the review, or `null` when there has not been one. */
	readonly on: string | null;
	/** sha256 of the card payload the reviewer saw. */
	readonly sheet: string;
}

/** One synthesised family: the numbers, the ledger, and nothing else. */
export interface FamilySpec {
	/* identity */
	/** `"harbour"` - the file stem, the settings value and the nls key stem. */
	readonly id: string;
	/** `"Harbour"` - the user sees "Primal Harbour". */
	readonly name: string;
	readonly mode: ThemeMode;
	/** The depths this family can express, recorded by `--propose` after building all three. */
	readonly depths: readonly Depth[];

	/* THE GROUND - OKLCh */
	/** dark [0.10, 0.30] - light [0.90, 1.00]. House: 0.183-0.208 dark, 0.966-0.982 light. */
	readonly planeL: number;
	/** dark [0, 0.030] - light [0, 0.022]. House maximum 0.0254 (tide). */
	readonly planeC: number;
	/** [0, 360). */
	readonly planeH: number;

	/* THE INK - placed before anything chromatic */
	/** dark [9.5, 15.5] - light [9.5, 16.5]. House 9.75 (ridge) to 16.48 (ink). */
	readonly inkContrast: number;
	/** [0.8, 3.2] x planeC, clamped to [0.004, 0.040]. House ink chroma 0.0050-0.0346. */
	readonly inkChromaScale: number;
	/** [0.49, 0.62] x inkContrast, for chromeFg on chromeBg. House 0.49-0.61. */
	readonly chromeFraction: number;

	/* THE SYNTAX - one wheel, locked to the ground */
	readonly register: Register;
	/** [-40, 40] degrees off planeH. House 0, 0, 7, 26, 35, 38 - never a free wheel. */
	readonly syntaxHueOffset: number;
	/** The family's loudest syntax chroma. Bounds depend on register and mode. */
	readonly syntaxChroma: number;
	/** Contrast as a fraction of inkContrast. inkLed [0.62, 0.88] - keywordLed [0.82, 0.99]. */
	readonly fFunction: number;
	/** inkLed [0.48, 0.78] - keywordLed [0.68, 0.88]. */
	readonly fString: number;
	/** keywordLed only, [0.58, 0.74]. Absent for inkLed, where keyword IS the ink. */
	readonly fKeyword?: number;
	/** inkLed [0.30, 0.56] - keywordLed [0.60, 0.72]. */
	readonly fConstant: number;
	/** [0.21, 0.35]. Floors at 3.2:1, deliberately below the 4.5 warn line; see synthesise.ts. */
	readonly fComment: number;
	/** One role's hue kick, in degrees: 0, or between 20 and 32 either way. House -26, +30, +29. */
	readonly constantKick: number;
	/** Independent of `register`. Ridge proves the two axes are separate. */
	readonly syntaxEmphasis: SyntaxEmphasis;

	/* THE TERMINAL - pinned by SGR convention, per-name latitude only */
	/** red, yellow, green, cyan, blue, magenta - each inside its own HOUSE_ANSI_BAND. */
	readonly ansiHueOffsets: readonly [number, number, number, number, number, number];
	/** [0.85, 1.40] x HOUSE_ANSI_CHROMA. Also a knob on semantic-ladder feasibility; see stage 7. */
	readonly ansiChromaScale: number;
	/** 0, 0.01 or 0.02 - OKLab |dL| between consecutive rungs. The dichromat knob. */
	readonly ansiRungSpread: number;
	/** [0, 1.2] dE00 of overshoot past the 10 dE00 floor. The anti-margin-hugging knob. */
	readonly ansiAir: number;

	/* SELECTION */
	/** [0.06, 0.17] OKLab L off the plane, before the legibility pull-back. */
	readonly selectionStep: number;

	/* PROVENANCE */
	readonly approval: Approval;
	/** GENERATED, written back by --propose / --repair. Re-measured and checked on every build. */
	readonly slack: SlackReport;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** An inclusive numeric range, with the measurement that fixed it. */
export interface Bound {
	readonly min: number;
	readonly max: number;
}

/** `planeL`, by mode. */
export const PLANE_L: Readonly<Record<ThemeMode, Bound>> = {
	dark: { min: 0.10, max: 0.30 },
	light: { min: 0.90, max: 1.00 }
};

/** `planeC`, by mode. */
export const PLANE_C: Readonly<Record<ThemeMode, Bound>> = {
	dark: { min: 0, max: 0.030 },
	light: { min: 0, max: 0.022 }
};

/** `inkContrast`, by mode. */
export const INK_CONTRAST: Readonly<Record<ThemeMode, Bound>> = {
	dark: { min: 9.5, max: 15.5 },
	light: { min: 9.5, max: 16.5 }
};

/** `syntaxChroma`, by register then mode. inkLed does not vary with mode; the house's three ink-led vibes span 0.016-0.052 across both. */
export const SYNTAX_CHROMA: Readonly<Record<Register, Readonly<Record<ThemeMode, Bound>>>> = {
	inkLed: { dark: { min: 0.008, max: 0.055 }, light: { min: 0.008, max: 0.055 } },
	keywordLed: { dark: { min: 0.045, max: 0.100 }, light: { min: 0.030, max: 0.065 } }
};

/** The contrast fractions, by register. */
export const F_FUNCTION: Readonly<Record<Register, Bound>> = {
	inkLed: { min: 0.62, max: 0.88 },
	keywordLed: { min: 0.82, max: 0.99 }
};

/** See `F_FUNCTION`. */
export const F_STRING: Readonly<Record<Register, Bound>> = {
	inkLed: { min: 0.48, max: 0.78 },
	keywordLed: { min: 0.68, max: 0.88 }
};

/** See `F_FUNCTION`. */
export const F_CONSTANT: Readonly<Record<Register, Bound>> = {
	inkLed: { min: 0.30, max: 0.56 },
	keywordLed: { min: 0.60, max: 0.72 }
};

/** `fKeyword`, which only a keyword-led family states. */
export const F_KEYWORD: Bound = { min: 0.58, max: 0.74 };

/** `fComment`. Both registers, both modes. */
export const F_COMMENT: Bound = { min: 0.21, max: 0.35 };

/** `inkChromaScale`. */
export const INK_CHROMA_SCALE: Bound = { min: 0.8, max: 3.2 };

/** Absolute clamp on the realised ink chroma, whatever the scale asks for. House 0.0050-0.0346. */
export const INK_CHROMA_CLAMP: Bound = { min: 0.004, max: 0.040 };

/** `chromeFraction`. */
export const CHROME_FRACTION: Bound = { min: 0.49, max: 0.62 };

/** `syntaxHueOffset`, in degrees. */
export const SYNTAX_HUE_OFFSET: Bound = { min: -40, max: 40 };

/** The magnitude of a non-zero `constantKick`, in degrees. */
export const CONSTANT_KICK: Bound = { min: 20, max: 32 };

/** `ansiChromaScale`. */
export const ANSI_CHROMA_SCALE: Bound = { min: 0.85, max: 1.40 };

/** `ansiAir`, in dE00 past the 10 dE00 floor. */
export const ANSI_AIR: Bound = { min: 0, max: 1.2 };

/** `selectionStep`, in OKLab L. */
export const SELECTION_STEP: Bound = { min: 0.06, max: 0.17 };

/** The three values `ansiRungSpread` may take. */
export const ANSI_RUNG_SPREADS: readonly number[] = [0, 0.01, 0.02];

/** The three depths, in the order the catalogue emits them. */
export const DEPTH_ORDER: readonly Depth[] = ["soft", "medium", "hard"];

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

/** A spec that states something outside the house box, named by the field that did it. */
export class SpecError extends Error {
	constructor(where: string, field: string, message: string) {
		super(`spec: ${where}: ${field}: ${message}`);
	}
}

function requireObject(raw: unknown, where: string): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new SpecError(where, "(root)", "a family spec must be a JSON object");
	}
	return raw as Record<string, unknown>;
}

function requireNumber(raw: Record<string, unknown>, field: string, where: string): number {
	const value = raw[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new SpecError(where, field, `must be a finite number, got ${JSON.stringify(value)}`);
	}
	return value;
}

function requireInRange(raw: Record<string, unknown>, field: string, bound: Bound, where: string): number {
	const value = requireNumber(raw, field, where);
	if (value < bound.min || value > bound.max) {
		throw new SpecError(where, field, `must be within [${bound.min}, ${bound.max}], got ${value}`);
	}
	return value;
}

function requireString(raw: Record<string, unknown>, field: string, where: string): string {
	const value = raw[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new SpecError(where, field, `must be a non-empty string, got ${JSON.stringify(value)}`);
	}
	return value;
}

function requireEnum<T extends string>(raw: Record<string, unknown>, field: string, allowed: readonly T[], where: string): T {
	const value = raw[field];
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new SpecError(where, field, `must be one of ${allowed.map(a => JSON.stringify(a)).join(", ")}, got ${JSON.stringify(value)}`);
	}
	return value as T;
}

function parseApproval(raw: unknown, where: string): Approval {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new SpecError(where, "approval", "must be an object with `by`, `on` and `sheet`");
	}
	const record = raw as Record<string, unknown>;
	const on = record["on"];
	if (on !== null && typeof on !== "string") {
		throw new SpecError(where, "approval.on", `must be an ISO date string or null, got ${JSON.stringify(on)}`);
	}
	const sheet = requireString(record, "sheet", `${where}.approval`);
	if (!/^[0-9a-f]{64}$/.test(sheet)) {
		throw new SpecError(where, "approval.sheet", "must be a 64-character lowercase sha256 hex digest");
	}
	return { by: requireString(record, "by", `${where}.approval`), on: on ?? null, sheet };
}

function parseSlack(raw: unknown, where: string): SlackReport {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new SpecError(where, "slack", "must be an object; it is generated by --propose and never hand-written");
	}
	const record = raw as Record<string, unknown>;
	return {
		ansiWorstPair: requireNumber(record, "ansiWorstPair", `${where}.slack`),
		ansiMinContrast: requireNumber(record, "ansiMinContrast", `${where}.slack`),
		ansiDichromatCollisions: requireNumber(record, "ansiDichromatCollisions", `${where}.slack`),
		syntaxContrastRatio: requireNumber(record, "syntaxContrastRatio", `${where}.slack`),
		syntaxMinSeparation: requireNumber(record, "syntaxMinSeparation", `${where}.slack`),
		warnings: requireNumber(record, "warnings", `${where}.slack`)
	};
}

function parseHueOffsets(raw: unknown, where: string): readonly [number, number, number, number, number, number] {
	if (!Array.isArray(raw) || raw.length !== 6) {
		throw new SpecError(where, "ansiHueOffsets", "must be six numbers: red, yellow, green, cyan, blue, magenta");
	}
	const out: number[] = [];
	for (let i = 0; i < 6; i++) {
		const value = raw[i];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new SpecError(where, `ansiHueOffsets[${i}] (${ANSI_CHROMATIC_NAMES[i]})`, `must be a finite number, got ${JSON.stringify(value)}`);
		}
		if (Math.abs(value) > HOUSE_ANSI_BAND[i]) {
			throw new SpecError(
				where,
				`ansiHueOffsets[${i}] (${ANSI_CHROMATIC_NAMES[i]})`,
				`must be within +/-${HOUSE_ANSI_BAND[i]} degrees - the half-span the six shipping vibes already occupy for this name - got ${value}`
			);
		}
		out.push(value);
	}
	return out as unknown as readonly [number, number, number, number, number, number];
}

function parseDepths(raw: unknown, where: string): readonly Depth[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new SpecError(where, "depths", "must be a non-empty array of \"soft\", \"medium\" or \"hard\"");
	}
	const seen = new Set<string>();
	for (const value of raw) {
		if (typeof value !== "string" || !DEPTH_ORDER.includes(value as Depth)) {
			throw new SpecError(where, "depths", `must contain only "soft", "medium" or "hard", got ${JSON.stringify(value)}`);
		}
		if (seen.has(value)) {
			throw new SpecError(where, "depths", `lists ${JSON.stringify(value)} twice`);
		}
		seen.add(value);
	}
	return DEPTH_ORDER.filter(depth => seen.has(depth));
}

/**
 * Reads one family spec, or throws naming the field that is wrong.
 *
 * Every bound is checked, including the ones that depend on `mode` and
 * `register`, and `fKeyword` is required exactly when the register is
 * keyword-led and rejected otherwise - an ink-led family's keyword IS the ink,
 * so a fraction for it would be a number that does nothing.
 */
export function parseSpec(raw: unknown, where: string): FamilySpec {
	const record = requireObject(raw, where);
	const id = requireString(record, "id", where);
	if (!/^[a-z][a-z0-9]*$/.test(id)) {
		throw new SpecError(where, "id", `must be lowercase letters and digits, starting with a letter, got ${JSON.stringify(id)}`);
	}
	const name = requireString(record, "name", where);
	if (name.toLowerCase() !== id) {
		throw new SpecError(where, "name", `must be the id capitalised, so "${id}" wants "${id[0].toUpperCase()}${id.slice(1)}", got ${JSON.stringify(name)}`);
	}
	const mode = requireEnum<ThemeMode>(record, "mode", ["light", "dark"], where);
	const register = requireEnum<Register>(record, "register", REGISTERS, where);

	const constantKick = requireNumber(record, "constantKick", where);
	if (constantKick !== 0 && (Math.abs(constantKick) < CONSTANT_KICK.min || Math.abs(constantKick) > CONSTANT_KICK.max)) {
		throw new SpecError(
			where,
			"constantKick",
			`must be 0 or between +/-${CONSTANT_KICK.min} and +/-${CONSTANT_KICK.max} degrees - the house kicks one role by -26, +30 and +29 - got ${constantKick}`
		);
	}

	const rungSpread = requireNumber(record, "ansiRungSpread", where);
	if (!ANSI_RUNG_SPREADS.includes(rungSpread)) {
		throw new SpecError(where, "ansiRungSpread", `must be one of ${ANSI_RUNG_SPREADS.join(", ")}, got ${rungSpread}`);
	}

	const planeH = requireNumber(record, "planeH", where);
	if (planeH < 0 || planeH >= 360) {
		throw new SpecError(where, "planeH", `must be within [0, 360), got ${planeH}`);
	}

	const hasKeywordFraction = record["fKeyword"] !== undefined;
	if (register === "keywordLed" && !hasKeywordFraction) {
		throw new SpecError(where, "fKeyword", "is required for a keyword-led family");
	}
	if (register === "inkLed" && hasKeywordFraction) {
		throw new SpecError(where, "fKeyword", "must be absent for an ink-led family, whose keyword IS the ink");
	}

	const spec: FamilySpec = {
		id,
		name,
		mode,
		depths: parseDepths(record["depths"], where),
		planeL: requireInRange(record, "planeL", PLANE_L[mode], where),
		planeC: requireInRange(record, "planeC", PLANE_C[mode], where),
		planeH,
		inkContrast: requireInRange(record, "inkContrast", INK_CONTRAST[mode], where),
		inkChromaScale: requireInRange(record, "inkChromaScale", INK_CHROMA_SCALE, where),
		chromeFraction: requireInRange(record, "chromeFraction", CHROME_FRACTION, where),
		register,
		syntaxHueOffset: requireInRange(record, "syntaxHueOffset", SYNTAX_HUE_OFFSET, where),
		syntaxChroma: requireInRange(record, "syntaxChroma", SYNTAX_CHROMA[register][mode], where),
		fFunction: requireInRange(record, "fFunction", F_FUNCTION[register], where),
		fString: requireInRange(record, "fString", F_STRING[register], where),
		...(register === "keywordLed" ? { fKeyword: requireInRange(record, "fKeyword", F_KEYWORD, where) } : {}),
		fConstant: requireInRange(record, "fConstant", F_CONSTANT[register], where),
		fComment: requireInRange(record, "fComment", F_COMMENT, where),
		constantKick,
		syntaxEmphasis: requireEnum<SyntaxEmphasis>(record, "syntaxEmphasis", EMPHASES, where),
		ansiHueOffsets: parseHueOffsets(record["ansiHueOffsets"], where),
		ansiChromaScale: requireInRange(record, "ansiChromaScale", ANSI_CHROMA_SCALE, where),
		ansiRungSpread: rungSpread,
		ansiAir: requireInRange(record, "ansiAir", ANSI_AIR, where),
		selectionStep: requireInRange(record, "selectionStep", SELECTION_STEP, where),
		approval: parseApproval(record["approval"], where),
		slack: parseSlack(record["slack"], where)
	};
	return spec;
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

/** A minimal keyword-led dark spec, at the centre of every band. Used by the tests here and in the sibling suites. */
export function exampleSpec(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		id: "example",
		name: "Example",
		mode: "dark",
		depths: ["soft", "medium", "hard"],
		planeL: 0.20,
		planeC: 0.015,
		planeH: 250,
		inkContrast: 12,
		inkChromaScale: 1.5,
		chromeFraction: 0.55,
		register: "keywordLed",
		syntaxHueOffset: 20,
		syntaxChroma: 0.07,
		fFunction: 0.90,
		fString: 0.78,
		fKeyword: 0.66,
		fConstant: 0.66,
		fComment: 0.28,
		constantKick: 26,
		syntaxEmphasis: "weight",
		ansiHueOffsets: [0, 0, 0, 0, 0, 0],
		ansiChromaScale: 1.0,
		ansiRungSpread: 0,
		ansiAir: 0.3,
		selectionStep: 0.11,
		approval: { by: "unreviewed", on: null, sheet: "0".repeat(64) },
		slack: {
			ansiWorstPair: 10.1, ansiMinContrast: 3.0, ansiDichromatCollisions: 25,
			syntaxContrastRatio: 2.5, syntaxMinSeparation: 4, warnings: 45
		},
		...overrides
	};
}

interface Failure {
	readonly what: string;
	readonly detail: string;
}

function rejects(failures: Failure[], what: string, overrides: Record<string, unknown>, wantField: string): void {
	try {
		parseSpec(exampleSpec(overrides), "test");
		failures.push({ what, detail: `parseSpec accepted it; expected a failure naming "${wantField}"` });
	} catch (error) {
		const message = (error as Error).message;
		if (!message.includes(wantField)) {
			failures.push({ what, detail: `rejected, but the message does not name "${wantField}": ${message}` });
		}
	}
}

function accepts(failures: Failure[], what: string, overrides: Record<string, unknown>): void {
	try {
		parseSpec(exampleSpec(overrides), "test");
	} catch (error) {
		failures.push({ what, detail: `parseSpec rejected a legal spec: ${(error as Error).message}` });
	}
}

/** The `spec.ts` suite. Returns one line per failing assertion; empty is a pass. */
export function runSpecTests(): readonly string[] {
	const failures: Failure[] = [];

	accepts(failures, "the example spec parses", {});

	// Every numeric field rejects out of range, by name, at both ends.
	rejects(failures, "planeL below the dark band", { planeL: 0.09 }, "planeL");
	rejects(failures, "planeL above the dark band", { planeL: 0.31 }, "planeL");
	rejects(failures, "a dark planeL on a light family", { mode: "light", planeL: 0.20 }, "planeL");
	rejects(failures, "planeC above the dark band", { planeC: 0.031 }, "planeC");
	rejects(failures, "planeC above the light band", { mode: "light", planeL: 0.95, planeC: 0.023 }, "planeC");
	rejects(failures, "planeH at 360", { planeH: 360 }, "planeH");
	rejects(failures, "planeH negative", { planeH: -1 }, "planeH");
	rejects(failures, "inkContrast below the floor", { inkContrast: 9.49 }, "inkContrast");
	rejects(failures, "inkContrast above the dark ceiling", { inkContrast: 15.51 }, "inkContrast");
	rejects(failures, "inkChromaScale below", { inkChromaScale: 0.79 }, "inkChromaScale");
	rejects(failures, "chromeFraction above", { chromeFraction: 0.63 }, "chromeFraction");
	rejects(failures, "syntaxHueOffset beyond the house band", { syntaxHueOffset: 41 }, "syntaxHueOffset");
	rejects(failures, "syntaxChroma above the keyword-led dark band", { syntaxChroma: 0.101 }, "syntaxChroma");
	rejects(failures, "fFunction below the keyword-led band", { fFunction: 0.81 }, "fFunction");
	rejects(failures, "fString above", { fString: 0.89 }, "fString");
	rejects(failures, "fKeyword below", { fKeyword: 0.57 }, "fKeyword");
	rejects(failures, "fConstant below the keyword-led band", { fConstant: 0.59 }, "fConstant");
	rejects(failures, "fComment above", { fComment: 0.36 }, "fComment");
	rejects(failures, "ansiChromaScale above", { ansiChromaScale: 1.41 }, "ansiChromaScale");
	rejects(failures, "ansiAir above", { ansiAir: 1.21 }, "ansiAir");
	rejects(failures, "selectionStep below", { selectionStep: 0.059 }, "selectionStep");
	rejects(failures, "a constantKick inside the dead band", { constantKick: 10 }, "constantKick");
	rejects(failures, "an ansiRungSpread off the ladder", { ansiRungSpread: 0.015 }, "ansiRungSpread");
	rejects(failures, "an unknown register", { register: "rainbow" }, "register");
	rejects(failures, "an unknown emphasis", { syntaxEmphasis: "italic" }, "syntaxEmphasis");
	rejects(failures, "an unknown mode", { mode: "sepia" }, "mode");
	rejects(failures, "a name that is not the id", { name: "Harbour" }, "name");
	rejects(failures, "an id with punctuation", { id: "sea-fog", name: "Sea-fog" }, "id");
	rejects(failures, "an empty depths list", { depths: [] }, "depths");
	rejects(failures, "an unknown depth", { depths: ["deep"] }, "depths");
	rejects(failures, "a duplicated depth", { depths: ["soft", "soft"] }, "depths");
	rejects(failures, "an approval with no sheet hash", { approval: { by: "x", on: null, sheet: "short" } }, "sheet");

	// The per-name ANSI band, which is the whole reason the terminal is not an identity axis.
	rejects(failures, "yellow rotated past its own band", { ansiHueOffsets: [0, 6.3, 0, 0, 0, 0] }, "yellow");
	accepts(failures, "yellow at the edge of its band", { ansiHueOffsets: [0, 6.2, 0, 0, 0, 0] });
	accepts(failures, "blue using its much wider band", { ansiHueOffsets: [0, 0, 0, 0, 23.8, 0] });
	rejects(failures, "blue one degree past it", { ansiHueOffsets: [0, 0, 0, 0, 23.9, 0] }, "blue");

	// fKeyword is required exactly when it means something.
	rejects(failures, "an ink-led family stating fKeyword", {
		register: "inkLed", syntaxChroma: 0.03, fFunction: 0.75, fString: 0.6, fConstant: 0.45, fKeyword: 0.66
	}, "fKeyword");
	{
		const inkLed = exampleSpec({ register: "inkLed", syntaxChroma: 0.03, fFunction: 0.75, fString: 0.6, fConstant: 0.45 });
		delete inkLed["fKeyword"];
		try {
			const parsed = parseSpec(inkLed, "test");
			if (parsed.fKeyword !== undefined) {
				failures.push({ what: "an ink-led family has no fKeyword", detail: `parsed one anyway: ${parsed.fKeyword}` });
			}
		} catch (error) {
			failures.push({ what: "an ink-led family parses without fKeyword", detail: (error as Error).message });
		}
	}
	{
		const missing = exampleSpec({});
		delete missing["fKeyword"];
		rejectsRaw(failures, "a keyword-led family with no fKeyword", missing, "fKeyword");
	}

	// Every boundary value is legal - a bound that rejects its own endpoint is a bound nobody can hit.
	accepts(failures, "planeL at the dark floor", { planeL: 0.10 });
	accepts(failures, "planeL at the dark ceiling", { planeL: 0.30 });
	accepts(failures, "planeC at zero", { planeC: 0 });
	accepts(failures, "planeH at zero", { planeH: 0 });
	accepts(failures, "planeH just under 360", { planeH: 359.999 });
	accepts(failures, "inkContrast at the floor", { inkContrast: 9.5 });
	accepts(failures, "fComment at both ends", { fComment: 0.21 });
	accepts(failures, "fComment at the top", { fComment: 0.35 });
	accepts(failures, "constantKick at zero", { constantKick: 0 });
	accepts(failures, "constantKick at -20", { constantKick: -20 });
	accepts(failures, "constantKick at +32", { constantKick: 32 });
	accepts(failures, "ansiAir at zero", { ansiAir: 0 });
	accepts(failures, "ansiRungSpread at 0.02", { ansiRungSpread: 0.02 });

	// depths come back in emission order however they were written.
	try {
		const parsed = parseSpec(exampleSpec({ depths: ["hard", "soft"] }), "test");
		if (parsed.depths.join(",") !== "soft,hard") {
			failures.push({ what: "depths are normalised to emission order", detail: `got ${parsed.depths.join(",")}` });
		}
	} catch (error) {
		failures.push({ what: "depths are normalised to emission order", detail: (error as Error).message });
	}

	return failures.map(f => `spec: ${f.what}: ${f.detail}`);
}

function rejectsRaw(failures: Failure[], what: string, raw: Record<string, unknown>, wantField: string): void {
	try {
		parseSpec(raw, "test");
		failures.push({ what, detail: `parseSpec accepted it; expected a failure naming "${wantField}"` });
	} catch (error) {
		const message = (error as Error).message;
		if (!message.includes(wantField)) {
			failures.push({ what, detail: `rejected, but the message does not name "${wantField}": ${message}` });
		}
	}
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	const failures = runSpecTests();
	for (const line of failures) {
		console.error(`  ${line}`);
	}
	if (failures.length > 0) {
		console.error(`\nspec: ${failures.length} failing assertion(s)`);
		process.exit(1);
	}
	console.log("spec: all assertions pass (bounds by mode and register, boundary values, ANSI hue bands, fKeyword coupling)");
	process.exit(0);
}
