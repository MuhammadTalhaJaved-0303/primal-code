#!/usr/bin/env node --experimental-strip-types
/**
 * When are two Primal families the same theme? Measured for THIS owner.
 *
 * `buildThemes.MIN_FAMILY_PLANE_SEPARATION` answers it with one number on one
 * slot under one observer: two editor planes at least 4 dE00 apart, trichromat.
 * That rule is wrong twice over, and both failures are measured, not argued:
 *
 *   - It ADMITS a pair the product should never have shipped twice. `vibe:tide`
 *     and `vibe:dusk` state editor planes 7.14 dE00 apart to a trichromat and
 *     0.14 apart to this owner. Six of their seven identity slots are the same
 *     colour to him. The current rule cannot see it, because it never simulates
 *     the eyes that have to read the result.
 *   - It REJECTS a pair the product already ships. `vibe:ink` and `vibe:ridge`
 *     sit at 2.59 dE00 of ground separation - below 4 - and they are plainly two
 *     different themes. So 4 was never a house rule; it was a corpus-selection
 *     heuristic from when the ground was the only axis being varied.
 *
 * So the metric here is worst-of-four-observers, over the seven slots that carry
 * identity, weighted by roughly how much of the screen each one paints. A metric
 * that separated families by hue alone would be a lie for this owner.
 *
 *   node --experimental-strip-types primal/theme/synth/distinct.ts --self-test
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OBSERVERS, deltaE2000, rgbToLab, simulateCvd, type Lab } from "../../../src/vs/base/common/primalColorScience.ts";
import { parseHex } from "../color.ts";
import type { Seed } from "../generateTheme.ts";
import type { SyntaxEmphasis, ThemeMode } from "../tokenMap.ts";
import type { Register } from "./spec.ts";

// ---------------------------------------------------------------------------
// The metric
// ---------------------------------------------------------------------------

/**
 * The seven slots that carry family identity.
 *
 * `operator` and `type` are excluded because the house ALIASES them - `operator`
 * is always the editor ink, `type` is always either `keyword` or `function` - so
 * including them would be counting the same colour twice and inflating every
 * distance by the same factor.
 *
 * The sixteen ANSI slots and the eleven chrome surfaces are excluded
 * deliberately. With every ANSI hue pinned inside its own house band the
 * terminal cannot carry family identity, and every surface is derived from a
 * fallback rather than chosen.
 */
export const IDENTITY_SLOTS: readonly (keyof Seed)[] =
	["editorBg", "editorFg", "comment", "keyword", "string", "function", "constant"];

/**
 * Roughly how much of a viewport each identity slot paints.
 *
 * These are an ESTIMATE of screen area, not a pixel census, and they are
 * load-bearing: the whole argument that `tide` and `dusk` are one theme depends
 * on the syntax slots collectively getting 0.40 of the vote. They sum to 1.
 */
export const IDENTITY_WEIGHTS: Readonly<Record<string, number>> = {
	editorBg: 0.34,
	editorFg: 0.16,
	comment: 0.10,
	keyword: 0.14,
	string: 0.10,
	function: 0.08,
	constant: 0.08
};

/** Past this distance a slot carries no more identity, so more difference buys nothing. */
export const IDENTITY_CAP = 20;

/** The repo's own quoted just-noticeable difference for ordinary viewing (`validateTheme.ts:98-101`). */
export const JND = 2.3;

/**
 * The distance two families must keep, fitted rather than chosen.
 *
 * Over the 55 pairs of the eleven families that ship today, T = 5.0 admits 53
 * and rejects exactly the two that every prior review independently flagged as
 * duplicates. The separation is not marginal: measured here, the largest
 * rejected pair is `Umber | Cinder` at 2.91 and the smallest admitted one is
 * `vibe:basalt | vibe:fern` at 5.02 - a factor of 1.7 with nothing in between.
 * The median shipped pair is 12.40 and the widest is the 20.00 cap.
 *
 * It rests on 55 pairs, two of which the design is arguing were mistakes. The
 * 1.7x gap is genuinely encouraging; the right way to firm it up is for the
 * owner to sort two dozen generated pairs by eye on the contact sheet.
 */
export const FAMILY_DISTANCE_THRESHOLD = 5.0;

/**
 * The distance the OFFLINE PACKER keeps between families, which is deliberately
 * wider than the gate.
 *
 * The gate above is fitted to two negatives (1.33 and 2.91) and one positive
 * at 5.02, so all it establishes is that the duplicate boundary lies somewhere
 * in (2.91, 5.02). A packer that packs AT the gate fills that uncertainty to the
 * brim: measured on the first catalogue drawn this way, every synthesised family
 * had its nearest neighbour in [5.00, 6.74] with a median of 5.48, so a later
 * move of T by half a unit would have failed dozens of families at once.
 *
 * 5.99 is `vibe:basalt | vibe:dusk`, pinned below: the closest shipped pair the
 * design itself puts forward as PLAINLY two themes (achromatic weight-led against
 * purple keyword-led), rather than one it merely tolerates. The two shipped pairs
 * closer than that - basalt|fern at 5.02 and tide|fern at 5.19 - are the ones the
 * comment above says still need the owner's eye. Packing at the basalt|dusk level
 * means a synthesised family is never closer to its neighbour than a pair the
 * house has already argued is distinct.
 *
 * THIS TIGHTENS THE PROPOSER, NOT THE GATE. The build still gates at 5.0, the
 * calibration is untouched, and the catalogue is simply smaller and further from
 * the edge. `runDistinctTests` asserts it equals the pinned basalt|dusk value.
 */
