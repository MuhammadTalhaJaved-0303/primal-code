#!/usr/bin/env node --experimental-strip-types
/**
 * The THIRD producer, beside the six hand-authored vibes and the corpus
 * families: a synthesised family read out of `primal/design/families.json`.
 *
 * It lives beside the synthesiser rather than inside `buildThemes.ts` for two
 * reasons. The first is size - `buildThemes.ts` was already the longest file in
 * `primal/theme/` before a third producer existed. The second is that everything
 * here is testable without a catalogue: given a spec it either produces a theme
 * or names the stage, slot and repair axis that stopped it, and none of that
 * needs to know what else ships.
 *
 * It takes the naming rules as ARGUMENTS rather than importing them. `buildThemes`
 * owns `FORBIDDEN_IDENTITIES` and the list of names already in use, and passing
 * them in is what keeps this module out of an import cycle with the file that
 * decides what ships.
 */

import type { Depth } from "../importPalette.ts";
import type { SemanticLadder, Seed } from "../generateTheme.ts";
import { validate, type ColorTheme, type Finding } from "../validateTheme.ts";
import { cardHash, loadFamilyBook } from "./propose.ts";
import { REPAIR_LADDER, round2, synthesise, type SynthesisReport } from "./synthesise.ts";
import type { FamilySpec } from "./spec.ts";

/** A name a synthesised family may not take, and what already holds it. */
export interface ReservedName {
	readonly id: string;
	readonly heldBy: string;
}

/** A substring that keeps a name out of the catalogue, with the reason. See buildThemes.FORBIDDEN_IDENTITIES. */
export interface NameExclusion {
	readonly match: string;
	readonly why: string;
}

/**
 * `primal/design/families.json`, read the way `loadVibes` reads
 * `vibe-tokens.json` - version-guarded, every field bounds-checked, and no
 * silent defaulting anywhere.
 *
 * The naming rule is applied HERE and nowhere else, because a synthesised family
 * derives from no upstream palette and `excludedBecause` therefore has nothing
 * to say about it. A name that collides with a mark, with a vibe or with a
 * corpus family stops the build.
 */
export function loadFamilies(path: string, reserved: readonly ReservedName[], forbidden: readonly NameExclusion[]): readonly FamilySpec[] {
	const specs = loadFamilyBook(path);
	const taken = new Map<string, string>();
	for (const entry of reserved) {
		taken.set(entry.id.toLowerCase(), entry.heldBy);
	}
	for (const spec of specs) {
		const haystack = `${spec.id} ${spec.name}`.toLowerCase();
		for (const rule of forbidden) {
			if (haystack.includes(rule.match)) {
				throw new Error(
					`buildThemes: families.json names "${spec.name}", which the naming rules exclude: ${rule.why} - matched "${rule.match}". ` +
					"Rename it in primal/design/names.json and re-run --propose."
				);
			}
		}
		const clash = taken.get(spec.id);
		if (clash !== undefined) {
			throw new Error(`buildThemes: families.json names "${spec.name}", which is already ${clash}`);
		}
		taken.set(spec.id, "another synthesised family");
	}
	return specs;
}

/** One synthesised theme, generated and judged. */
export interface SynthBuilt {
	readonly spec: FamilySpec;
	readonly depth: Depth;
	readonly theme: ColorTheme;
	readonly ladder: SemanticLadder;
	readonly report: SynthesisReport;
	readonly seed: Seed;
	readonly warnings: readonly Finding[];
}

/**
 * A family that could not be built, collected rather than thrown.
 *
 * `buildCatalogue` gathers every one of these and reports them together. A build
 * that threw on the first would turn a shared-constant change into a sequence of
 * guesses, one re-run per broken family.
 */
export interface CatalogueError {
	readonly family: string;
	readonly detail: string;
}

/**
 * Build and judge one synthesised (spec, depth).
 *
 * NO `classify`, NO tolerances, NO `ENGINE_FLOOR`. A synthesised family has no
 * upstream to blame: it is generated against the gate's own arithmetic, so the
 * only acceptable number of validator errors is zero, and anything else is a
 * defect in this pipeline rather than in a palette somebody else wrote.
 */
export function buildSynthesised(spec: FamilySpec, depth: Depth, label: string): SynthBuilt | CatalogueError {
	const result = synthesise(spec, depth, label);
	if (!result.ok) {
		const error = result.error;
		return {
			family: `${spec.name} @ ${depth}`,
			detail:
				`stage ${error.stage}, slot ${error.slot}: ${error.detail}\n` +
				`      repair axis ${error.axis}; the declared ladder for this stage is ${REPAIR_LADDER[error.stage].join(" -> ")}`
		};
	}
	const validation = validate(result.value.theme as ColorTheme);
	if (validation.errors.length > 0) {
		const detail = validation.errors.map(f => `        ${f.check} | ${f.token} | ${f.measured}`).join("\n");
		return { family: `${spec.name} @ ${depth}`, detail: `${validation.errors.length} validator error(s):\n${detail}` };
	}
	return {
		spec,
		depth,
		theme: result.value.theme as ColorTheme,
		ladder: result.value.report.ladder,
		report: result.value.report,
		seed: result.value.seed,
		warnings: validation.warnings
	};
}

export function isCatalogueError(value: SynthBuilt | CatalogueError): value is CatalogueError {
	return (value as CatalogueError).detail !== undefined;
}

/** `harbour`, `harbour-soft`. Same shape as `variantId`, on a spec rather than a corpus family. */
export function synthVariantId(spec: FamilySpec, depth: Depth): string {
	return depth === "medium" ? spec.id : `${spec.id}-${depth}`;
}

/** `Primal Harbour`, `Primal Harbour Soft`. */
export function synthVariantLabel(spec: FamilySpec, depth: Depth): string {
	return depth === "medium" ? `Primal ${spec.name}` : `Primal ${spec.name} ${depth[0].toUpperCase()}${depth.slice(1)}`;
}

/** `harbourSoftThemeLabel`. */
export function synthNlsKey(spec: FamilySpec, depth: Depth): string {
	const suffix = depth === "medium" ? "" : `${depth[0].toUpperCase()}${depth.slice(1)}`;
	return `${spec.id}${suffix}ThemeLabel`;
}

/**
 * Re-measures the `slack` block a spec records, and the `approval` hash.
 *
 * The point of recording margins in `families.json` is that they can go stale:
 * move a shared constant and a family's worst ANSI pair moves with it, and a
 * file that still claims the old number is worse than one that claims nothing.
 * So both are recomputed on every build and a drift is a named, blocking error -
 * which is also, for the approval hash, the mechanism that makes a human
 * decision into a build invariant: a spec that changed without being
 * re-reviewed fails here rather than shipping unreviewed.
 */
export function verifyLedger(spec: FamilySpec, seedsByDepth: ReadonlyMap<Depth, Seed>, measured: SynthesisReport): readonly string[] {
	const problems: string[] = [];
	const recorded = spec.slack;
	const fresh = measured.slack;
	for (const key of Object.keys(fresh) as (keyof typeof fresh)[]) {
		if (round2(recorded[key]) !== round2(fresh[key])) {
			problems.push(`slack.${key} records ${recorded[key]}, measures ${fresh[key]}`);
		}
	}
	const hash = cardHash(spec, seedsByDepth);
	if (hash !== spec.approval.sheet) {
		problems.push(
			`approval.sheet signs ${spec.approval.sheet.slice(0, 16)}... but the family now hashes ${hash.slice(0, 16)}... ` +
			"- the theme moved since it was reviewed"
		);
	}
	return problems;
}
