#!/usr/bin/env node --experimental-strip-types
/**
 * The one lightness solver, used by both the ANSI ramp and the syntax palette.
 *
 * WHY A SOLVER RATHER THAN A REPAIR
 *
 * `importPalette.separateFrom` pushes a bright ANSI slot away from its normal
 * sibling until a trichromat can tell the two apart. That covers 8 of the 120
 * pairs `validateTheme` actually measures, which is why 181 corpus schemes are
 * rejected downstream for collisions nothing upstream was looking for. A
 * generator that OWNS all sixteen slots has no excuse for that: it can place
 * every slot against every slot already placed, with the gate's own function, on
 * the emitted hex, so the generator and the gate compute the identical number
 * and there is nothing left for a tolerance to cover.
 *
 * WHY IT ONLY EVER MOVES LIGHTNESS
 *
 * `vibe-tokens.json`'s `$ansiRampIsSeparated` records the rule the house already
 * applied to its own ramps by hand: hue held, chroma held or raised but never
 * cut, only OKLab L moves. A separation bought by rotating a hue would be a
 * separation the owner cannot see - and it would stop SGR 31 being red. So C and
 * h are constants of the search and L is the only variable, in both directions
 * this file is asked to search.
 *
 * WHY EACH SLOT STARTS AT ITS OWN CONTRAST FRONTIER
 *
 * Readability is then a property of the construction rather than of a rejection
 * sample: a slot cannot be placed nearer the plane than the lightness at which
 * it clears its contrast floor, and the walk only ever moves further away, so
 * every placed slot clears the floor by construction and the validator is
 * confirming rather than deciding.
 *
 *   node --experimental-strip-types primal/theme/synth/ramp.ts --self-test
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { effectiveContrast, hexToOklch, lightness, maxChroma, oklchToHex } from "../color.ts";
import { MAX_GAMUT_FRACTION } from "../generateTheme.ts";
import type { ThemeMode } from "../tokenMap.ts";
import { perceptualDistanceOfHex } from "../validateTheme.ts";
import { err, ok, type Result } from "./spec.ts";

/** How many OKLab L a placement walk moves per step. `generateTheme.LADDER_SEARCH_STEP`, deliberately the same. */
export const RAMP_STEP = 0.0015;

/**
 * The most steps a single slot may walk before the ramp is declared infeasible.
 *
 * 0.0015 x 700 is 1.05 in OKLab L, which is more than the whole axis, so this
 * bound is never the thing that decides an outcome - it exists so that a walk
 * cannot run forever on a plane where the gamut has quietly stopped moving.
 */
export const RAMP_LIMIT = 700;

/** +1 when a foreground gains contrast by lightening (a dark plane), -1 otherwise. */
export function outward(mode: ThemeMode): number {
	return mode === "dark" ? 1 : -1;
}

/**
 * A colour at `{C, h}` and lightness `L`, held back from the gamut wall by
 * `MAX_GAMUT_FRACTION` exactly as `generateTheme` places a semantic colour.
 *
 * One function, so the contrast search and the emitted value cannot disagree
 * about what colour a lightness produces.
 */
export function placeAt(C: number, h: number, L: number): string {
	const clamped = Math.min(1, Math.max(0, L));
	return oklchToHex({ L: clamped, C: Math.min(C, MAX_GAMUT_FRACTION * maxChroma(clamped, h)), h });
}

/**
 * The lightness closest to `bgHex` at which `{C, h}` still clears `minRatio`,
 * or `null` when no lightness in the mode's direction reaches it.
 *
 * Returns rather than throws, because "this hue cannot be read on this plane" is
 * an ordinary answer for a synthesiser exploring a box, not an exception.
 * Bisection with a fixed iteration count: deterministic by construction.
 */