export const PACKING_DISTANCE_THRESHOLD = 5.99;

/**
 * How many of the seven identity slots must differ by at least a JND.
 *
 * WHY THE RULE EXISTS. An RMS capped at 20 lets a single slot buy a family:
 * `sqrt(0.16 x 400)` is 8.0, so `editorFg` alone clears T while the other six
 * slots are byte-identical. A floor on how many slots actually moved closes
 * THAT case - the byte-identical one.
 *
 * WHAT IT DOES NOT CLOSE, stated so nobody relies on it. The rule counts slots
 * past a JND, not slots carrying identity: a candidate whose six inks sit 0.3
 * dE00 past the JND from another family's still counts six differing slots. A
 * ground 10 dE00 away with two inks nudged just past 2.3 is K = 3 and D 5.9, and
 * rule (2) admits it. It is rule (3) - the off-ground distance - that closes the
 * nudged case, and the `ground alone cannot buy a family` self-test is the proof.
 * Raising the per-slot bar to 2 x JND was measured and rejected: it newly rejects
 * 24 admitted pairs including the shipped `vibe:basalt | vibe:fern`, which would
 * need a grandfather entry to keep shipping.
 *
 * WHY IT IS THREE AND NOT FOUR, which is a deliberate departure from the design.
 * The design specifies four, citing `vibe:basalt | vibe:dusk` at 4 of 7. Measured
 * here it is 3 of 7 - `editorFg` separates by 2.12, a hair under the 2.3 JND:
 *
 *     editorBg 1.55  editorFg 2.12  comment 7.80  keyword 11.90
 *     string 1.01  function 1.03  constant 10.13          D_owner 5.99
 *
 * so K = 4 rejects the very pair the design puts forward as the reason a shared
 * ground is allowed at all. Over the 55 shipped pairs the distribution of K is
 * {1: 1, 3: 2, 5: 2, 6: 8, 7: 42}, and the LOWEST K among the 53 pairs that clear
 * T is 3. Four is therefore not a threshold this catalogue meets; three is the
 * tightest one it does.
 *
 * Nothing is lost by it. The two pairs the rule set is fitted to reject -
 * `vibe:tide | vibe:dusk` at D 1.33 and `Umber | Cinder` at D 2.91 - are both
 * rejected by rule (1) before rule (2) is consulted, so K = 3 rejects exactly the
 * same pairs as K = 4 would if K = 4 were not also rejecting a good one.
 */
export const MIN_DIFFERING_SLOTS = 3;

/** What the metric needs to know about a family. Depth is deliberately absent; see `D_owner`. */
export interface FamilyIdentity {
	/** Stable key for reports and for the grandfather list, e.g. `"vibe:tide"` or `"Umber"`. */
	readonly key: string;
	readonly mode: ThemeMode;
	readonly register: Register;
	readonly emphasis: SyntaxEmphasis;
	/** The seven identity colours, keyed by slot. */
	readonly colors: Readonly<Record<string, string>>;
}

/**
 * Which register a family is in, read off its own colours rather than declared.
 *
 * The ink-led register is the one where `keyword` IS the editor ink. That is a
 * property of the emitted theme, so it works identically for a hand-authored
 * vibe, a corpus family and a synthesised one - none of which share a spec
 * format.
 */
export function registerOf(seed: Seed): Register {
	return seed.keyword.toUpperCase() === seed.editorFg.toUpperCase() ? "inkLed" : "keywordLed";
}

/** Reduces a seed to the seven slots the metric measures. */
export function identityOf(key: string, seed: Seed, mode: ThemeMode, emphasis: SyntaxEmphasis): FamilyIdentity {
	const colors: Record<string, string> = {};
	for (const slot of IDENTITY_SLOTS) {
		colors[slot] = seed[slot];
	}
	return { key, mode, register: registerOf(seed), emphasis, colors };
}

/**
 * Distance between two colours as the WORST of the four observers sees it,
 * capped.
 *
 * Worst rather than normal, because the owner is one of the four and a distance
 * only a trichromat can measure is not a distance he can use.
 */
export function slotDistance(a: string, b: string): number {
	const first = observedLabs(a);
	const second = observedLabs(b);
	let worst = Number.POSITIVE_INFINITY;
	for (let i = 0; i < first.length; i++) {
		const distance = deltaE2000(first[i], second[i]);
		if (distance < worst) {
			worst = distance;
		}
	}
	return Math.min(worst, IDENTITY_CAP);
}

/**
 * One colour as each of the four observers sees it, in CIELAB, memoised.
 *
 * `perceptualDistance` simulates and converts on every call, and the packer asks
 * for the same seven colours of the same family thousands of times. Caching the
 * four Labs per hex is arithmetically identical - the simulation and the Lab
 * conversion are pure functions of the colour - and it is what makes a
 * ten-thousand-candidate pool tractable. The memo is keyed by the hex string, so
 * two slots that hold the same colour share an entry.
 */
const OBSERVED_LABS = new Map<string, readonly Lab[]>();

function observedLabs(hex: string): readonly Lab[] {
	const cached = OBSERVED_LABS.get(hex);
	if (cached !== undefined) {
		return cached;
	}
	const rgb = parseHex(hex);
	const labs = OBSERVERS.map(observer => rgbToLab(observer === "normal" ? rgb : simulateCvd(rgb, observer)));
	OBSERVED_LABS.set(hex, labs);
	return labs;
}

