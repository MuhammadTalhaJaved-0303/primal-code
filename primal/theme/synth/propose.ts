#!/usr/bin/env node --experimental-strip-types
/**
 * The OFFLINE search. Nothing in the build ever calls this.
 *
 * THE SEARCH IS OFFLINE; THE BUILD IS A LOOKUP. `primal/design/families.json` is
 * a checked-in list of specs, read by `buildThemes` the way `vibe-tokens.json`
 * is read, and the themes it produces are checked in and byte-compared. This
 * file is how that list is PRODUCED - run by a human, reviewed as a diff, and
 * never on the build path. That separation is the whole reason a random search
 * is allowed to exist at all: the RNG lives here, and `synthesise` has none.
 *
 * WHAT IT ACTUALLY DOES
 *
 *   1. Draws specs uniformly from the house box in `spec.ts`, deterministically
 *      from a stated seed.
 *   2. Synthesises each one at the medium depth and keeps the ones that come
 *      back clean - every gate, zero validator errors.
 *   3. Packs the survivors farthest-point against the eleven families that
 *      already ship, under `D_owner`.
 *   4. Measures which depths each accepted family can express, names them from
 *      `names.json`, and writes `families.json`.
 *
 * WHAT IT WILL NOT DO
 *
 * Pad the catalogue to hit a number. The packer stops when no candidate is
 * admissible and the count it returns is the count that gets shipped. If that is
 * thirty, thirty ships and the report says thirty.
 *
 *   node --experimental-strip-types primal/theme/synth/propose.ts --self-test
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Seed } from "../generateTheme.ts";
import { DEPTH_STEPS, type Depth } from "../importPalette.ts";
import type { SyntaxEmphasis, ThemeMode } from "../tokenMap.ts";
import { identityOf, packFarthestPoint, type FamilyIdentity } from "./distinct.ts";
import { REPAIR_LADDER, synthesise, type Infeasible, type Stage } from "./synthesise.ts";
import { validate } from "../validateTheme.ts";
import {
	ANSI_AIR,
	ANSI_CHROMA_SCALE,
	ANSI_RUNG_SPREADS,
	CHROME_FRACTION,
	CONSTANT_KICK,
	DEPTH_ORDER,
	EMPHASES,
	F_COMMENT,
	F_CONSTANT,
	F_FUNCTION,
	F_KEYWORD,
	F_STRING,
	HOUSE_ANSI_BAND,
	INK_CHROMA_SCALE,
	INK_CONTRAST,
	PLANE_C,
	PLANE_L,
	REGISTERS,
	SELECTION_STEP,
	SYNTAX_CHROMA,
	SYNTAX_HUE_OFFSET,
	parseSpec,
	type Approval,
	type Bound,
	type FamilySpec,
	type Register,
	type SlackReport
} from "./spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
export const FAMILIES_PATH = join(REPO, "primal", "design", "families.json");
export const NAMES_PATH = join(REPO, "primal", "design", "names.json");

/** The version `families.json` states, read the way `loadVibes` reads `vibe-tokens.json`'s. */
export const FAMILIES_VERSION = 1;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/**
 * A seeded PRNG, so a search is reproducible from its seed alone.
 *
 * mulberry32: 32-bit state, no dependencies, and good enough for sampling a box.
 * Nothing cryptographic depends on it and nothing in the BUILD depends on it at
 * all - a spec, once drawn, is a set of numbers in a checked-in file.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return (): number => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function uniform(rng: () => number, bound: Bound, decimals: number): number {
	const value = bound.min + rng() * (bound.max - bound.min);
	const factor = 10 ** decimals;
	return Math.min(bound.max, Math.max(bound.min, Math.round(value * factor) / factor));
}

function pick<T>(rng: () => number, options: readonly T[]): T {
	return options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * One draw from the house box.
 *
 * Every field is uniform inside the band `spec.ts` states for it, rounded to a
 * precision a human can read in a diff - and rounded BEFORE synthesis, so the
 * spec written to `families.json` is exactly the spec that was measured.
 */