export function contrastFrontier(C: number, h: number, bgHex: string, minRatio: number, mode: ThemeMode): number | null {
	const limit = mode === "dark" ? 1 : 0;
	if (effectiveContrast(placeAt(C, h, limit), bgHex) < minRatio) {
		return null;
	}
	let fail = lightness(bgHex);
	let pass = limit;
	for (let i = 0; i < 24; i++) {
		const mid = (fail + pass) / 2;
		if (effectiveContrast(placeAt(C, h, mid), bgHex) >= minRatio) {
			pass = mid;
		} else {
			fail = mid;
		}
	}
	return pass;
}

/**
 * The lightness at which `{C, h}` delivers `targetRatio` against `bgHex`, moving
 * away from the plane. `null` when the target is out of reach at that hue.
 *
 * This is `contrastFrontier` with the floor raised to the target, and it is what
 * places every syntax ink: a role is not "the plane's colour lightened a bit",
 * it is the colour at the lightness where it delivers the contrast its role
 * asked for. Same bisection, same determinism.
 */
export function solveContrast(C: number, h: number, bgHex: string, targetRatio: number, mode: ThemeMode): number | null {
	return contrastFrontier(C, h, bgHex, targetRatio, mode);
}

/** One slot the joint solver has to place: a fixed chroma and hue, a free lightness. */
export interface RampSlot {
	/** The slot id, for the report and for the infeasibility message. */
	readonly id: string;
	readonly C: number;
	readonly h: number;
}

/** Where a slot ended up, and what it cost to get there. */
export interface RampPlacement {
	readonly id: string;
	readonly hex: string;
	readonly L: number;
	/** The chroma the slot asked for. */
	readonly requestedC: number;
	/** The chroma it kept once the gamut had its say. Below 67% is a taste failure; see synthesise.ts. */
	readonly realisedC: number;
	/** Contrast against the plane it was placed on. */
	readonly contrast: number;
}

/** What the joint solver was asked to do. */
export interface RampRequest {
	/** The plane every slot is measured against. For ANSI that is the panel plane, which IS terminal.background. */
	readonly backgroundHex: string;
	readonly mode: ThemeMode;
	/** Contrast floor every slot must clear against the plane. */
	readonly minContrast: number;
	/** dE00 every slot must keep from every slot already placed, under a trichromat. */
	readonly minSeparation: number;
	/** OKLab |dL| every slot must keep from the PREVIOUS slot, outward. Zero still forces a monotone ramp. */
	readonly minRungSpread: number;
}

/** Which slot ran out of lightness, and on which axis a repair should look. */
export interface RampInfeasible {
	readonly slot: string;
	/** `"contrast"` when the slot never reached its floor at all, `"separation"` when it reached it and then ran out of plane. */
	readonly reason: "contrast" | "separation";
}

/**
 * Places every slot in order, each at the first lightness - walking outward from
 * its own contrast frontier - that is far enough from every slot already placed.
 *
 * ORDER IS THE CONVENTION. The caller hands the slots in the order they must
 * appear along the lightness axis, and `minRungSpread` is enforced against the
 * PREVIOUS slot directionally, so the emitted ramp is monotone in L whatever the
 * individual frontiers do. That is what makes "ansiBlack is the darkest and
 * ansiBrightWhite the lightest" a construction rather than a hope, in both modes
 * - a light plane needs the whole order reversed, and reversing the list is the
 * only change it needs.
 *
 * Greedy from the plane outward, which for a fixed order is also optimal: a slot
 * placed any nearer would fail a pair, and placing it further only pushes
 * everything after it further still.
 */