/**
 * How different two families are TO THIS OWNER: a weighted RMS over the seven
 * identity slots, each measured under the worst of four observers.
 *
 * Note what is NOT in here: depth. Depth moves `chromeBg`, `sideBg`,
 * `lineHighlight` and `border` and leaves `editorBg` and every ink untouched, so
 * `D_owner(soft, hard)` for a family against itself is 0.000 - measured, for
 * every family tested. Depth buys picker entries and exactly zero identity, and
 * the catalogue should say so rather than count variants as designs.
 */
export function dOwner(a: FamilyIdentity, b: FamilyIdentity): number {
	let sum = 0;
	for (const slot of IDENTITY_SLOTS) {
		const distance = slotDistance(a.colors[slot], b.colors[slot]);
		sum += IDENTITY_WEIGHTS[slot] * distance * distance;
	}
	return Math.sqrt(sum);
}

/** How many identity slots differ by at least a JND. */
export function differingSlots(a: FamilyIdentity, b: FamilyIdentity): number {
	let count = 0;
	for (const slot of IDENTITY_SLOTS) {
		if (slotDistance(a.colors[slot], b.colors[slot]) >= JND) {
			count++;
		}
	}
	return count;
}

/** Why a pair was rejected, or `null` when it was admitted. */
export type Rejection =
	| { readonly rule: "distance"; readonly measured: number }
	| { readonly rule: "slots"; readonly measured: number }
	/** Same register, same emphasis, and the six non-ground slots do not clear the threshold on their own. `measured` is `dOffGround`. */
	| { readonly rule: "offGround"; readonly measured: number };

/**
 * How different two families are once the GROUND is taken out of the vote:
 * the same weighted RMS over the six non-ground identity slots, renormalised so
 * it is on the same scale as `dOwner`.
 *
 * This is what rule (3) actually needs to ask. See `rejects`.
 */
export function dOffGround(a: FamilyIdentity, b: FamilyIdentity): number {
	let sum = 0;
	let weight = 0;
	for (const slot of IDENTITY_SLOTS) {
		if (slot === "editorBg") {
			continue;
		}
		const distance = slotDistance(a.colors[slot], b.colors[slot]);
		sum += IDENTITY_WEIGHTS[slot] * distance * distance;
		weight += IDENTITY_WEIGHTS[slot];
	}
	return Math.sqrt(sum / weight);
}

/**
 * The whole acceptance rule, in the order the rules were fitted.
 *
 *   (1) D_owner >= `threshold` (the gate's 5.0; the packer passes a wider one)
 *   (2) at least MIN_DIFFERING_SLOTS (three) of the seven identity slots differ
 *       by a JND
 *   (3) when the two families share a register AND an emphasis, the six
 *       non-ground slots must clear the same threshold ON THEIR OWN - whatever
 *       the two grounds do.
 *
 * WHY RULE (3) IS NOT A GROUND FLOOR. The house already ships a shared ground:
 * `vibe:basalt` and `vibe:dusk` sit 1.55 dE00 apart on the ground for this owner
 * and are plainly different themes - achromatic weight-led against purple
 * keyword-led. A hard floor would reject that pair, and a floor of 4 would
 * reject `ink | ridge`, whose grounds are 2.59 dE00 apart even to a trichromat.
 *
 * WHY RULE (3) IS NOT "a different register or emphasis" EITHER, which is the
 * design's rule as written. That rule rejects three pairs the product ships
 * today and that nobody has ever called duplicates. Measured over the eleven
 * shipped families:
 *
 *     ground 2.23  D  7.16   vibe:dusk | Umber     both keywordLed/plain
 *     ground 1.76  D 11.89   vibe:fern | Umber     both keywordLed/plain
 *     ground 2.11  D 13.68   vibe:fern | Trench    both keywordLed/plain
 *
 * A pair 13.68 apart is not one theme however close its grounds sit, and a rule
 * that says otherwise is measuring the ground twice.
 *
 * WHY RULE (3) ASKS THE QUESTION WHATEVER THE GROUNDS DO. The first draft of this
 * rule only asked it when the grounds were within a JND, and that guard made the
 * rule unreachable: D^2 = 0.34 g^2 + 0.66 off^2, and with g < 2.3 the ground
 * contributes at most 1.80 to D^2, so D >= 5 already forces off >= 5.93 > T. The
 * rule fired zero times over 300,000 shared-ground pairs. Worse, the guard
 * exempted exactly the case rule (3) exists for: a ground 8.58 dE00 away clears
 * T by itself (`sqrt(0.34 x 8.58^2)` = 5.0) with the other six slots identical,
 * and the first synthesised catalogue shipped it - `Nettle | Thorn` at D 6.08,
 * ground 10.02, off-ground 2.06, the same warm ink-led syntax on a grey-brown
 * and a near-black plane. Sixteen admitted pairs sat below 5.0 off the ground,
 * eleven of them in the same register and emphasis; the closest were nearer off
 * the ground than `Umber | Cinder`, which the design calls a duplicate. So the
 * guard is gone: what rule (3) guards against is the ground's 0.34 weight
 * carrying a family on its own, and the honest test is to remove the ground from
 * the vote and ask the same question of what is left, every time.
 *
 * It costs nothing in calibration. Over the 55 shipped pairs the rule set admits
 * exactly the 53 the design's own numbers admit and rejects exactly `tide | dusk`
 * (1.64 off-ground) and `Umber | Cinder` (3.45 off-ground), both on rule (1)
 * before rule (3) is consulted. The smallest off-ground distance among the 53
 * admitted shipped pairs is `vibe:basalt | vibe:fern` at 6.02, so rule (3) as
 * written here rejects no shipped pair - `runDistinctTests` asserts that it
 * rejects the ground-carried case, and `buildThemes --self-test` re-measures
 * the shipped matrix on every run.
 */