export function drawSpec(rng: () => number, mode: ThemeMode): FamilySpec {
	const register: Register = pick(rng, REGISTERS);
	const emphasis: SyntaxEmphasis = pick(rng, EMPHASES);
	const kick = rng() < 0.25 ? 0 : (rng() < 0.5 ? -1 : 1) * uniform(rng, CONSTANT_KICK, 1);
	const hueOffsets = HOUSE_ANSI_BAND.map(band => uniform(rng, { min: -band, max: band }, 1));
	return {
		id: "draft",
		name: "Draft",
		mode,
		depths: ["medium"],
		planeL: uniform(rng, PLANE_L[mode], 4),
		planeC: uniform(rng, PLANE_C[mode], 4),
		planeH: Math.round(rng() * 3600) / 10 % 360,
		inkContrast: uniform(rng, INK_CONTRAST[mode], 2),
		inkChromaScale: uniform(rng, INK_CHROMA_SCALE, 2),
		chromeFraction: uniform(rng, CHROME_FRACTION, 3),
		register,
		syntaxHueOffset: uniform(rng, SYNTAX_HUE_OFFSET, 1),
		syntaxChroma: uniform(rng, SYNTAX_CHROMA[register][mode], 4),
		fFunction: uniform(rng, F_FUNCTION[register], 3),
		fString: uniform(rng, F_STRING[register], 3),
		...(register === "keywordLed" ? { fKeyword: uniform(rng, F_KEYWORD, 3) } : {}),
		fConstant: uniform(rng, F_CONSTANT[register], 3),
		fComment: uniform(rng, F_COMMENT, 3),
		constantKick: kick,
		syntaxEmphasis: emphasis,
		ansiHueOffsets: hueOffsets as unknown as readonly [number, number, number, number, number, number],
		ansiChromaScale: uniform(rng, ANSI_CHROMA_SCALE, 3),
		ansiRungSpread: pick(rng, ANSI_RUNG_SPREADS),
		ansiAir: uniform(rng, ANSI_AIR, 2),
		selectionStep: uniform(rng, SELECTION_STEP, 3),
		approval: { by: "unreviewed", on: null, sheet: "0".repeat(64) },
		slack: { ansiWorstPair: 0, ansiMinContrast: 0, ansiDichromatCollisions: 0, syntaxContrastRatio: 0, syntaxMinSeparation: 0, warnings: 0 }
	};
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/** One candidate that came back clean. */
export interface Candidate {
	readonly spec: FamilySpec;
	readonly seed: Seed;
	readonly identity: FamilyIdentity;
	readonly slack: SlackReport;
}

/** What a search run found, including everything it threw away. */
export interface SearchReport {
	readonly draws: number;
	readonly clean: readonly Candidate[];
	/** How many draws died at each stage. The design's own failure profile, re-measured. */
	readonly failures: Readonly<Record<Stage, number>>;
}

function emptyFailures(): Record<Stage, number> {
	return { ground: 0, syntax: 0, ramp: 0, taste: 0, ladder: 0, validator: 0, postcondition: 0 };
}

/**
 * Draws `draws` specs and returns the ones that synthesise clean at the medium
 * depth, plus the failure profile.
 *
 * Medium only, at this stage: a family that cannot express medium is not a
 * family, and measuring all three depths for every draw would triple the cost of
 * the 45% that are going to be thrown away.
 */
export function search(draws: number, seed: number, onProgress?: (done: number, clean: number) => void): SearchReport {
	const rng = mulberry32(seed);
	const clean: Candidate[] = [];
	const failures = emptyFailures();

	for (let i = 0; i < draws; i++) {
		const mode: ThemeMode = rng() < 0.5 ? "dark" : "light";
		const spec = drawSpec(rng, mode);
		const result = synthesise(spec, "medium", "Primal Draft");
		if (!result.ok) {
			failures[result.error.stage]++;
			continue;
		}
		clean.push({
			spec,
			seed: result.value.seed,
			identity: identityOf(`draw${i}`, result.value.seed, spec.mode, spec.syntaxEmphasis),
			slack: result.value.report.slack
		});
		if (onProgress !== undefined && clean.length % 50 === 0) {
			onProgress(i + 1, clean.length);
		}
	}
	return { draws, clean, failures };
}

/** Which depths a family can actually express, measured by building all three. */
export function expressibleDepths(spec: FamilySpec): readonly Depth[] {
	const out: Depth[] = [];
	for (const depth of DEPTH_ORDER) {
		const result = synthesise(spec, depth, `Primal ${spec.name}`);
		if (result.ok) {
			out.push(depth);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** `names.json` as it sits on disk. */
export interface NameBook {
	readonly version: number;
	readonly $comment: string;
	readonly names: readonly string[];
}

/** Reads `names.json`, rejecting a malformed or duplicated list rather than shipping one. */
export function loadNames(path: string = NAMES_PATH): readonly string[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as NameBook;
	if (raw.version !== 1) {
		throw new Error(`propose: names.json is v${raw.version}; this build reads v1`);
	}
	if (!Array.isArray(raw.names) || raw.names.length === 0) {
		throw new Error("propose: names.json states no names");
	}
	const seen = new Set<string>();
	for (const name of raw.names) {
		if (typeof name !== "string" || !/^[A-Z][a-z]+$/.test(name)) {
			throw new Error(`propose: names.json states ${JSON.stringify(name)}, which is not a single capitalised word`);
		}
		if (seen.has(name.toLowerCase())) {
			throw new Error(`propose: names.json states ${JSON.stringify(name)} twice`);
		}
		seen.add(name.toLowerCase());
	}
	return raw.names;
}

// ---------------------------------------------------------------------------
// The approval ledger
// ---------------------------------------------------------------------------

/**
 * The sha256 a reviewer's signature covers.
 *
 * It hashes the ARTEFACT - the colours the contact-sheet card actually pictures,
 * at every depth the family expresses - rather than the card's HTML. That is a
 * deliberate departure from the design, which said to hash the card: hashing
 * markup means a CSS tweak invalidates every approval in the file at once, which
 * would train a reviewer to re-sign without looking. Hashing the colours means a
 * signature survives a redesign of the sheet and dies the moment the theme
 * changes, which is the property that was actually wanted.
 */
export function cardHash(spec: FamilySpec, seedsByDepth: ReadonlyMap<Depth, Seed>): string {
	const hash = createHash("sha256");
	hash.update(`${spec.id}\n${spec.mode}\n${spec.register}\n${spec.syntaxEmphasis}\n`);
	for (const depth of DEPTH_ORDER) {
		const seed = seedsByDepth.get(depth);
		if (seed === undefined) {
			continue;
		}
		hash.update(`${depth}:${DEPTH_STEPS[depth]}\n`);
		for (const slot of Object.keys(seed).sort()) {
			hash.update(`${slot}=${(seed as unknown as Record<string, string>)[slot]}\n`);
		}
	}
	return hash.digest("hex");
}

/** An unsigned approval, for a family no human has looked at yet. */
export function unreviewed(sheet: string): Approval {
	return { by: "unreviewed", on: null, sheet };
}

// ---------------------------------------------------------------------------
// families.json
// ---------------------------------------------------------------------------

/** `families.json` as it sits on disk. Versioned exactly as `vibe-tokens.json` is. */
export interface FamilyBook {
	readonly version: number;
	readonly families: readonly FamilySpec[];
}

/** Reads and validates every spec, failing fast with the offending family and field. */
export function loadFamilyBook(path: string = FAMILIES_PATH): readonly FamilySpec[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const raw = JSON.parse(text) as { readonly version?: number; readonly families?: readonly unknown[] };
	if (raw.version !== FAMILIES_VERSION) {
		throw new Error(`propose: families.json is v${raw.version}; this build reads v${FAMILIES_VERSION}`);
	}
	if (!Array.isArray(raw.families)) {
		throw new Error("propose: families.json has no `families` array");
	}
	const seen = new Set<string>();
	return raw.families.map((entry, index) => {
		const spec = parseSpec(entry, `families[${index}]`);
		if (seen.has(spec.id)) {
			throw new Error(`propose: families.json states the id ${JSON.stringify(spec.id)} twice`);
		}
		seen.add(spec.id);
		return spec;
	});
}

/**
 * The exact on-disk form: tabs and a trailing newline, key order fixed by
 * `orderSpec`, so a regenerated file diffs cleanly against a reviewed one.
 */
export function serialiseFamilyBook(specs: readonly FamilySpec[], comment: string): string {
	const book = {
		$comment: comment,
		$generated:
			"GENERATED by primal/theme/synth/propose.ts --propose. The `slack` block and the `depths` list are measurements " +
			"re-checked on every build; the `approval` block is a human decision. Do not hand-edit either.",
		version: FAMILIES_VERSION,
		families: specs.map(orderSpec)
	};
	return `${JSON.stringify(book, null, "\t")}\n`;
}

/** Fixes the key order in the emitted JSON so a diff reads the way the spec is documented. */
function orderSpec(spec: FamilySpec): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: spec.id,
		name: spec.name,
		mode: spec.mode,
		depths: spec.depths,
		planeL: spec.planeL,
		planeC: spec.planeC,
		planeH: spec.planeH,
		inkContrast: spec.inkContrast,
		inkChromaScale: spec.inkChromaScale,
		chromeFraction: spec.chromeFraction,
		register: spec.register,
		syntaxHueOffset: spec.syntaxHueOffset,
		syntaxChroma: spec.syntaxChroma,
		fFunction: spec.fFunction,
		fString: spec.fString
	};
	if (spec.fKeyword !== undefined) {
		out["fKeyword"] = spec.fKeyword;
	}
	out["fConstant"] = spec.fConstant;
	out["fComment"] = spec.fComment;
	out["constantKick"] = spec.constantKick;
	out["syntaxEmphasis"] = spec.syntaxEmphasis;
	out["ansiHueOffsets"] = spec.ansiHueOffsets;
	out["ansiChromaScale"] = spec.ansiChromaScale;
	out["ansiRungSpread"] = spec.ansiRungSpread;
	out["ansiAir"] = spec.ansiAir;
	out["selectionStep"] = spec.selectionStep;
	out["approval"] = spec.approval;
	out["slack"] = spec.slack;
	return out;
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

/** What a full `--propose` run produced. */
export interface Proposal {
	readonly specs: readonly FamilySpec[];
	readonly report: SearchReport;
	readonly accepted: readonly FamilyIdentity[];
	/** Names left over, so the report can say whether naming or packing was the binding constraint. */
	readonly namesRemaining: number;
}

/**
 * The whole offline pipeline: draw, keep, pack, measure depths, name.
 *
 * `seeded` is the eleven families that already ship, which the packer must
 * respect but never re-emits.
 */
export function propose(
	draws: number,
	rngSeed: number,
	seeded: readonly FamilyIdentity[],
	names: readonly string[],
	onProgress?: (done: number, clean: number) => void
): Proposal {
	const report = search(draws, rngSeed, onProgress);
	const byKey = new Map(report.clean.map(candidate => [candidate.identity.key, candidate]));
	const packed = packFarthestPoint(seeded, report.clean.map(candidate => candidate.identity));

	const specs: FamilySpec[] = [];
	let nameIndex = 0;
	for (const identity of packed) {
		if (nameIndex >= names.length) {
			break;
		}
		const candidate = byKey.get(identity.key);
		if (candidate === undefined) {
			continue;
		}
		const name = names[nameIndex++];
		const named: FamilySpec = { ...candidate.spec, id: name.toLowerCase(), name };
		const depths = expressibleDepths(named);
		if (!depths.includes("medium")) {
			// It built at medium a moment ago; if it does not now, something is not
			// deterministic and the run must stop rather than ship the difference.
			throw new Error(`propose: ${name} built at medium during the search and does not now - synthesis is not deterministic`);
		}
		const seedsByDepth = new Map<Depth, Seed>();
		for (const depth of depths) {
			const result = synthesise(named, depth, `Primal ${name}`);
			if (result.ok) {
				seedsByDepth.set(depth, result.value.seed);
			}
		}
		const medium = synthesise({ ...named, depths }, "medium", `Primal ${name}`);
		if (!medium.ok) {
			throw new Error(`propose: ${name} stopped synthesising after naming`);
		}
		specs.push({
			...named,
			depths,
			slack: medium.value.report.slack,
			approval: unreviewed(cardHash({ ...named, depths }, seedsByDepth))
		});
	}
	return { specs, report, accepted: packed, namesRemaining: Math.max(0, names.length - nameIndex) };
}

/** Writes `families.json`. The only thing in this file that touches the tree. */
export function writeFamilyBook(specs: readonly FamilySpec[], comment: string, path: string = FAMILIES_PATH): void {
	writeFileSync(path, serialiseFamilyBook(specs, comment), "utf8");
}

// ---------------------------------------------------------------------------
// --repair
// ---------------------------------------------------------------------------

/** One step of a repair walk, for the diff a human reviews. */
export interface RepairStep {
	readonly field: string;
	readonly from: number;
	readonly to: number;
}

/** What a repair attempt concluded. */
export interface RepairOutcome {
	readonly id: string;
	readonly before: Infeasible;
	readonly steps: readonly RepairStep[];
	readonly repaired: FamilySpec | null;
	/** When no repair exists, the reason - usually the two axes pulling opposite ways. */
	readonly why: string;
}

/** The bounded moves `--repair` may make, per axis, and the direction each one goes. */
const REPAIR_MOVES: Readonly<Record<string, { readonly delta: number; readonly bound: Bound }>> = {
	ansiChromaScale: { delta: -0.05, bound: ANSI_CHROMA_SCALE },
	ansiAir: { delta: -0.2, bound: ANSI_AIR },
	ansiRungSpread: { delta: -0.01, bound: { min: 0, max: 0.02 } },
	syntaxChroma: { delta: -0.005, bound: { min: 0, max: 1 } },
	fComment: { delta: 0.02, bound: F_COMMENT },
	fConstant: { delta: 0.02, bound: { min: 0, max: 1 } },
	fFunction: { delta: -0.02, bound: { min: 0, max: 1 } },
	fString: { delta: -0.02, bound: { min: 0, max: 1 } },
	inkContrast: { delta: -0.25, bound: { min: 9.5, max: 16.5 } },
	planeL: { delta: 0.005, bound: { min: 0, max: 1 } },
	chromeFraction: { delta: -0.01, bound: CHROME_FRACTION }
};

/**
 * Walks the declared repair ladder for one infeasible spec, inside its own box,
 * and returns the changed spec for a human to review.
 *
 * NEVER AT BUILD TIME AND NEVER AUTOMATICALLY. A repair changes what ships, so
 * it produces a diff and stops.
 */
export function repair(spec: FamilySpec, ladder: readonly string[], maxSteps: number = 12): RepairOutcome {
	const first = synthesise(spec, "medium", `Primal ${spec.name}`);
	if (first.ok) {
		return { id: spec.id, before: { stage: "ground", slot: "-", axis: "-", detail: "not broken" }, steps: [], repaired: spec, why: "already synthesises" };
	}
	const steps: RepairStep[] = [];
	let current = spec;
	for (const field of ladder) {
		const move = REPAIR_MOVES[field];
		if (move === undefined) {
			continue;
		}
		for (let step = 0; step < maxSteps; step++) {
			const from = (current as unknown as Record<string, number>)[field];
			if (typeof from !== "number") {
				break;
			}
			const to = Math.round((from + move.delta) * 10000) / 10000;
			if (to < move.bound.min || to > move.bound.max) {
				break;
			}
			current = { ...current, [field]: to } as FamilySpec;
			steps.push({ field, from, to });
			const attempt = synthesise(current, "medium", `Primal ${current.name}`);
			if (attempt.ok) {
				return { id: spec.id, before: first.error, steps, repaired: current, why: "repaired" };
			}
		}
	}
	return {
		id: spec.id,
		before: first.error,
		steps,
		repaired: null,
		why:
			"no repair inside the spec's own box. Ramp infeasibility wants ansiChromaScale down and ladder infeasibility " +
			"wants it up; a family pinned between the two has to be dropped by a human."
	};
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

/**
 * The property test: draw from the whole box and assert that whatever comes back
 * is either a theme that holds every invariant, or an `Infeasible` that names a
 * stage, a slot and a repair axis that exists.
 *
 * `draws` is a TIME BUDGET, not a confidence level. Each draw costs about seven
 * milliseconds, so the default keeps `--self-test` interactive; a CI run should
 * pass a few thousand. What the test asserts does not change with the number.
 */
export function runPropertyTests(draws: number): readonly string[] {
	const failures: string[] = [];
	const rng = mulberry32(20260910);
	let clean = 0;
	let infeasible = 0;
	for (let i = 0; i < draws; i++) {
		const mode: ThemeMode = rng() < 0.5 ? "dark" : "light";
		const spec = drawSpec(rng, mode);
		let outcome;
		try {
			outcome = synthesise(spec, "medium", "Primal Draft");
		} catch (error) {
			failures.push(`propose: property: draw ${i} THREW rather than returning Infeasible: ${(error as Error).message.split("\n")[0]}`);
			continue;
		}
		if (!outcome.ok) {
			infeasible++;
			const error = outcome.error;
			if (REPAIR_LADDER[error.stage] === undefined) {
				failures.push(`propose: property: draw ${i} names stage "${error.stage}", which has no repair ladder`);
			}
			if (error.slot.length === 0 || error.axis.length === 0 || error.detail.length === 0) {
				failures.push(`propose: property: draw ${i} returned an Infeasible with an empty field`);
			}
			continue;
		}
		clean++;
		const report = outcome.value.report;
		const problems: string[] = [];
		if (report.ansi.worstPair < 10) {
			problems.push(`worst ANSI pair ${report.ansi.worstPair.toFixed(2)}`);
		}
		if (report.ansi.minContrast < 3) {
			problems.push(`worst ANSI contrast ${report.ansi.minContrast.toFixed(2)}`);
		}
		if (report.slack.syntaxMinSeparation < 2.3) {
			problems.push(`syntax roles ${report.slack.syntaxMinSeparation} apart`);
		}
		if (validate(outcome.value.theme as Parameters<typeof validate>[0]).errors.length > 0) {
			problems.push("the validator reports errors");
		}
		if (problems.length > 0) {
			failures.push(`propose: property: draw ${i} came back Ok but ${problems.join("; ")}`);
		}
	}
	if (clean === 0) {
		failures.push(`propose: property: none of ${draws} draws produced a theme, so the Ok branch asserts nothing`);
	}
	if (infeasible === 0) {
		failures.push(`propose: property: all ${draws} draws succeeded, so the Infeasible branch asserts nothing`);
	}
	return failures;
}

/** The `propose.ts` suite. Returns one line per failing assertion; empty is a pass. */
export function runProposeTests(): readonly string[] {
	const failures: string[] = [];
	const check = (what: string, condition: boolean, detail: string): void => {
		if (!condition) {
			failures.push(`propose: ${what}: ${detail}`);
		}
	};

	// The PRNG is a PRNG: same seed, same stream; different seed, different stream.
	{
		const a = mulberry32(7);
		const b = mulberry32(7);
		const c = mulberry32(8);
		const first = [a(), a(), a()].join(",");
		check("the PRNG is reproducible", first === [b(), b(), b()].join(","), "two streams from one seed disagreed");
		check("the PRNG depends on its seed", first !== [c(), c(), c()].join(","), "two seeds gave one stream");
		const rng = mulberry32(1);
		let min = 1;
		let max = 0;
		for (let i = 0; i < 5000; i++) {
			const value = rng();
			min = Math.min(min, value);
			max = Math.max(max, value);
		}
		check("the PRNG stays in [0, 1)", min >= 0 && max < 1, `range ${min} to ${max}`);
	}

	// Every draw is a legal spec, in both modes and both registers.
	{
		const rng = mulberry32(42);
		const registers = new Set<string>();
		const modes = new Set<string>();
		for (let i = 0; i < 400; i++) {
			const mode: ThemeMode = i % 2 === 0 ? "dark" : "light";
			const spec = drawSpec(rng, mode);
			registers.add(spec.register);
			modes.add(spec.mode);
			try {
				parseSpec(JSON.parse(JSON.stringify(spec)), `draw ${i}`);
			} catch (error) {
				failures.push(`propose: draw ${i} is not a legal spec: ${(error as Error).message}`);
			}
		}
		check("the search samples both registers", registers.size === 2, `got ${[...registers].join(",")}`);
		check("the search samples both modes", modes.size === 2, `got ${[...modes].join(",")}`);
	}

	// The search is reproducible from its seed.
	{
		const first = search(60, 5);
		const second = search(60, 5);
		check("the search is reproducible", JSON.stringify(first.clean.map(c => c.seed)) === JSON.stringify(second.clean.map(c => c.seed)),
			"two runs from one seed disagreed");
		check("the search finds something", first.clean.length > 0, "no clean candidate in 60 draws");
		const total = first.clean.length + Object.values(first.failures).reduce((s, n) => s + n, 0);
		check("every draw is accounted for", total === first.draws, `${total} accounted, ${first.draws} drawn`);
	}

	// The card hash covers the artefact: it moves when a colour moves and holds
	// when nothing does.
	{
		const rng = mulberry32(11);
		let spec: FamilySpec | null = null;
		for (let i = 0; i < 200 && spec === null; i++) {
			const candidate = drawSpec(rng, i % 2 === 0 ? "dark" : "light");
			if (synthesise(candidate, "medium", "Primal Draft").ok) {
				spec = candidate;
			}
		}
		if (spec === null) {
			failures.push("propose: the card-hash test found no clean spec to hash");
		} else {
			const build = (s: FamilySpec): Map<Depth, Seed> => {
				const out = new Map<Depth, Seed>();
				const result = synthesise(s, "medium", "Primal Draft");
				if (result.ok) {
					out.set("medium", result.value.seed);
				}
				return out;
			};
			const hash = cardHash(spec, build(spec));
			check("the card hash is a sha256", /^[0-9a-f]{64}$/.test(hash), `got ${hash}`);
			check("the card hash is stable", cardHash(spec, build(spec)) === hash, "two hashes of one theme disagreed");
			const moved = { ...spec, planeH: (spec.planeH + 40) % 360 } as FamilySpec;
			const movedSeeds = build(moved);
			if (movedSeeds.size > 0) {
				check("the card hash moves when the theme moves", cardHash(moved, movedSeeds) !== hash, "a different theme hashed the same");
			}
		}
	}

	// Serialisation round-trips through the strict reader.
	{
		const rng = mulberry32(3);
		const spec = drawSpec(rng, "dark");
		const named: FamilySpec = { ...spec, id: "harbour", name: "Harbour" };
		const text = serialiseFamilyBook([named], "test");
		check("the emitted book ends in a newline", text.endsWith("}\n"), "it does not");
		check("the emitted book is tab-indented", text.includes("\n\t\""), "it is not");
		const parsed = JSON.parse(text) as FamilyBook;
		try {
			const back = parseSpec(parsed.families[0], "round-trip");
			check("the round-trip preserves the id", back.id === "harbour", `got ${back.id}`);
			check("the round-trip preserves every number",
				back.planeL === named.planeL && back.ansiAir === named.ansiAir && back.syntaxChroma === named.syntaxChroma,
				"a number moved");
		} catch (error) {
			failures.push(`propose: the emitted book does not parse: ${(error as Error).message}`);
		}
	}

	// The repair walk is bounded, stays in the box, and reports honestly when
	// there is nothing to do.
	{
		const rng = mulberry32(77);
		let broken: FamilySpec | null = null;
		for (let i = 0; i < 300 && broken === null; i++) {
			const candidate = drawSpec(rng, "dark");
			if (!synthesise(candidate, "medium", "Primal Draft").ok) {
				broken = candidate;
			}
		}
		if (broken === null) {
			failures.push("propose: the repair test found no infeasible spec, so it asserts nothing");
		} else {
			const outcome = repair(broken, ["ansiChromaScale", "ansiAir", "ansiRungSpread", "planeL"]);
			check("the repair walk is bounded", outcome.steps.length <= 48, `${outcome.steps.length} steps`);
			for (const step of outcome.steps) {
				const move = REPAIR_MOVES[step.field];
				check(`the repair walk stays in the box on ${step.field}`, step.to >= move.bound.min && step.to <= move.bound.max,
					`moved to ${step.to}, box [${move.bound.min}, ${move.bound.max}]`);
			}
			if (outcome.repaired !== null) {
				check("a repaired spec actually synthesises", synthesise(outcome.repaired, "medium", "Primal Draft").ok, "it does not");
				try {
					parseSpec(JSON.parse(JSON.stringify(outcome.repaired)), "repaired");
				} catch (error) {
					failures.push(`propose: a repaired spec left the house box: ${(error as Error).message}`);
				}
			} else {
				check("an unrepairable spec explains itself", outcome.why.length > 40, "the reason is too short to be one");
			}
		}
	}

	// The name book is screened as strictly as it is read.
	try {
		const names = loadNames();
		check("the name book is not empty", names.length > 0, "it is");
		check("every name is one capitalised word", names.every(name => /^[A-Z][a-z]+$/.test(name)), "one is not");
	} catch (error) {
		failures.push(`propose: names.json does not load: ${(error as Error).message}`);
	}

	return failures;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	const failures = runProposeTests();
	for (const line of failures) {
		console.error(`  ${line}`);
	}
	if (failures.length > 0) {
		console.error(`\npropose: ${failures.length} failing assertion(s)`);
		process.exit(1);
	}
	console.log("propose: all assertions pass (seeded PRNG, legal draws, reproducible search, card hash, round-trip, bounded repair)");
	process.exit(0);
}