export function solveRamp(slots: readonly RampSlot[], request: RampRequest): Result<readonly RampPlacement[], RampInfeasible> {
	const direction = outward(request.mode);
	const bound = request.mode === "dark" ? 1 : 0;
	const placed: RampPlacement[] = [];
	let previousL: number | null = null;

	for (const slot of slots) {
		const frontier = contrastFrontier(slot.C, slot.h, request.backgroundHex, request.minContrast, request.mode);
		if (frontier === null) {
			return err({ slot: slot.id, reason: "contrast" });
		}
		let startL = frontier;
		if (previousL !== null) {
			const gate = previousL + request.minRungSpread * direction;
			startL = direction > 0 ? Math.max(frontier, gate) : Math.min(frontier, gate);
		}

		let landed: RampPlacement | null = null;
		for (let step = 0; step <= RAMP_LIMIT; step++) {
			const L = startL + step * RAMP_STEP * direction;
			if (direction > 0 ? L > bound : L < bound) {
				break;
			}
			const hex = placeAt(slot.C, slot.h, L);
			let clear = true;
			for (const other of placed) {
				if (perceptualDistanceOfHex(hex, other.hex) < request.minSeparation) {
					clear = false;
					break;
				}
			}
			if (!clear) {
				continue;
			}
			landed = {
				id: slot.id,
				hex,
				L,
				requestedC: slot.C,
				realisedC: hexToOklch(hex).C,
				contrast: effectiveContrast(hex, request.backgroundHex)
			};
			break;
		}
		if (landed === null) {
			return err({ slot: slot.id, reason: "separation" });
		}
		placed.push(landed);
		previousL = landed.L;
	}
	return ok(placed);
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

/** The `ramp.ts` suite. Returns one line per failing assertion; empty is a pass. */
export function runRampTests(): readonly string[] {
	const failures: string[] = [];
	const check = (what: string, condition: boolean, detail: string): void => {
		if (!condition) {
			failures.push(`ramp: ${what}: ${detail}`);
		}
	};

	// placeAt never leaves the gamut and never invents a hue.
	for (const [C, h, L] of [[0.3, 29, 0.5], [0.2, 250, 0.85], [0.15, 153, 0.2]] as const) {
		const hex = placeAt(C, h, L);
		const back = hexToOklch(hex);
		check(`placeAt(${C}, ${h}, ${L}) holds its lightness`, Math.abs(back.L - L) < 0.01, `got L ${back.L.toFixed(4)}`);
		check(`placeAt(${C}, ${h}, ${L}) holds its hue`, Math.abs(((back.h - h + 540) % 360) - 180) < 4, `got h ${back.h.toFixed(1)}`);
		check(`placeAt(${C}, ${h}, ${L}) never exceeds what it asked for`, back.C <= C + 1e-6, `got C ${back.C.toFixed(4)}`);
	}

	// The frontier is the frontier: at it the floor holds, a hair inside it does not.
	for (const [bg, mode] of [["#131211", "dark"], ["#FAF9F6", "light"]] as const) {
		const L = contrastFrontier(0.05, 250, bg, 4.5, mode);
		check(`a frontier exists on ${bg}`, L !== null, "got null");
		if (L !== null) {
			check(`the frontier clears its floor on ${bg}`, effectiveContrast(placeAt(0.05, 250, L), bg) >= 4.5 - 1e-9,
				`got ${effectiveContrast(placeAt(0.05, 250, L), bg).toFixed(4)}:1`);
			const inside = L - 0.01 * outward(mode);
			check(`a hair inside the frontier fails on ${bg}`, effectiveContrast(placeAt(0.05, 250, inside), bg) < 4.5,
				`got ${effectiveContrast(placeAt(0.05, 250, inside), bg).toFixed(4)}:1`);
		}
	}

	// An unreachable floor is an answer, not an exception.
	check("an unreachable contrast returns null", contrastFrontier(0, 0, "#808080", 21, "dark") === null, "got a number");

	// solveContrast hits its target rather than merely clearing some floor.
	for (const target of [4.6, 7, 11]) {
		const L = solveContrast(0.04, 90, "#131211", target, "dark");
		check(`solveContrast reaches ${target}:1`, L !== null, "got null");
		if (L !== null) {
			const got = effectiveContrast(placeAt(0.04, 90, L), "#131211");
			check(`solveContrast lands ON ${target}:1`, Math.abs(got - target) < 0.05, `got ${got.toFixed(4)}:1`);
		}
	}

	// The joint solver: every pair separated, every slot legible, monotone in L.
	for (const [bg, mode] of [["#131211", "dark"], ["#FAF9F6", "light"]] as const) {
		const slots: RampSlot[] = [];
		for (let i = 0; i < 8; i++) {
			slots.push({ id: `s${i}`, C: 0.06, h: i * 45 });
		}
		const result = solveRamp(slots, { backgroundHex: bg, mode, minContrast: 3, minSeparation: 10, minRungSpread: 0 });
		check(`the joint solver places eight slots on ${bg}`, result.ok, result.ok ? "" : `infeasible at ${result.error.slot}`);
		if (result.ok) {
			const placed = result.value;
			for (let i = 0; i < placed.length; i++) {
				check(`slot ${i} clears the contrast floor on ${bg}`, placed[i].contrast >= 3 - 1e-9, `got ${placed[i].contrast.toFixed(3)}:1`);
				for (let j = i + 1; j < placed.length; j++) {
					const d = perceptualDistanceOfHex(placed[i].hex, placed[j].hex);
					check(`slots ${i}/${j} are separated on ${bg}`, d >= 10 - 1e-9, `got ${d.toFixed(3)} dE00`);
				}
			}
			const direction = outward(mode);
			for (let i = 1; i < placed.length; i++) {
				check(`the ramp is monotone outward on ${bg}`, (placed[i].L - placed[i - 1].L) * direction >= -1e-9,
					`slot ${i} at L ${placed[i].L.toFixed(4)} after ${placed[i - 1].L.toFixed(4)}`);
			}
		}
	}

	// minRungSpread is honoured, and honoured directionally.
	{
		const slots: RampSlot[] = [{ id: "a", C: 0.02, h: 90 }, { id: "b", C: 0.02, h: 90 }, { id: "c", C: 0.02, h: 90 }];
		const result = solveRamp(slots, { backgroundHex: "#131211", mode: "dark", minContrast: 3, minSeparation: 10, minRungSpread: 0.02 });
		check("a same-hue triple still solves", result.ok, result.ok ? "" : `infeasible at ${result.error.slot}`);
		if (result.ok) {
			for (let i = 1; i < result.value.length; i++) {
				check("the rung spread is honoured", result.value[i].L - result.value[i - 1].L >= 0.02 - 1e-9,
					`got dL ${(result.value[i].L - result.value[i - 1].L).toFixed(4)}`);
			}
		}
	}

	// Infeasibility names the slot, and the reason distinguishes "cannot read it"
	// from "read it fine, then ran out of plane".
	{
		const many: RampSlot[] = [];
		for (let i = 0; i < 40; i++) {
			many.push({ id: `n${i}`, C: 0, h: 0 });
		}
		const result = solveRamp(many, { backgroundHex: "#131211", mode: "dark", minContrast: 3, minSeparation: 10, minRungSpread: 0 });
		check("forty greys on one plane is infeasible", !result.ok, "the solver claimed to place them");
		if (!result.ok) {
			check("infeasibility names a slot", result.error.slot.startsWith("n"), `got ${result.error.slot}`);
			check("infeasibility names the separation axis", result.error.reason === "separation", `got ${result.error.reason}`);
		}
	}

	// Determinism: same request, byte-identical answer.
	{
		const slots: RampSlot[] = [{ id: "a", C: 0.08, h: 31 }, { id: "b", C: 0.08, h: 85 }, { id: "c", C: 0.08, h: 153 }];
		const request: RampRequest = { backgroundHex: "#1A1C20", mode: "dark", minContrast: 3, minSeparation: 10.05, minRungSpread: 0 };
		const first = solveRamp(slots, request);
		const second = solveRamp(slots, request);
		check("the solver is deterministic", JSON.stringify(first) === JSON.stringify(second), "two calls disagreed");
	}

	return failures;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	const failures = runRampTests();
	for (const line of failures) {
		console.error(`  ${line}`);
	}
	if (failures.length > 0) {
		console.error(`\nramp: ${failures.length} failing assertion(s)`);
		process.exit(1);
	}
	console.log("ramp: all assertions pass (gamut-held placement, contrast frontier, joint separation, monotone order, determinism)");
	process.exit(0);
}