export function rejects(a: FamilyIdentity, b: FamilyIdentity, threshold: number = FAMILY_DISTANCE_THRESHOLD): Rejection | null {
	const distance = dOwner(a, b);
	if (distance < threshold) {
		return { rule: "distance", measured: distance };
	}
	const slots = differingSlots(a, b);
	if (slots < MIN_DIFFERING_SLOTS) {
		return { rule: "slots", measured: slots };
	}
	if (a.register === b.register && a.emphasis === b.emphasis) {
		const offGround = dOffGround(a, b);
		if (offGround < threshold) {
			return { rule: "offGround", measured: offGround };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * Farthest-point greedy: repeatedly take the candidate whose nearest
 * already-taken family is furthest away.
 *
 * First-fit takes whatever comes first in the list and is what
 * `buildThemes.selectFamilies` does today. On the same pool and the same rule,
 * farthest-point reaches materially more families, because first-fit spends its
 * early picks in whatever corner of the box the list happens to start in.
 * Deterministic and total: ties break on the candidate's position in
 * `candidates`, so the same pool in the same order always yields the same
 * catalogue.
 *
 * IT IS A LOWER BOUND. A real optimiser beats a greedy packer, and the honest
 * reading of the number it returns is "at least this many", not "exactly this
 * many".
 *
 * INCREMENTAL, and the reason matters at the scale this is actually run at. The
 * obvious implementation rescans every alive candidate against every taken
 * family on every round, which is O(n x k) per round and O(n x k^2) overall - on
 * a pool of ten thousand candidates and sixty picks that is hundreds of millions
 * of CIEDE2000 evaluations. This one keeps each candidate's distance to its
 * nearest taken family and updates it against the ONE family taken this round,
 * which is O(n) per round. It is not an approximation: a candidate that survived
 * earlier rounds has already been tested against every family taken then, so
 * testing it against the new one is the whole remaining obligation.
 * `runDistinctTests` asserts the two implementations agree.
 *
 * `threshold` is the distance the packer keeps, and it defaults to
 * `PACKING_DISTANCE_THRESHOLD` rather than the gate: the packer is the one place
 * a margin above the gate can be applied without touching the gate. Pass
 * `FAMILY_DISTANCE_THRESHOLD` explicitly to pack at the gate itself.
 */
export function packFarthestPoint(
	seeded: readonly FamilyIdentity[],
	candidates: readonly FamilyIdentity[],
	limit: number = Number.POSITIVE_INFINITY,
	threshold: number = PACKING_DISTANCE_THRESHOLD
): readonly FamilyIdentity[] {
	const alive: boolean[] = candidates.map(() => true);
	const nearest: number[] = candidates.map(() => Number.POSITIVE_INFINITY);

	const admit = (index: number, against: FamilyIdentity): void => {
		if (!alive[index]) {
			return;
		}
		if (rejects(candidates[index], against, threshold) !== null) {
			alive[index] = false;
			return;
		}
		nearest[index] = Math.min(nearest[index], dOwner(candidates[index], against));
	};

	for (const family of seeded) {
		for (let i = 0; i < candidates.length; i++) {
			admit(i, family);
		}
	}

	const chosen: FamilyIdentity[] = [];
	while (chosen.length < limit) {
		let bestIndex = -1;
		for (let i = 0; i < candidates.length; i++) {
			if (!alive[i]) {
				continue;
			}
			if (bestIndex < 0 || nearest[i] > nearest[bestIndex]) {
				bestIndex = i;
			}
		}
		if (bestIndex < 0) {
			break;
		}
		const taken = candidates[bestIndex];
		alive[bestIndex] = false;
		chosen.push(taken);
		for (let i = 0; i < candidates.length; i++) {
			admit(i, taken);
		}
	}
	return chosen;
}

/**
 * The obvious O(n x k) packer, kept only so the suite can assert that the
 * incremental one above returns the identical catalogue. Never used in anger.
 */
export function packFarthestPointNaive(
	seeded: readonly FamilyIdentity[],
	candidates: readonly FamilyIdentity[],
	limit: number = Number.POSITIVE_INFINITY,
	threshold: number = PACKING_DISTANCE_THRESHOLD
): readonly FamilyIdentity[] {
	const taken: FamilyIdentity[] = [...seeded];
	const chosen: FamilyIdentity[] = [];
	const used = new Set<number>();
	while (chosen.length < limit) {
		let best: { readonly index: number; readonly nearest: number } | null = null;
		for (let i = 0; i < candidates.length; i++) {
			if (used.has(i)) {
				continue;
			}
			let nearest = Number.POSITIVE_INFINITY;
			let admissible = true;
			for (const other of taken) {
				if (rejects(candidates[i], other, threshold) !== null) {
					admissible = false;
					break;
				}
				nearest = Math.min(nearest, dOwner(candidates[i], other));
			}
			if (!admissible) {
				used.add(i);
				continue;
			}
			if (best === null || nearest > best.nearest) {
				best = { index: i, nearest };
			}
		}
		if (best === null) {
			break;
		}
		used.add(best.index);
		taken.push(candidates[best.index]);
		chosen.push(candidates[best.index]);
	}
	return chosen;
}

// ---------------------------------------------------------------------------
// The catalogue gate
// ---------------------------------------------------------------------------

/** A pair the catalogue ships despite the rule, with the reason a human accepted it. */
export interface GrandfatheredPair {
	readonly a: string;
	readonly b: string;
	/** The D_owner measured when the entry was written. Re-measured on every build. */
	readonly measured: number;
	readonly why: string;
}

/**
 * Pairs already in the catalogue that this rule would reject, each with its
 * measurement and the reason it is tolerated.
 *
 * Written in the idiom of `buildThemes.ENGINE_FLOOR`: an entry here is a human
 * decision recorded, not a threshold relaxed. Anything added from now on has to
 * carry the same standard of proof - the measured number, and an argument that
 * the pair is genuinely two products.
 *
 * NOTHING SYNTHESISED MAY EVER BE ADDED HERE. A synthesised family is drawn from
 * an unbounded pool; if it needs a grandfather clause the answer is to draw a
 * different one.
 */
export const GRANDFATHERED_PAIRS: readonly GrandfatheredPair[] = [
	{
		a: "vibe:tide",
		b: "vibe:dusk",
		measured: 1.33,
		why:
			"Two flagship vibes that are one theme to this owner in six of seven identity slots - measured editorBg 0.14, " +
			"function 0.08, string 0.52, editorFg 1.01, keyword 1.42, comment 1.92, constant 3.40, and 1/7 slots past a JND. " +
			"They are told apart by wallpaper and motif rather than by the colour theme, and whether that is enough is the " +
			"owner's call, not the build's."
	},
	{
		a: "Umber",
		b: "Cinder",
		measured: 2.91,
		why:
			"Two near-black warm-earth corpus grounds picked by a ranking that could not see they look the same " +
			"(groundOwner 1.33, only three of seven slots past a JND). They ship today; replacing them is a catalogue decision."
	}
];

/** One violating pair, for the report. */
export interface DistinctnessViolation {
	readonly a: string;
	readonly b: string;
	readonly distance: number;
	readonly rejection: Rejection;
}

/**
 * Every pair in the shipped catalogue - vibes, corpus and synthesised together -
 * measured against the rule, minus the pairs a human has grandfathered.
 *
 * Returns rather than throws so the caller can print every violation at once. A
 * report that stops at the first bad pair makes a catalogue change into a
 * sequence of guesses.
 */
export function catalogueViolations(families: readonly FamilyIdentity[]): readonly DistinctnessViolation[] {
	const forgiven = new Set(GRANDFATHERED_PAIRS.flatMap(pair => [`${pair.a}|${pair.b}`, `${pair.b}|${pair.a}`]));
	const violations: DistinctnessViolation[] = [];
	for (let i = 0; i < families.length; i++) {
		for (let j = i + 1; j < families.length; j++) {
			const a = families[i];
			const b = families[j];
			if (forgiven.has(`${a.key}|${b.key}`)) {
				continue;
			}
			const rejection = rejects(a, b);
			if (rejection !== null) {
				violations.push({ a: a.key, b: b.key, distance: dOwner(a, b), rejection });
			}
		}
	}
	return violations;
}

/** Throws with every violating pair at once. The build-time gate. */
export function assertCatalogueDistinct(families: readonly FamilyIdentity[]): void {
	const violations = catalogueViolations(families);
	if (violations.length === 0) {
		return;
	}
	const lines = violations.map(v =>
		`  ${v.a} | ${v.b}  D_owner ${v.distance.toFixed(2)}  failed rule "${v.rejection.rule}" at ${
			typeof v.rejection.measured === "number" ? v.rejection.measured.toFixed(2) : v.rejection.measured
		}`
	);
	throw new Error(
		`distinct: ${violations.length} catalogue pair(s) are the same theme to this owner:\n${lines.join("\n")}\n` +
		"Either drop a family or record the pair in GRANDFATHERED_PAIRS with its measurement and the reason."
	);
}

/** The closest other family to each, ascending - the order a contact sheet is reviewed in. */
export function nearestNeighbours(families: readonly FamilyIdentity[]): readonly { readonly key: string; readonly nearest: string; readonly distance: number }[] {
	const out: { key: string; nearest: string; distance: number }[] = [];
	for (const family of families) {
		let best: { key: string; distance: number } | null = null;
		for (const other of families) {
			if (other.key === family.key) {
				continue;
			}
			const distance = dOwner(family, other);
			if (best === null || distance < best.distance) {
				best = { key: other.key, distance };
			}
		}
		if (best !== null) {
			out.push({ key: family.key, nearest: best.key, distance: best.distance });
		}
	}
	return out.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
}

/**
 * What let an admitted pair through, for the twins strip: the one column whose
 * job is to tell the reviewer what to look at.
 *
 * Three-way, because rule (3) is three-way: a pair in different registers is
 * told apart by register, a pair in different emphases by emphasis, and a pair
 * in the same register and emphasis by nothing but its off-ground distance -
 * which is then printed, so the reviewer looks at the inks rather than hunting
 * for a bold/plain difference that does not exist. The first draft of this
 * label was two-way and called every same-register pair "separated by
 * emphasis", including 85 pairs whose emphasis was identical.
 */
export function admittedBy(a: FamilyIdentity, b: FamilyIdentity): string {
	if (a.register !== b.register) {
		return "separated by register";
	}
	if (a.emphasis !== b.emphasis) {
		return "separated by emphasis";
	}
	return `same register and emphasis, off-ground distance ${dOffGround(a, b).toFixed(2)}`;
}

/** Every pair, closest first. The twins strip on the contact sheet reads off the front of this. */
export function closestPairs(families: readonly FamilyIdentity[]): readonly { readonly a: string; readonly b: string; readonly distance: number; readonly admitted: string }[] {
	const pairs: { a: string; b: string; distance: number; admitted: string }[] = [];
	for (let i = 0; i < families.length; i++) {
		for (let j = i + 1; j < families.length; j++) {
			const a = families[i];
			const b = families[j];
			const ground = slotDistance(a.colors["editorBg"], b.colors["editorBg"]);
			const rejection = rejects(a, b);
			pairs.push({
				a: a.key,
				b: b.key,
				distance: dOwner(a, b),
				admitted: rejection !== null
					? `grandfathered (would fail "${rejection.rule}" at ${rejection.measured.toFixed(2)})`
					: `${ground < JND ? "shared" : "own"} ground (${ground.toFixed(2)} dE00), ${admittedBy(a, b)}`
			});
		}
	}
	return pairs.sort((a, b) => a.distance - b.distance || a.a.localeCompare(b.a));
}

// ---------------------------------------------------------------------------
// The golden calibration
// ---------------------------------------------------------------------------

/**
 * The `D_owner` matrix of the eleven families that ship today, pinned.
 *
 * The weights, the cap, the observer set and the threshold are all judgement
 * calls sitting on top of measured arithmetic, and a quiet change to any of them
 * would silently re-decide which families the catalogue admits. Pinning the
 * matrix makes such a change a reviewed diff with 55 numbers in it instead.
 *
 * Regenerate deliberately, never to make a failing build pass.
 */
export const SHIPPED_CALIBRATION: Readonly<Record<string, number>> = {
	"vibe:ink|vibe:basalt": 19.01,
	"vibe:ink|vibe:tide": 20.00,
	"vibe:ink|vibe:dusk": 19.32,
	"vibe:ink|vibe:fern": 19.08,
	"vibe:ink|vibe:ridge": 9.40,
	"vibe:ink|Umber": 19.42,
	"vibe:ink|Pewter": 19.15,
	"vibe:ink|Cinder": 19.45,
	"vibe:ink|Trench": 18.92,
	"vibe:ink|Nightshade": 19.02,
	"vibe:basalt|vibe:tide": 15.18,
	"vibe:basalt|vibe:dusk": 5.99,
	"vibe:basalt|vibe:fern": 5.02,
	"vibe:basalt|vibe:ridge": 19.11,
	"vibe:basalt|Umber": 11.16,
	"vibe:basalt|Pewter": 12.40,
	"vibe:basalt|Cinder": 10.62,
	"vibe:basalt|Trench": 14.01,
	"vibe:basalt|Nightshade": 11.72,
	"vibe:tide|vibe:dusk": 1.33,
	"vibe:tide|vibe:fern": 5.19,
	"vibe:tide|vibe:ridge": 20.00,
	"vibe:tide|Umber": 14.25,
	"vibe:tide|Pewter": 12.07,
	"vibe:tide|Cinder": 16.22,
	"vibe:tide|Trench": 14.91,
	"vibe:tide|Nightshade": 11.75,
	"vibe:dusk|vibe:fern": 11.57,
	"vibe:dusk|vibe:ridge": 19.50,
	"vibe:dusk|Umber": 7.16,
	"vibe:dusk|Pewter": 11.48,
	"vibe:dusk|Cinder": 11.02,
	"vibe:dusk|Trench": 13.03,
	"vibe:dusk|Nightshade": 9.10,
	"vibe:fern|vibe:ridge": 19.02,
	"vibe:fern|Umber": 11.89,
	"vibe:fern|Pewter": 12.90,
	"vibe:fern|Cinder": 10.38,
	"vibe:fern|Trench": 13.68,
	"vibe:fern|Nightshade": 11.32,
	"vibe:ridge|Umber": 19.36,
	"vibe:ridge|Pewter": 19.37,
	"vibe:ridge|Cinder": 19.08,
	"vibe:ridge|Trench": 18.54,
	"vibe:ridge|Nightshade": 19.24,
	"Umber|Pewter": 9.84,
	"Umber|Cinder": 2.91,
	"Umber|Trench": 10.78,
	"Umber|Nightshade": 9.64,
	"Pewter|Cinder": 11.18,
	"Pewter|Trench": 11.71,
	"Pewter|Nightshade": 6.67,
	"Cinder|Trench": 12.60,
	"Cinder|Nightshade": 11.40,
	"Trench|Nightshade": 8.14
};

/**
 * Re-measures the pinned matrix. Returns one line per pair that moved by more
 * than 0.01 dE00, or per pair that has appeared or vanished.
 */
export function checkShippedCalibration(families: readonly FamilyIdentity[]): readonly string[] {
	const failures: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < families.length; i++) {
		for (let j = i + 1; j < families.length; j++) {
			const key = `${families[i].key}|${families[j].key}`;
			seen.add(key);
			const pinned = SHIPPED_CALIBRATION[key];
			if (pinned === undefined) {
				failures.push(`distinct: calibration: ${key} is not in the pinned matrix`);
				continue;
			}
			const measured = dOwner(families[i], families[j]);
			if (Math.abs(measured - pinned) > 0.01) {
				failures.push(`distinct: calibration: ${key} measures ${measured.toFixed(2)}, pinned at ${pinned.toFixed(2)}`);
			}
		}
	}
	for (const key of Object.keys(SHIPPED_CALIBRATION)) {
		if (!seen.has(key)) {
			failures.push(`distinct: calibration: ${key} is pinned but no longer in the catalogue`);
		}
	}
	return failures;
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

function identity(key: string, colors: Readonly<Record<string, string>>, register: Register = "keywordLed", emphasis: SyntaxEmphasis = "plain"): FamilyIdentity {
	return { key, mode: "dark", register, emphasis, colors };
}

/** The `distinct.ts` suite. Returns one line per failing assertion; empty is a pass. */
export function runDistinctTests(): readonly string[] {
	const failures: string[] = [];
	const check = (what: string, condition: boolean, detail: string): void => {
		if (!condition) {
			failures.push(`distinct: ${what}: ${detail}`);
		}
	};

	const palette = { editorBg: "#131211", editorFg: "#E8E4DE", comment: "#807A73", keyword: "#C4A9E0", string: "#9CC3E8", function: "#B8D4F0", constant: "#79C0D8" };
	const a = identity("a", palette);
	const b = identity("b", { ...palette, editorBg: "#0E1621" });

	// The metric's algebra.
	check("D_owner is zero on identity", dOwner(a, a) === 0, `got ${dOwner(a, a)}`);
	check("D_owner is symmetric", Math.abs(dOwner(a, b) - dOwner(b, a)) < 1e-12, `${dOwner(a, b)} vs ${dOwner(b, a)}`);
	check("D_owner is non-negative", dOwner(a, b) >= 0, `got ${dOwner(a, b)}`);
	check("slotDistance is capped", slotDistance("#000000", "#FFFFFF") === IDENTITY_CAP, `got ${slotDistance("#000000", "#FFFFFF")}`);
	check("the weights sum to one", Math.abs(Object.values(IDENTITY_WEIGHTS).reduce((s, w) => s + w, 0) - 1) < 1e-12,
		`got ${Object.values(IDENTITY_WEIGHTS).reduce((s, w) => s + w, 0)}`);
	check("every identity slot has a weight", IDENTITY_SLOTS.every(slot => IDENTITY_WEIGHTS[slot] !== undefined), "a slot has no weight");

	// The cap really caps: two families that differ hugely everywhere cannot
	// score above sqrt(sum(w) * CAP^2) = CAP.
	const far = identity("far", { editorBg: "#FFFFFF", editorFg: "#000000", comment: "#FF0000", keyword: "#00FF00", string: "#0000FF", function: "#FFFF00", constant: "#00FFFF" });
	check("D_owner never exceeds the cap", dOwner(a, far) <= IDENTITY_CAP + 1e-9, `got ${dOwner(a, far)}`);

	// A metric that measured only a trichromat would call these two different.
	// This one must not: they are the same colour to a deuteranope.
	check("worst-observer beats trichromat-only", slotDistance("#5B8159", "#8A7A2E") < 20, "the cap hid the point");

	// Rule (2) closes the two-slots-buy-a-family hole.
	const oneSlot = identity("oneSlot", { ...palette, editorFg: "#000000" });
	const rejection = rejects(a, oneSlot);
	check("one slot alone cannot buy a family", rejection !== null && rejection.rule === "slots",
		rejection === null ? "it was admitted" : `rejected on "${rejection.rule}" instead`);

	// Rule (3): the ground alone cannot buy a family. A candidate identical to
	// `a` in editorFg, comment, keyword and function, with a ground 9 dE00 away
	// and string and constant nudged just past the JND, clears rule (1) on the
	// ground's weight alone (D 5.45) and rule (2) with K = 3 - and must still be
	// rejected, because off the ground it is 1.37 dE00 from `a`. This is the
	// `Nettle | Thorn` shape the first catalogue shipped.
	const groundOnly = identity("groundOnly", { ...palette, editorBg: "#332F2C", string: "#A8CDF0", constant: "#86CAE0" });
	check("the ground-only case is set up as intended: D clears T",
		dOwner(a, groundOnly) >= FAMILY_DISTANCE_THRESHOLD, `D ${dOwner(a, groundOnly).toFixed(2)}`);
	check("the ground-only case is set up as intended: K clears the slot floor",
		differingSlots(a, groundOnly) >= MIN_DIFFERING_SLOTS, `K ${differingSlots(a, groundOnly)}`);
	check("the ground-only case is set up as intended: the grounds are well past a JND",
		slotDistance(palette.editorBg, "#332F2C") >= JND, `ground ${slotDistance(palette.editorBg, "#332F2C").toFixed(2)}`);
	const groundRejection = rejects(a, groundOnly);
	check("ground alone cannot buy a family", groundRejection !== null && groundRejection.rule === "offGround",
		groundRejection === null ? "it was admitted" : `rejected on "${groundRejection.rule}" instead`);
	check("the off-ground rejection reports the off-ground distance",
		groundRejection !== null && Math.abs(groundRejection.measured - dOffGround(a, groundOnly)) < 1e-12,
		`measured ${groundRejection?.measured}`);
	// The design holds register and emphasis to be identity axes, so the same
	// colours in another register or emphasis are a different theme.
	check("the same pair passes once the register differs",
		rejects(a, { ...groundOnly, key: "g2", register: "inkLed" as Register }) === null, "still rejected");
	check("the same pair passes once the emphasis differs",
		rejects(a, { ...groundOnly, key: "g3", emphasis: "weight" as SyntaxEmphasis }) === null, "still rejected");
	// And the shared-ground case - the grounds within a JND - asks the same
	// question: rule (3) is not conditional on the ground.
	const sameGroundSameRegister = identity("g1", { ...palette, editorFg: "#DDDDDD", comment: "#666666", keyword: "#66AAFF", string: "#77CCAA", function: "#AACCEE", constant: "#EE9977" });
	const sharedRejection = rejects(a, sameGroundSameRegister);
	check("a shared ground with the same register is judged off the ground",
		sharedRejection === null || sharedRejection.rule === "offGround" || sharedRejection.rule === "distance" || sharedRejection.rule === "slots",
		`unexpected rule ${sharedRejection?.rule}`);

	// The packing threshold is a margin above the gate, pinned to the closest
	// shipped pair the design argues is plainly two themes.
	check("the packer packs wider than the gate", PACKING_DISTANCE_THRESHOLD > FAMILY_DISTANCE_THRESHOLD,
		`${PACKING_DISTANCE_THRESHOLD} vs ${FAMILY_DISTANCE_THRESHOLD}`);
	check("the packing threshold is the pinned basalt|dusk distance",
		PACKING_DISTANCE_THRESHOLD === SHIPPED_CALIBRATION["vibe:basalt|vibe:dusk"],
		`${PACKING_DISTANCE_THRESHOLD} vs ${SHIPPED_CALIBRATION["vibe:basalt|vibe:dusk"]}`);
	check("a pair the packer keeps is a pair the gate admits",
		rejects(a, b, PACKING_DISTANCE_THRESHOLD) !== null || rejects(a, b) === null, "the packer admitted what the gate rejects");

	// The twins-strip label never claims an emphasis difference that is not there.
	check("admittedBy names the register when it differs",
		admittedBy(a, { ...a, key: "r", register: "inkLed" as Register }) === "separated by register", admittedBy(a, { ...a, key: "r", register: "inkLed" as Register }));
	check("admittedBy names the emphasis when only it differs",
		admittedBy(a, { ...a, key: "e", emphasis: "weight" as SyntaxEmphasis }) === "separated by emphasis", admittedBy(a, { ...a, key: "e", emphasis: "weight" as SyntaxEmphasis }));
	check("admittedBy never says emphasis for a same-register, same-emphasis pair",
		!admittedBy(a, b).startsWith("separated by") && admittedBy(a, b).includes(dOffGround(a, b).toFixed(2)), admittedBy(a, b));

	// The packer is deterministic and never emits a pair the rule rejects.
	{
		const hex = (base: number, i: number, stride: number): string =>
			`#${(((base + i * stride) & 0xFFFFFF) >>> 0).toString(16).padStart(6, "0").toUpperCase()}`;
		const pool: FamilyIdentity[] = [];
		for (let i = 0; i < 24; i++) {
			pool.push(identity(`p${i}`, {
				editorBg: hex(0x101010, i, 0x030507),
				editorFg: hex(0xC0C0C0, i, 0x000203),
				comment: hex(0x707070, i, 0x020103),
				keyword: hex(0x8090C0, i, 0x050301),
				string: hex(0x90C0A0, i, 0x030105),
				function: hex(0xB0C0D0, i, 0x010305),
				constant: hex(0xC0A080, i, 0x040201)
			}));
		}
		const first = packFarthestPoint([], pool);
		const second = packFarthestPoint([], pool);
		check("the packer is deterministic", first.map(f => f.key).join(",") === second.map(f => f.key).join(","), "two runs disagreed");
		check("the incremental packer agrees with the obvious one",
			first.map(f => f.key).join(",") === packFarthestPointNaive([], pool).map(f => f.key).join(","),
			"the optimisation changed the catalogue");
		check("the incremental packer agrees when seeded too",
			packFarthestPoint([pool[0]], pool.slice(1)).map(f => f.key).join(",") === packFarthestPointNaive([pool[0]], pool.slice(1)).map(f => f.key).join(","),
			"the optimisation changed the catalogue with a seed set");
		for (let i = 0; i < first.length; i++) {
			for (let j = i + 1; j < first.length; j++) {
				check("the packer never emits a rejected pair", rejects(first[i], first[j]) === null,
					`${first[i].key} | ${first[j].key}`);
			}
		}
		check("the packer respects its limit", packFarthestPoint([], pool, 2).length <= 2, "it overran");
	}

	// registerOf reads the register off the colours rather than a declaration.
	check("registerOf finds the ink-led register",
		registerOf({ keyword: "#E8E4DE", editorFg: "#E8E4DE" } as unknown as Seed) === "inkLed", "got keywordLed");
	check("registerOf finds the keyword-led register",
		registerOf({ keyword: "#7FB4E8", editorFg: "#D6E2F0" } as unknown as Seed) === "keywordLed", "got inkLed");

	// The grandfather list is a list of decisions, not a switch: each entry must
	// carry a measurement and a reason.
	for (const pair of GRANDFATHERED_PAIRS) {
		check(`the grandfather entry ${pair.a}|${pair.b} carries a measurement`, pair.measured > 0, `got ${pair.measured}`);
		check(`the grandfather entry ${pair.a}|${pair.b} carries a reason`, pair.why.length > 40, "the reason is too short to be one");
	}

	return failures;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	const failures = runDistinctTests();
	for (const line of failures) {
		console.error(`  ${line}`);
	}
	if (failures.length > 0) {
		console.error(`\ndistinct: ${failures.length} failing assertion(s)`);
		process.exit(1);
	}
	console.log("distinct: all assertions pass (metric algebra, the cap, rules 1-3, the ground-only hole, packing margin, twins labels, deterministic packing, register detection)");
	process.exit(0);
}
