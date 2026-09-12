#!/usr/bin/env node --experimental-strip-types
/**
 * Turn the vendored palette corpus into shipping Primal themes.
 *
 * This is the end of the pipeline that primal/theme/ builds up:
 *
 *   corpus YAML -> importPalette.toSeed -> generateTheme.expandSeed -> validateTheme.validate
 *
 * and it is the file that decides what actually ships. It runs every one of the
 * 534 vendored schemes through that pipeline, scores the result, applies the
 * naming and licence rules, and writes:
 *
 *   extensions/theme-primal/themes/primal-<variant>-color-theme.json
 *   extensions/theme-primal/package.json        (contributes.themes)
 *   extensions/theme-primal/package.nls.json    (the labels those ids point at)
 *   primal/design/ATTRIBUTION.md                (generated, never hand-edited)
 *
 *   node --experimental-strip-types primal/theme/buildThemes.ts           # write
 *   node --experimental-strip-types primal/theme/buildThemes.ts --check   # verify, write nothing
 *   node --experimental-strip-types primal/theme/buildThemes.ts --survey  # corpus statistics
 *
 * `--check` regenerates everything in memory and compares it byte for byte with
 * what is on disk. It is the only thing that makes "generated" true rather than
 * aspirational: if someone hand-edits a generated theme, --check says so.
 *
 * WHAT "PASSES" MEANS, AND WHY IT IS NOT "ZERO ERRORS"
 *
 * Not one theme in this repository passes validateTheme.ts with zero errors -
 * not one generated theme, and not one of the six hand-authored shipping vibes
 * either. Eleven findings are produced by EVERY theme the engine can emit,
 * whatever palette goes in; they are properties of tokenMap.ts and of the gap
 * between generateTheme.ts's ladder and validateTheme.ts's threshold, not of
 * any palette. They are listed in ENGINE_FLOOR with the evidence.
 *
 * So the gate here is: zero errors that a different palette could have avoided.
 * Every tolerance is enumerated below, each one with the reason it is not
 * something a palette can fix, and `--survey` reports the strict number too so
 * the tolerances cannot quietly become the headline.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEPTH_STEPS,
	depthIsExpressible,
	liftedAnsiSlots,
	loadCorpus,
	realisedDepth,
	toSeed,
	type Depth,
	type Scheme
} from "./importPalette.ts";
import { expandSeed, serialiseTheme, themeFileName, type SemanticLadder, type Seed, type Surfaces } from "./generateTheme.ts";
import type { SyntaxEmphasis, ThemeMode } from "./tokenMap.ts";
import { perceptualDistanceOfHex, validate, type ColorTheme, type Finding } from "./validateTheme.ts";
import { renderContactSheet, sheetOrder, type SheetEntry } from "./synth/contactSheet.ts";
import {
	assertCatalogueDistinct,
	checkShippedCalibration,
	closestPairs,
	identityOf,
	nearestNeighbours,
	type FamilyIdentity
} from "./synth/distinct.ts";
import {
	FAMILIES_PATH,
	loadFamilyBook,
	loadNames,
	propose,
	repair,
	writeFamilyBook,
	runProposeTests,
	runPropertyTests
} from "./synth/propose.ts";
import { REPAIR_LADDER, runSynthesiseTests, synthesise } from "./synth/synthesise.ts";
import {
	buildSynthesised,
	isCatalogueError,
	loadFamilies as loadFamilyBookScreened,
	synthNlsKey,
	synthVariantId,
	synthVariantLabel,
	verifyLedger,
	type CatalogueError,
	type SynthBuilt
} from "./synth/producer.ts";
import { runSpecTests, type FamilySpec } from "./synth/spec.ts";
import { runRampTests } from "./synth/ramp.ts";
import { runGroundTests } from "./synth/ground.ts";
import { runDistinctTests } from "./synth/distinct.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const EXTENSION_DIR = join(REPO, "extensions", "theme-primal");
const THEMES_DIR = join(EXTENSION_DIR, "themes");
const ATTRIBUTION_PATH = join(REPO, "primal", "design", "ATTRIBUTION.md");
const CORPUS_DIR = join(REPO, "primal", "design", "corpus");
const CGMANIFEST_PATH = join(EXTENSION_DIR, "cgmanifest.json");
const VIBE_TOKENS_PATH = join(REPO, "primal", "design", "vibe-tokens.json");
const CONTACT_SHEET_PATH = join(REPO, "primal", "design", "contact-sheet.html");

// ---------------------------------------------------------------------------
// The naming and licence rules
// ---------------------------------------------------------------------------

/**
 * Substrings in a scheme's slug or name that keep it out of the catalogue
 * entirely, with the reason.
 *
 * MIT lets Primal copy sixteen hex values. It says nothing at all about a NAME,
 * and a name is the thing a trademark protects - so no theme ever ships under
 * its upstream name, and a scheme whose whole identity IS a mark does not ship
 * at all, renamed or not. A palette called "GitHub Dark" is a colour scheme
 * plus a claim about GitHub; strip the claim and there is nothing left that
 * anyone wanted.
 *
 * The second class is palettes lifted from a commercial theme product. The
 * corpus is MIT, but the upstream a scheme was "based on" may not be, and this
 * repository is not the right place to litigate that.
 */
interface Exclusion {
	readonly match: string;
	readonly why: string;
}

const FORBIDDEN_IDENTITIES: readonly Exclusion[] = [
	{ match: "github", why: "corporate mark (GitHub, Inc.)" },
	{ match: "material", why: "corporate/design-system mark (Google Material)" },
	{ match: "google", why: "corporate mark" },
	{ match: "windows", why: "corporate mark (Microsoft)" },
	{ match: "microsoft", why: "corporate mark" },
	{ match: "macintosh", why: "corporate mark (Apple)" },
	{ match: "apple", why: "corporate mark" },
	{ match: "xcode", why: "corporate product mark (Apple)" },
	{ match: "ibm", why: "corporate mark" },
	{ match: "firefox", why: "corporate mark (Mozilla)" },
	{ match: "chrome", why: "corporate mark (Google)" },
	{ match: "atelier", why: "third-party scheme-family mark" },
	{ match: "framer", why: "corporate mark (Framer B.V.)" },
	{ match: "elementary", why: "corporate mark (elementary, Inc.)" },
	{ match: "ubuntu", why: "corporate mark (Canonical)" },
	{ match: "spotify", why: "corporate mark" },
	{ match: "slack", why: "corporate mark" },
	{ match: "twitter", why: "corporate mark" },
	{ match: "jetbrains", why: "corporate mark" },
	{ match: "darcula", why: "corporate product mark (JetBrains)" },
	{ match: "vscode", why: "corporate product mark (Microsoft)" },
	{ match: "atom", why: "corporate product mark (GitHub)" },
	{ match: "primer", why: "corporate design-system mark (GitHub)" },
	{ match: "oxocarbon", why: "corporate design-system mark (IBM Carbon)" },
	{ match: "nintendo", why: "franchise mark" },
	{ match: "pokemon", why: "franchise mark" },
	{ match: "atari", why: "franchise mark" },
	{ match: "spiderman", why: "franchise mark (Marvel)" },
	{ match: "marvel", why: "franchise mark" },
	{ match: "disney", why: "franchise mark" },
	{ match: "star-wars", why: "franchise mark" },
	{ match: "ia-dark", why: "corporate product mark (iA Writer)" },
	{ match: "ia-light", why: "corporate product mark (iA Writer)" },
	{ match: "one-half", why: "established theme brand (Atom One Half)" },
	{ match: "dracula", why: "established theme brand with its own trademark posture" },
	{ match: "monokai", why: "commercial theme product (Monokai Pro)" },
	{ match: "shades-of-purple", why: "commercial theme product" },
	{ match: "synthwave", why: "commercial theme product (SynthWave '84)" },
	{ match: "horizon", why: "commercial theme product" },
	{ match: "hardhacker", why: "ported from a third-party theme product" },
	{ match: "tokyo-night", why: "established theme brand" },
	{ match: "catppuccin", why: "established theme brand" },
	{ match: "nord", why: "established theme brand" },
	{ match: "gruvbox", why: "established theme brand" },
	{ match: "solarized", why: "established theme brand" },
	{ match: "everforest", why: "established theme brand" },
	{ match: "rose-pine", why: "established theme brand" },
	{ match: "kanagawa", why: "established theme brand" },
	{ match: "ayu", why: "established theme brand" },
	{ match: "onedark", why: "established theme brand (Atom One)" },
	{ match: "one-light", why: "established theme brand (Atom One)" }
];

/** Why a scheme was set aside, if it was. Null means it is a candidate. */
function excludedBecause(scheme: Scheme): string | null {
	if (scheme.author.trim() === "") return "no author to attribute (the scheme's `author` field is empty)";
	const haystack = `${scheme.slug} ${scheme.name}`.toLowerCase();
	for (const rule of FORBIDDEN_IDENTITIES) {
		if (haystack.includes(rule.match)) return `${rule.why} - matched "${rule.match}"`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The engine floor: findings no palette can avoid
// ---------------------------------------------------------------------------

/**
 * `<check> | <token>` for every finding that appears in EVERY generatable theme,
 * hand-authored and corpus alike - a defect in the engine rather than in a
 * palette, which no seed can make appear or go away.
 *
 * IT IS EMPTY, and it is worth recording what used to be in it, because both
 * entries were engine defects that this set made comfortable to live with:
 *
 *   gitDecoration.addedResourceForeground vs gitDecoration.untrackedResourceForeground
 *     dE00 0.00, always: tokenMap.ts routed both tokens to the SAME semantic
 *     slot ("added"). Two states the explorer shows side by side were one
 *     colour. `untracked` is now its own role with its own hue.
 *
 *   diffEditor.insertedLineBackground vs diffEditor.removedLineBackground
 *     Two washes at 1A alpha over the same plane. Flattened they were both a
 *     hair off the background, and the reachable maximum over a light plane at
 *     that alpha is 5.3 dE00 whatever hues you choose - so this was never a
 *     palette problem either. generateTheme.ts now solves the wash pair in
 *     COMPOSITED space and derives the alpha the separation needs.
 *
 * Anything added here from now on has to carry the same standard of proof: a
 * measurement showing every palette produces it, and an argument that the
 * engine genuinely cannot.
 */
const ENGINE_FLOOR: readonly string[] = [];

const ENGINE_FLOOR_SET: ReadonlySet<string> = new Set(ENGINE_FLOOR);

/**
 * How far apart two semantic roles must sit on the generator's ladder before a
 * separation failure between them counts against the palette.
 *
 * THE ANSWER IS NOW "NO DISTANCE, BECAUSE THERE ARE NO SUCH FAILURES", and the
 * history is worth keeping because it is a case study in a tolerance that hid a
 * defect for as long as it existed.
 *
 * generateTheme.ts used to separate the semantic roles by a fixed
 * SEMANTIC_LADDER_STEP of 0.06 in OKLab L, and assert that. validateTheme.ts
 * asks for 11 dE00 under the worst of four observers. Those were two different
 * numbers in two different colour spaces and they did not agree - one step
 * bought 6.2 to 6.5 CIELAB L*, and 11 dE00 from lightness alone needs 13.3 to
 * 14.9 L* where these colours sit, so EVERY adjacent pair failed the gate in
 * every palette. The validator said so, in its own warning output, on every
 * theme this file emitted:
 *
 *     [lightness separation (source control decorations)]
 *       gitDecoration.addedResourceForeground vs gitDecoration.deletedResourceForeground
 *       measured  dL* 4.7 at L* 70      threshold >= 14.1 L*
 *
 * The tolerance below forgave a one-step pair, and the ranking measured the
 * residual so the least-bad palettes shipped. That was an honest way to hold a
 * broken engine, but it was still holding a broken engine: 289 semantic
 * separation errors across the 21 shipped themes, 275 of them in the source
 * control decorations a colour-blind user reads all day.
 *
 * What closed it was not raising the step - four steps at 0.126 OKLab L is more
 * lightness than any real plane has above a contrast floor, so no value of a
 * fixed step works. It was deleting the fixed step. generateTheme.ts now places
 * each role at the first lightness that MEASURES far enough from the roles
 * already placed, using validateTheme's own CIEDE2000 and dichromacy model, and
 * splits the seven roles into the two ladders the gate's own groups show are
 * never compared with each other. Where hue survives a deficiency the step comes
 * out small; where it does not, the step comes out large; either way the
 * property is asserted on the bytes that ship rather than approximated by a
 * constant. So the tolerance has nothing left to forgive, and it is zero: every
 * semantic-separation error is blocking.
 */
const TOLERATED_LADDER_GAP = 0;

/** The tolerance the build used to apply. Only --survey passes it, to price what it hid. */
const LEGACY_LADDER_GAP = 1.0;

/** The rigorous reading, reported by --survey so the tolerance above stays visible. */
const STRICT_LADDER_GAP = 0.5;

/**
 * How far apart two shipped families' editor planes must be, in dE00.
 *
 * The ranking below scores a palette on the residual risk it carries, and nothing
 * in that score notices that two palettes look the same. Ranked alone it picks
 * five schemes off three backgrounds - three near-black warm browns within 2.9
 * dE00 of each other, and two schemes that state the identical `base00: "#2d2d2d"`
 * - which is two products presented as five.
 *
 * 4 dE00 is a little under twice the ordinary-viewing JND, so it is the point at
 * which two grounds are told apart at a glance rather than by being held side by
 * side. It is a floor on the BACKGROUND only: the plane is what a user sees before
 * a single character is drawn, and it is what makes one vibe a different place to
 * work rather than a recolouring of the last one.
 */
const MIN_FAMILY_PLANE_SEPARATION = 4;

/**
 * Walk a ranking and take a scheme only if its editor plane is not already taken.
 *
 * Deterministic and total: same ranking in, same catalogue out, so `--survey`
 * prints exactly what CATALOGUE below is supposed to contain and a reviewer can
 * diff the two by eye.
 */
function selectFamilies<T extends { readonly editorBg: string }>(ranked: readonly T[], wanted: number): readonly T[] {
	const taken: T[] = [];
	for (const candidate of ranked) {
		if (taken.length >= wanted) break;
		const clashes = taken.some(other => perceptualDistanceOfHex(candidate.editorBg, other.editorBg) < MIN_FAMILY_PLANE_SEPARATION);
		if (!clashes) taken.push(candidate);
	}
	return taken;
}

/** One theme, generated and judged. */
interface Built {
	readonly scheme: Scheme;
	readonly depth: Depth;
	readonly theme: ColorTheme;
	readonly ladder: SemanticLadder;
	/** Errors a different palette could have avoided. Empty means it may ship. */
	readonly blocking: readonly Finding[];
	/** Tolerated ANSI cross-slot collisions. Reported, never blocking. See below. */
	readonly ansiCollisions: number;
	/**
	 * The smallest dE00 among the semantic pairs TOLERATED_LADDER_GAP forgave.
	 * Infinity when it forgave none. This is the residual colour-blindness risk
	 * a shipped theme carries, and the catalogue ranks on it.
	 */
	readonly worstConfusableDeltaE: number;
	/** Errors matched by ENGINE_FLOOR, half-step pairs or wash pairs. */
	readonly tolerated: number;
	readonly warnings: readonly Finding[];
}

/**
 * The colour a finding's token names.
 *
 * validateTheme reports two kinds of token: a workbench colour id, and
 * `tokenColors "<scope>"` for a syntax scope. Both have to be resolvable, or a
 * syntax-scope finding would never match a ladder rung and would always look
 * like a palette failure.
 */
function colourOf(theme: ColorTheme, token: string): string | undefined {
	const scoped = /^tokenColors "(.+)"$/.exec(token);
	if (scoped !== null) {
		const wanted = scoped[1];
		for (const rule of theme.tokenColors ?? []) {
			const scopes = typeof rule.scope === "string" ? rule.scope.split(",").map(s => s.trim()) : (rule.scope ?? []);
			if (scopes.includes(wanted) && rule.settings?.foreground) return rule.settings.foreground;
		}
		return undefined;
	}
	return (theme.colors ?? {})[token];
}

/** Maps an emitted colour back to the ladder rung it came from, if any. */
function rungPosition(ladder: SemanticLadder, value: string | undefined): number | null {
	if (typeof value !== "string") return null;
	const base = value.slice(0, 7).toUpperCase();
	for (const rung of ladder.rungs) {
		if (rung.hex.toUpperCase() === base) return rung.position;
	}
	return null;
}

/**
 * Decide whether one finding is the palette's fault.
 *
 * The three tolerances, in order:
 *
 *  1. ENGINE_FLOOR - demonstrated above to be palette-independent.
 *  2. A semantic pair whose two colours are both semi-transparent washes over
 *     the same plane. Flattened they are both nearly the plane; the distance
 *     tokenMap's alphas allow is far below 11 dE00 whatever the palette.
 *  3. A semantic pair sitting within TOLERATED_LADDER_GAP on the generator's
 *     own ladder - read off the ladder this theme actually emitted, not from a
 *     hard-coded token list, so it tracks generateTheme.ts if the ladder moves.
 * There used to be a fourth: terminal.ansiBlack below the ANSI contrast floor in
 * a dark theme, waived because "ANSI black on a dark plane is dark by
 * definition" and because all four shipping dark vibes failed it too. Both
 * halves are gone. The vibes were excused by this rule and this rule by the
 * vibes, which is a circle, not an argument; and SGR 30 is a foreground code
 * like the other fifteen, so a program that used it printed text the user could
 * not read. importPalette now lifts all sixteen slots to the floor and
 * vibe-tokens.json states four black slots that clear it, so nothing needs the
 * waiver - and with it gone, a future palette whose black vanishes into its
 * plane blocks instead of shipping.
 *
 * `ansi ramp separation` is handled separately, AND SPLIT BY OBSERVER, which is
 * the whole of the argument for tolerating any of it:
 *
 *   - Under a dichromat observer it is counted, reported, never blocking.
 *     Sixteen ANSI colours cannot all be 11 dE00 apart to a dichromat - the
 *     gamut collapses to a plane - and VS Code's own default ANSI palette fails
 *     19 of its 120 pairs by the same measure. Blocking on it would reject the
 *     entire corpus and the editor's own defaults with it.
 *
 *   - Under the NORMAL observer it blocks, like anything else. The waiver used
 *     to be unconditional, and the gamut-collapse argument does not reach this
 *     case at all: two slots a trichromat cannot tell apart are not a fact
 *     about dichromacy, they are a broken ramp. It hid a real defect - four of
 *     the five shipped families had terminal.ansiYellow byte-identical to
 *     terminal.ansiBrightBlue (Cinder #337395, Nightshade #00A5FF, Umber
 *     #8AB7D9, Trench #0092FF), so SGR 33 and SGR 94 painted the same pixel and
 *     the theme's warning colour, whose hue generateTheme takes from ansiYellow,
 *     came out blue. importPalette now rejects such a palette outright, and
 *     this makes sure a future one cannot be waived back in.
 */
type Verdict = "blocking" | "tolerated" | "tolerated-ladder-gap" | "ansi-collision";

function classify(theme: ColorTheme, ladder: SemanticLadder, finding: Finding, gap: number): Verdict {
	const key = `${finding.check} | ${finding.token}`;
	if (ENGINE_FLOOR_SET.has(key)) return "tolerated";
	if (finding.check === "ansi ramp separation") return finding.observer === "normal" ? "blocking" : "ansi-collision";

	// A semantic-separation error used to be forgiven twice over: any pair of
	// semi-transparent washes, and any pair within one rung of the old fixed-step
	// ladder. Both tolerances are gone, and neither was closed by relaxing
	// anything - the generator now solves for the gate's own 11 dE00, washes
	// included, and asserts it on the emitted bytes. `gap` is kept only so
	// --survey can still report what the OLD reading would have forgiven.
	if (finding.check.startsWith("semantic separation") && gap >= LEGACY_LADDER_GAP) {
		const pa = rungPosition(ladder, colourOf(theme, finding.token.split(" vs ")[0]));
		const pb = rungPosition(ladder, colourOf(theme, finding.token.split(" vs ")[1]));
		if (pa !== null && pb !== null && Math.abs(pa - pb) <= gap) return "tolerated-ladder-gap";
	}
	return "blocking";
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

/** Build and judge one (scheme, depth). Throws only if the palette cannot carry a ladder. */
function build(scheme: Scheme, depth: Depth, name: string, gap: number = TOLERATED_LADDER_GAP): Built {
	const { theme, ladder } = expandSeed(
		toSeed(scheme, { depth }),
		{},
		{ name, mode: scheme.mode, syntaxEmphasis: "plain" }
	);
	const result = validate(theme as ColorTheme);
	const blocking: Finding[] = [];
	let ansiCollisions = 0;
	let tolerated = 0;
	let worstConfusableDeltaE = Number.POSITIVE_INFINITY;
	for (const finding of result.errors) {
		const verdict = classify(theme as ColorTheme, ladder, finding, gap);
		if (verdict === "blocking") { blocking.push(finding); continue; }
		if (verdict === "ansi-collision") { ansiCollisions++; continue; }
		tolerated++;
		if (verdict === "tolerated-ladder-gap") {
			const measured = /dE00 ([0-9.]+)/.exec(finding.measured);
			if (measured !== null) worstConfusableDeltaE = Math.min(worstConfusableDeltaE, Number(measured[1]));
		}
	}
	return { scheme, depth, theme: theme as ColorTheme, ladder, blocking, ansiCollisions, tolerated, worstConfusableDeltaE, warnings: result.warnings };
}

/** Depths a scheme can actually express, best first. See importPalette.DEPTH_OVERSHOOT_LIMIT. */
function expressibleDepths(scheme: Scheme): readonly Depth[] {
	return (["medium", "soft", "hard"] as const).filter(depth => depthIsExpressible(scheme, depth));
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * The five families that ship, and the original Primal name each one is given.
 *
 * Every name here is Primal's own. None is the upstream scheme's name, none
 * evokes it, and the source is recorded in ATTRIBUTION.md rather than in the
 * label a user reads. The register follows the six existing vibes - Ink,
 * Basalt, Tide, Dusk, Fern, Ridge: one concrete English noun, a material or a
 * place, never an adjective and never a mood.
 *
 * HOW THESE FIVE WERE CHOSEN, from 534 schemes. Every number is what
 * `--survey` prints today:
 *
 *   534  vendored
 *  -470  the palette cannot state sixteen distinct ANSI colours; importPalette
 *        refuses to derive a seed (see assertDistinctAnsi)
 *   -21  the palette has no room for the semantic ladders at all; generateTheme
 *        refuses to emit a theme
 *    43  generatable
 *   -29  at least one blocking error
 *    14  no blocking error
 *    -0  excluded by FORBIDDEN_IDENTITIES
 *    14  shippable
 *
 * THE FIRST LINE OF THAT TABLE MOVED FROM 193 TO 470, and the reason is worth
 * stating because it looks like a corpus that got worse. It did not: the check
 * got honest. `assertDistinctAnsi` used to compare hex STRINGS, so a scheme was
 * rejected only when two ANSI slots held the identical bytes; now it measures,
 * and rejects when two slots sit closer than ANSI_MIN_SEPARATION - the 10 dE00
 * this file has always declared and validateTheme has always enforced. 277
 * schemes that "stated sixteen distinct colours" state sixteen hex values a
 * trichromat cannot resolve into sixteen colours, which is the same defect one
 * decimal place further out. They were never shippable; they were only never
 * counted.
 *
 * Those 14 used to be ranked by `worstConfusableDeltaE` - the smallest colour
 * distance left between two semantic roles once TOLERATED_LADDER_GAP had
 * forgiven the one-step pairs. It was the residual colour-blindness risk a theme
 * carried, so it was the right thing to rank on. `selectFamilies` then walked
 * that ranking and took a scheme only if its editor plane was at least
 * MIN_FAMILY_PLANE_SEPARATION from every family already taken, because the
 * ranking cannot see that two palettes look the same: ranked alone it takes both
 * Equilibrium Dark and Equilibrium Gray Dark, which score identically.
 *
 * THAT RANKING KEY IS NOW DEGENERATE, and saying so is more useful than quietly
 * replacing it. The tolerance it measured is gone: no shippable theme has a
 * forgiven pair any more, so `worstConfusableDeltaE` reads "none" for all 14 and
 * orders nothing. `--survey` still marks five PICKED, but they are now whichever
 * five the plane-separation walk reaches first in corpus order, and they are no
 * longer the five below - Mezcal and Tomorrow Night Eighties are shippable but
 * are passed over for Equilibrium Gray Dark and Spaceduck, on a tie.
 *
 * The five below are therefore held by this constant rather than re-derived,
 * and every one of them is still in the shippable 14 - `buildCatalogue` throws
 * if that stops being true, which is the property that actually matters. What is
 * missing is a tie-break that discriminates now that the residual risk is zero
 * everywhere: plane separation and hue coverage are the obvious candidates, and
 * choosing one is a decision about which five themes ship, so it belongs to the
 * owner and not to a build script.
 *
 * NOT ONE of the 14 is a light scheme, and the previous light family
 * (Chinoiserie, shipped as Primal Porcelain) is gone. That is not a filter
 * artefact and not a regression in the selection rule: it is the syntax-contrast
 * check finding what nobody had measured. Chinoiserie paints seven of its
 * tokenColors rules between 2.36:1 and 2.72:1 on its own #FFFFFF plane -
 * constants at #FB8B05, types at #D6A01D, keywords at #C08EAF - which is code
 * the user cannot reliably read. Only 3 light schemes reach the generatable set
 * at all, and none of those is contrast clean.
 *
 * THE REASON THIS COMMENT USED TO GIVE FOR THAT WAS WRONG, and it is worth
 * correcting rather than deleting, because it is the false belief that kept the
 * product dark-only for as long as it did. It said "a light plane leaves less
 * room between the WCAG contrast floor and the top of the usable lightness
 * band". Measured, the opposite is true - a light plane has MORE lightness
 * budget for a ramp than a dark one, because the 3:1 frontier sits nearer the
 * far endpoint:
 *
 *     #FAF9F6 light  plane L 0.9820  3:1 frontier L 0.6550  band 0.6550
 *     #F8F3EC light  plane L 0.9661  3:1 frontier L 0.6451  band 0.6451
 *     #131211 dark   plane L 0.1830  3:1 frontier L 0.4908  band 0.5092
 *     #0E1621 dark   plane L 0.1980  3:1 frontier L 0.4979  band 0.5021
 *
 * What actually kills the light corpus is one derivation. `mapSeed` cuts the
 * four light ANSI neutrals out of three adjacent base16 greys plus a MIDPOINT it
 * invents between two of them, and four mutually distinct neutrals need about 20
 * dE00 of room in a gap the corpus does not have. Measured over the whole
 * corpus: of 130 light planes, 127 are rejected at `assertDistinctAnsi` and 3
 * survive - against 343 of 404 dark. The colours Primal itself manufactures are
 * what fail, not the colours the scheme states.
 *
 * That is a defect in the importer, not a fact about light palettes, and it is
 * why the synthesised producer - which PLACES its four neutrals on the plane's
 * own lightness axis instead of cutting them out of somebody else's greys -
 * produces light families at the same rate as dark ones. See
 * `primal/theme/synth/synthesise.ts`.
 */
interface Family {
	/** Primal's name. The user sees "Primal <name>". */
	readonly name: string;
	/** Path in primal/design/corpus. */
	readonly source: string;
	/** Why this one, in one line, for the report and for whoever revisits the choice. */
	readonly why: string;
}

const CATALOGUE: readonly Family[] = [
	{
		name: "Umber",
		source: "base16/mezcal.yaml",
		why: "best residual separation of anything that clears the gate (worst confusable pair 4.05 dE00); a near-black warm-earth plane at #13110E carrying muted olive and rust"
	},
	{
		name: "Pewter",
		source: "base16/tomorrow-night-eighties.yaml",
		why: "3.32 dE00; a neutral mid-grey plane at #2D2D2D with a full hue-bearing syntax palette, the only non-black ground in the catalogue. Replaces espresso, which held this register on the same #2D2D2D plane until assertDistinctAnsi began measuring separation instead of comparing bytes: espresso states base0C #BED6FF, a pale blue one step below its #FFFFFF base07, and the two are 17.55 dE00 apart in total, so the derived bright cyan needed 20 dE00 of room in a gap that holds 17.55 and shipped 7.26 dE00 off white. No lightness step repairs that in either direction, so the palette is rejected rather than patched, and the ground it occupied is held by the next scheme in the ranking with the same plane"
	},
	{
		name: "Cinder",
		source: "base16/brasa.yaml",
		why: "3.67 dE00; the most chromatic ground here, a near-black ember plane at #1A0F0A with orange and coral where the others are muted"
	},
	{
		name: "Trench",
		source: "base16/equilibrium-dark.yaml",
		why: "3.37 dE00; a cool near-black plane at #0C1118 with a high-chroma blue accent, the deepest and coldest ground in the catalogue"
	},
	{
		name: "Nightshade",
		source: "base16/precious-dark-eleven.yaml",
		why: "3.12 dE00; a cool grey plane at #1C1E20 carrying violet keywords, the register no other family and no hand-authored vibe occupies"
	}
];

/** `nightshade`, `nightshade-soft`. The id, the file stem and the settings value. */
function variantId(family: Family, depth: Depth): string {
	const slug = family.name.toLowerCase();
	return depth === "medium" ? slug : `${slug}-${depth}`;
}

/** `Primal Nightshade`, `Primal Nightshade Soft`. */
function variantLabel(family: Family, depth: Depth): string {
	return depth === "medium" ? `Primal ${family.name}` : `Primal ${family.name} ${depth[0].toUpperCase()}${depth.slice(1)}`;
}

/** `nightshadeSoftThemeLabel` - the nls key the package.json points at. */
function nlsKey(family: Family, depth: Depth): string {
	const suffix = depth === "medium" ? "" : `${depth[0].toUpperCase()}${depth.slice(1)}`;
	return `${family.name.toLowerCase()}${suffix}ThemeLabel`;
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

/**
 * The six original vibes, which this file DOES now regenerate.
 *
 * It used to skip them: their theme files were hand-authored, checked in, and
 * treated as the product's fixed identity. That is exactly what let their
 * semantic colours stay hand-picked, and hand-picked semantics are the defect
 * this pipeline exists to remove - measured on the files that shipped, ink put
 * `warning` and `added` 0.0003 of lightness apart, which is below what eight
 * bits can even express. So a warning triangle and an added-line marker were
 * the same shade, and for a red-green deficient user the same colour outright.
 *
 * They keep their seed, their eleven pinned surfaces, their name and their
 * place at the front of the picker. Only the twelve synthesised semantic slots
 * and the tokens hanging off them move, and primal/theme/tokenMap.test-fixture.json
 * keeps the before so the move stays measurable. Everything else in the file is
 * still byte for byte what it was, and tokenMap.ts --check asserts that.
 */
const HAND_AUTHORED: readonly { readonly id: string; readonly vibe: string; readonly nls: string; readonly uiTheme: string; readonly file: string }[] = [
	{ id: "Primal Ink", vibe: "ink", nls: "inkThemeLabel", uiTheme: "vs", file: "primal-ink-color-theme.json" },
	{ id: "Primal Basalt", vibe: "basalt", nls: "basaltThemeLabel", uiTheme: "vs-dark", file: "primal-basalt-color-theme.json" },
	{ id: "Primal Tide", vibe: "tide", nls: "tideThemeLabel", uiTheme: "vs-dark", file: "primal-tide-color-theme.json" },
	{ id: "Primal Dusk", vibe: "dusk", nls: "duskThemeLabel", uiTheme: "vs-dark", file: "primal-dusk-color-theme.json" },
	{ id: "Primal Fern", vibe: "fern", nls: "fernThemeLabel", uiTheme: "vs-dark", file: "primal-fern-color-theme.json" },
	{ id: "Primal Ridge", vibe: "ridge", nls: "ridgeThemeLabel", uiTheme: "vs", file: "primal-ridge-color-theme.json" }
];

/** One original vibe as vibe-tokens.json states it. */
interface VibeVariant {
	readonly id: string;
	readonly label: string;
	readonly mode: ThemeMode;
	readonly seed: Seed;
	readonly surfaces: Surfaces;
	readonly syntaxEmphasis: SyntaxEmphasis;
}

/** One original vibe, generated and judged. */
interface VibeBuilt {
	readonly variant: VibeVariant;
	readonly theme: ColorTheme;
	readonly ladder: SemanticLadder;
	readonly blocking: readonly Finding[];
	readonly ansiCollisions: number;
	readonly tolerated: number;
	readonly warnings: readonly Finding[];
}

interface RawVibeVariant {
	readonly id: string;
	readonly label: string;
	readonly mode: string;
	readonly seed: Record<string, string>;
	readonly surfaces?: Record<string, string>;
}

/**
 * The six seeds, read from the contract rather than from the theme files, so a
 * regenerated theme cannot become its own input.
 */
function loadVibes(): readonly VibeVariant[] {
	const raw = JSON.parse(readFileSync(VIBE_TOKENS_PATH, "utf8")) as {
		readonly version: number;
		readonly families: readonly { readonly syntaxEmphasis: string; readonly variants: readonly RawVibeVariant[] }[];
	};
	if (raw.version !== 2) throw new Error(`buildThemes: vibe-tokens.json is v${raw.version}; this build reads v2`);
	const byId = new Map<string, VibeVariant>();
	for (const family of raw.families) {
		if (family.syntaxEmphasis !== "weight" && family.syntaxEmphasis !== "plain") {
			throw new Error(`buildThemes: vibe-tokens.json states unknown syntaxEmphasis ${JSON.stringify(family.syntaxEmphasis)}`);
		}
		for (const variant of family.variants) {
			if (variant.mode !== "light" && variant.mode !== "dark") {
				throw new Error(`buildThemes: vibe "${variant.id}" states unknown mode ${JSON.stringify(variant.mode)}`);
			}
			byId.set(variant.id, {
				id: variant.id,
				label: variant.label,
				mode: variant.mode,
				seed: variant.seed as Seed,
				surfaces: (variant.surfaces ?? {}) as Surfaces,
				syntaxEmphasis: family.syntaxEmphasis
			});
		}
	}
	return HAND_AUTHORED.map(entry => {
		const variant = byId.get(entry.vibe);
		if (variant === undefined) throw new Error(`buildThemes: vibe-tokens.json has no variant "${entry.vibe}"`);
		return variant;
	});
}

/** Build and judge one original vibe. Same gate as a corpus theme, no exemptions. */
function buildVibe(variant: VibeVariant): VibeBuilt {
	const { theme, ladder } = expandSeed(variant.seed, variant.surfaces, {
		name: variant.label,
		mode: variant.mode,
		syntaxEmphasis: variant.syntaxEmphasis
	});
	const result = validate(theme as ColorTheme);
	const blocking: Finding[] = [];
	let ansiCollisions = 0;
	let tolerated = 0;
	for (const finding of result.errors) {
		const verdict = classify(theme as ColorTheme, ladder, finding, TOLERATED_LADDER_GAP);
		if (verdict === "blocking") { blocking.push(finding); continue; }
		if (verdict === "ansi-collision") { ansiCollisions++; continue; }
		tolerated++;
	}
	return { variant, theme: theme as ColorTheme, ladder, blocking, ansiCollisions, tolerated, warnings: result.warnings };
}

const HAND_AUTHORED_NLS: Readonly<Record<string, string>> = {
	inkThemeLabel: "Primal Ink",
	basaltThemeLabel: "Primal Basalt",
	tideThemeLabel: "Primal Tide",
	duskThemeLabel: "Primal Dusk",
	fernThemeLabel: "Primal Fern",
	ridgeThemeLabel: "Primal Ridge"
};

/**
 * The names a synthesised family may not take: the six vibes and the corpus
 * families, which already hold them.
 */
function reservedNames(): readonly { readonly id: string; readonly heldBy: string }[] {
	return [
		...HAND_AUTHORED.map(entry => ({ id: entry.vibe, heldBy: "an original vibe" })),
		...CATALOGUE.map(family => ({ id: family.name.toLowerCase(), heldBy: "a corpus family" }))
	];
}

/**
 * `primal/design/families.json`, read the way `loadVibes` reads
 * `vibe-tokens.json` and screened against the naming rules this file owns.
 */
function loadFamilies(): readonly FamilySpec[] {
	return loadFamilyBookScreened(FAMILIES_PATH, reservedNames(), FORBIDDEN_IDENTITIES);
}

/**
 * One theme registered in the picker, from whichever of the three producers made
 * it.
 *
 * `mode` is stated explicitly rather than read back through `built.scheme.mode`,
 * because a SYNTHESISED family has no `Scheme` - it derives from no upstream
 * palette at all. `family` and `built` are null for those, and `synth` is null
 * for a corpus theme; exactly one of the two is set, which `buildCatalogue`
 * maintains and `renderAttribution` relies on to keep its counts honest.
 */
interface Emitted {
	readonly family: Family | null;
	readonly built: Built | null;
	readonly synth: SynthBuilt | null;
	readonly mode: ThemeMode;
	readonly id: string;
	readonly label: string;
	readonly nls: string;
	readonly file: string;
}

/** package.json, rebuilt around whatever is emitted. Two-space indent, as VS Code's extensions use. */
function renderPackageJson(emitted: readonly Emitted[]): string {
	const current = JSON.parse(readFileSync(join(EXTENSION_DIR, "package.json"), "utf8")) as Record<string, unknown>;
	const themes = [
		...HAND_AUTHORED.map(entry => ({ id: entry.id, label: `%${entry.nls}%`, uiTheme: entry.uiTheme, path: `./themes/${entry.file}` })),
		...emitted.map(entry => ({
			id: entry.label,
			label: `%${entry.nls}%`,
			uiTheme: entry.mode === "light" ? "vs" : "vs-dark",
			path: `./themes/${entry.file}`
		}))
	];
	const next = { ...current, contributes: { ...(current["contributes"] as Record<string, unknown>), themes } };
	return `${JSON.stringify(next, null, 2)}\n`;
}

/** package.nls.json, rebuilt. Tabs, matching the file already in the tree. */
function renderPackageNls(emitted: readonly Emitted[]): string {
	// The counts are derived, and the sentence has two shapes rather than one so
	// that an empty families.json reproduces the file byte for byte. That is not
	// cosmetic: it is what let the synthesiser land with `--check` showing zero
	// diffs, which is the only way a reviewer can tell "new code" from "new
	// output".
	const corpus = emitted.filter(entry => entry.family !== null).length;
	const synthesised = emitted.length - corpus;
	const nls: Record<string, string> = {
		displayName: "Primal Vibes Themes",
		description: synthesised === 0
			? `The ${HAND_AUTHORED.length} hand-authored Primal Code vibes and ${corpus} generated corpus themes`
			: `The ${HAND_AUTHORED.length} hand-authored Primal Code vibes, ${corpus} generated corpus themes and ${synthesised} synthesised themes`,
		...HAND_AUTHORED_NLS
	};
	for (const entry of emitted) nls[entry.nls] = entry.label;
	return `${JSON.stringify(nls, null, "\t")}\n`;
}

/**
 * ATTRIBUTION.md. Generated from the corpus metadata on every build.
 *
 * Hand-maintaining this would guarantee it drifts: the moment a family is
 * swapped out, a line naming an author whose colours are no longer in the
 * product goes stale, and that is precisely the line that must not be wrong.
 */
function renderAttribution(emitted: readonly Emitted[]): string {
	// ONLY the corpus themes belong in the denominator. This file's central
	// sentence asserts that every generated Primal theme comes from
	// primal/design/corpus under MIT, and the moment a synthesised family shipped
	// that sentence became false for most of the catalogue - a generated
	// attribution naming the wrong origin is exactly the drift its own GENERATED
	// banner promises to prevent. So `derived` counts what actually derives from
	// an upstream palette, `synthesised` is stated separately, and both are
	// counted rather than written down.
	const derived = emitted.filter(entry => entry.family !== null);
	const synthesised = emitted.filter(entry => entry.synth !== null);
	const byFamily = new Map<string, Emitted[]>();
	for (const entry of derived) {
		const family = entry.family;
		if (family === null) {
			continue;
		}
		const list = byFamily.get(family.name) ?? [];
		list.push(entry);
		byFamily.set(family.name, list);
	}
	const synthFamilies = new Set(synthesised.map(entry => entry.synth?.spec.name ?? ""));

	const lines: string[] = [];
	lines.push("# Attribution");
	lines.push("");
	lines.push("<!-- GENERATED by primal/theme/buildThemes.ts. Do not edit; your changes will be");
	lines.push("     overwritten on the next build. Run `buildThemes.ts --check` to verify. -->");
	lines.push("");
	// Both counts are derived. The prose used to say "Five" as a string literal while
	// the table below it was built from `emitted`, so the file contradicted itself the
	// moment the catalogue changed - fifteen themes described as five - which is the
	// exact drift its own GENERATED banner promises to prevent.
	const total = emitted.length + HAND_AUTHORED.length;
	lines.push(
		`${derived.length} of the ${total} Primal colour themes, ` +
		`from ${byFamily.size} palette ${byFamily.size === 1 ? "family" : "families"}, are generated from palettes in`
	);
	lines.push("`primal/design/corpus/`, vendored from the [tinted-theming/schemes]");
	lines.push("repository under the MIT licence. `primal/design/corpus/SOURCE.md` records the");
	lines.push("exact commit; `primal/design/corpus/LICENSE` is the licence text those palettes");
	lines.push("arrive under, copied unmodified.");
	lines.push("");
	lines.push("A Primal theme is not the upstream scheme. Only the palette is taken; the");
	lines.push("workbench colours are expanded from it by `primal/theme/tokenMap.ts`, and the");
	lines.push("error, warning, diff and conflict colours are synthesised from scratch so that");
	lines.push("they are separated by lightness rather than by hue. **No theme ships under an");
	lines.push("upstream scheme's name.** Every Primal name below is original to this project.");
	lines.push("");
	lines.push("[tinted-theming/schemes]: https://github.com/tinted-theming/schemes");
	lines.push("");
	lines.push("`Author` is the `author` field the corpus records for that scheme - the person");
	lines.push("who contributed the palette to tinted-theming, who is not in every case its");
	lines.push("original designer. It is reproduced verbatim rather than researched, because a");
	lines.push("generated file must be able to state where every line came from.");
	lines.push("");
	lines.push("| Primal family | Variants | Source scheme | Author | Licence |");
	lines.push("| --- | --- | --- | --- | --- |");
	for (const family of CATALOGUE) {
		const entries = byFamily.get(family.name);
		if (!entries || entries.length === 0) continue;
		const scheme = entries[0].built.scheme;
		const variants = entries.map(entry => entry.label.replace("Primal ", "")).join(", ");
		lines.push(`| Primal ${family.name} | ${variants} | ${scheme.name} (\`${scheme.source}\`) | ${scheme.author} | MIT |`);
	}
	lines.push("");

	// A scheme's own `description` is the only place the corpus records a FURTHER
	// upstream - a different author, in a different repository, that the palette was
	// derived from before tinted-theming ever saw it. Dropping it, as this file used
	// to, is the one way a generated attribution can name the wrong origin while
	// looking complete. Emitted verbatim, for the same reason `author` is.
	const lineage = CATALOGUE
		.map(family => ({ family, scheme: byFamily.get(family.name)?.[0]?.built.scheme }))
		.filter((entry): entry is { family: Family; scheme: Scheme } => entry.scheme?.description != null);
	if (lineage.length > 0) {
		lines.push("The corpus records a further upstream for some of these palettes, in the");
		lines.push("scheme's own `description` field. Reproduced verbatim:");
		lines.push("");
		for (const { family, scheme } of lineage) {
			lines.push(`- **Primal ${family.name}** - ${scheme.name}: "${scheme.description}"`);
		}
		lines.push("");
	}
	lines.push("The six original vibes - Ink, Basalt, Tide, Dusk, Fern and Ridge - are");
	lines.push("hand-authored for this project and derive from no external palette.");
	lines.push("");
	if (synthesised.length > 0) {
		lines.push(
			`${synthesised.length} of the ${total} themes, from ${synthFamilies.size} ` +
			`${synthFamilies.size === 1 ? "family" : "families"}, are synthesised from the specifications in`
		);
		lines.push("`primal/design/families.json` and derive from no upstream palette. A specification");
		lines.push("contains no colour: it states a lightness, a chroma, a hue and a set of contrast");
		lines.push("targets, and `primal/theme/synth/` places every colour against a measured floor.");
		lines.push("There is nothing in them to attribute, and no licence travels with them.");
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

/**
 * extensions/theme-primal/cgmanifest.json - the licence registration that makes the
 * MIT notice travel with the shipped binary.
 *
 * THE OBLIGATION. importPalette copies base00, base02-base05 and base08-base0E
 * straight through into every generated theme; those hex values are the vendored
 * corpus, and MIT requires its copyright notice and permission notice to travel with
 * any substantial portion of the software. primal/design/corpus/SOURCE.md states that
 * obligation itself - and `primal/` ships in no build. build/gulpfile.vscode.ts
 * packages `product.licenseFileName`, `ThirdPartyNotices.txt`, `licenses/**`,
 * `.build/extensions/**` and `out/**`, and matches `primal/` with none of them. So the
 * palettes shipped and the notice did not.
 *
 * WHY HERE. build/azure-pipelines/oss/scan-licenses.ts harvests EVERY cgmanifest.json
 * in the repository (findCgManifestFiles -> findFilesRecursive(repoRoot,
 * 'cgmanifest.json')) and lifts `licenseDetail` into the generated notices, and
 * extensions/theme-monokai already registers its own upstream palette source exactly
 * this way. Putting the registration beside the themes it covers means it cannot be
 * separated from them, and it needs no edit to a file outside this extension.
 *
 * WHY GENERATED. The commit and the licence text are facts about
 * primal/design/corpus, not about this file, so they are read from SOURCE.md and
 * LICENSE on every build and `--check` fails if the registration on disk has drifted
 * from them. A hand-maintained licence registration is a licence registration that
 * silently stops describing what shipped.
 */
function renderCgManifest(): string {
	const source = readFileSync(join(CORPUS_DIR, "SOURCE.md"), "utf8");
	const commit = /^\|\s*Commit\s*\|\s*`([0-9a-f]{40})`\s*\|/m.exec(source);
	const upstream = /^\|\s*Upstream\s*\|\s*<(https:\/\/[^>]+)>\s*\|/m.exec(source);
	if (commit === null || upstream === null) {
		throw new Error(
			"buildThemes: primal/design/corpus/SOURCE.md no longer states the upstream URL and the 40-character commit " +
			"in its provenance table, so the licence registration cannot be generated. Fix SOURCE.md, not this file."
		);
	}
	const licence = readFileSync(join(CORPUS_DIR, "LICENSE"), "utf8").replace(/\n+$/, "").split("\n");
	if (!licence.some(line => /copyright/i.test(line))) {
		throw new Error("buildThemes: primal/design/corpus/LICENSE carries no copyright line; refusing to register it as the notice");
	}

	const manifest = {
		registrations: [
			{
				component: {
					type: "git",
					git: {
						name: "tinted-theming/schemes",
						repositoryUrl: upstream[1],
						commitHash: commit[1]
					}
				},
				license: "MIT",
				licenseDetail: licence,
				version: commit[1].slice(0, 7)
			}
		],
		version: 1
	};
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

// ---------------------------------------------------------------------------
// Survey
// ---------------------------------------------------------------------------

interface SurveyRow {
	readonly scheme: Scheme;
	readonly generatable: boolean;
	readonly generationError: string | null;
	readonly contrastClean: boolean;
	readonly cvdClean: boolean;
	readonly strictErrors: number;
	readonly blocking: number;
	readonly ansiCollisions: number;
	readonly liftedAnsi: number;
	readonly worstConfusableDeltaE: number;
	/** As `cvdClean`, but forgiving only the half-step neighbours. The rigorous reading. */
	readonly strictCvdClean: boolean;
	/** The editor plane this scheme would ship, which MIN_FAMILY_PLANE_SEPARATION ranks on. */
	readonly editorBg: string;
}

const CONTRAST_CHECKS: readonly string[] = ["editor text contrast", "comment contrast", "highlighted text contrast", "ansi readability"];

/**
 * Run the whole corpus and answer the question the catalogue depends on: how
 * many of these palettes can produce a theme this product would be willing to
 * ship?
 *
 * "Contrast" counts a theme with no error from any readability check.
 * "CVD" counts a theme with no perceptual-separation error the palette could
 * have avoided - the same gate the build uses, restricted to the checks that
 * measure colour-blind separation.
 */
function survey(): readonly SurveyRow[] {
	const rows: SurveyRow[] = [];
	for (const scheme of loadCorpus()) {
		let built: Built;
		try {
			built = build(scheme, "medium", "Survey");
		} catch (error) {
			rows.push({
				scheme, generatable: false, generationError: (error as Error).message,
				contrastClean: false, cvdClean: false, strictErrors: -1, blocking: -1, ansiCollisions: -1, liftedAnsi: -1,
				worstConfusableDeltaE: -1, strictCvdClean: false, editorBg: "#000000"
			});
			continue;
		}
		const strict = validate(built.theme).errors;
		rows.push({
			scheme,
			generatable: true,
			generationError: null,
			contrastClean: built.blocking.every(f => !CONTRAST_CHECKS.includes(f.check)),
			cvdClean: built.blocking.every(f => !f.check.startsWith("semantic separation")),
			strictErrors: strict.length,
			blocking: built.blocking.length,
			ansiCollisions: built.ansiCollisions,
			liftedAnsi: liftedAnsiSlots(scheme, { depth: "medium" }).length,
			worstConfusableDeltaE: built.worstConfusableDeltaE,
			strictCvdClean: build(scheme, "medium", "Survey", STRICT_LADDER_GAP).blocking.every(f => !f.check.startsWith("semantic separation")),
			editorBg: built.theme.colors?.["editor.background"] ?? "#000000"
		});
	}
	return rows;
}

function printSurvey(rows: readonly SurveyRow[]): void {
	const total = rows.length;
	const generatable = rows.filter(r => r.generatable);
	const n = generatable.length;
	const pct = (count: number): string => `${count}/${n} (${((100 * count) / n).toFixed(1)}%)`;

	const ansiRejected = rows.filter(r => !r.generatable && r.generationError?.includes("terminal colours must be distinct")).length;
	console.log(`corpus: ${total} schemes vendored`);
	console.log(`  ${ansiRejected} rejected by importPalette: the palette cannot state 16 distinct ANSI colours`);
	console.log(`  ${total - n - ansiRejected} rejected by generateTheme: the palette has no room for a semantic ladder`);
	console.log(`  ${n} generatable`);
	console.log("");
	console.log("pass rates over the generatable set, at the medium depth:");
	console.log(`  contrast clean               ${pct(generatable.filter(r => r.contrastClean).length)}`);
	console.log(`  colour-blind separation clean ${pct(generatable.filter(r => r.cvdClean).length)}`);
	console.log(`  BOTH                          ${pct(generatable.filter(r => r.contrastClean && r.cvdClean).length)}`);
	console.log(`  colour-blind separation clean, STRICT reading (only half-step neighbours forgiven):`);
	console.log(`                                ${pct(generatable.filter(r => r.strictCvdClean).length)}`);
	console.log(`  no blocking error at all      ${pct(generatable.filter(r => r.blocking === 0).length)}`);
	console.log(`  zero validator errors, strict ${pct(generatable.filter(r => r.strictErrors === 0).length)}`);
	for (const mode of ["dark", "light"] as const) {
		const inMode = generatable.filter(r => r.scheme.mode === mode);
		const clean = inMode.filter(r => r.blocking === 0).length;
		console.log(`  ${mode}: ${inMode.length} generatable, ${inMode.filter(r => r.contrastClean).length} contrast clean, ${clean} with no blocking error`);
	}
	console.log("");
	const lifts = generatable.reduce((sum, r) => sum + r.liftedAnsi, 0);
	console.log(`ANSI legibility lift touched ${lifts} slot(s) across ${generatable.filter(r => r.liftedAnsi > 0).length} scheme(s).`);
	const collisions = generatable.map(r => r.ansiCollisions).sort((a, b) => a - b);
	console.log(`ANSI collisions per theme (tolerated): min ${collisions[0]}, median ${collisions[Math.floor(n / 2)]}, max ${collisions[n - 1]}.`);
	console.log("");
	const shippable = generatable.filter(r => r.blocking === 0 && excludedBecause(r.scheme) === null);
	const ranked = [...shippable].sort((a, b) => b.worstConfusableDeltaE - a.worstConfusableDeltaE || a.ansiCollisions - b.ansiCollisions);
	const picked = new Set(selectFamilies(ranked, CATALOGUE.length).map(r => r.scheme.source));
	console.log(`shippable after the naming and licence rules: ${shippable.length}`);
	for (const row of ranked) {
		const worst = Number.isFinite(row.worstConfusableDeltaE) ? row.worstConfusableDeltaE.toFixed(2) : "none";
		console.log(
			`  ${picked.has(row.scheme.source) ? "PICKED" : "      "}  worstConfusable dE00 ${worst.padStart(5)}  ` +
			`ansiCollisions ${String(row.ansiCollisions).padStart(2)}  plane ${row.editorBg}  ` +
			`${row.scheme.mode.padEnd(5)} ${row.scheme.source.padEnd(38)} ${row.scheme.name}`
		);
	}
	console.log(`  PICKED = top of the ranking whose plane is >= ${MIN_FAMILY_PLANE_SEPARATION} dE00 from every family already taken.`);
	const excluded = generatable.filter(r => r.blocking === 0 && excludedBecause(r.scheme) !== null);
	console.log(`clean but excluded by name or licence: ${excluded.length}`);
	for (const row of excluded) console.log(`  ${row.scheme.source.padEnd(38)} ${excludedBecause(row.scheme)}`);
	printSynthesisedSurvey();
}

/**
 * What the third producer contributes, and how close its families sit to each
 * other and to everything else.
 *
 * This is the section that has to be read next to the corpus numbers above,
 * because the two answer the same question from opposite ends: the corpus asks
 * how many of 534 stated palettes survive a gate, and the synthesiser asks how
 * many distinct families the owner's own eyes admit at all.
 */
function printSynthesisedSurvey(): void {
	console.log("");
	let specs: readonly FamilySpec[];
	try {
		specs = loadFamilies();
	} catch (error) {
		console.log(`synthesised: families.json cannot be read: ${(error as Error).message}`);
		return;
	}
	if (specs.length === 0) {
		console.log("synthesised: primal/design/families.json is empty or absent, so the catalogue is corpus and vibes only.");
		return;
	}
	const light = specs.filter(spec => spec.mode === "light").length;
	const themes = specs.reduce((sum, spec) => sum + spec.depths.length, 0);
	console.log(`synthesised: ${specs.length} families (${specs.length - light} dark, ${light} light) -> ${themes} picker entries`);
	const depths = { soft: 0, medium: 0, hard: 0 };
	for (const spec of specs) {
		for (const depth of spec.depths) {
			depths[depth]++;
		}
	}
	console.log(`  depths expressible: soft ${depths.soft}/${specs.length}, medium ${depths.medium}/${specs.length}, hard ${depths.hard}/${specs.length}`);
	const spread = new Map<string, number>();
	for (const spec of specs) {
		const key = `${spec.register}/${spec.syntaxEmphasis}`;
		spread.set(key, (spread.get(key) ?? 0) + 1);
	}
	console.log(`  register/emphasis: ${[...spread].sort().map(([key, count]) => `${key} ${count}`).join(", ")}`);

	const worst = specs.map(spec => spec.slack.ansiWorstPair).sort((a, b) => a - b);
	const collisions = specs.map(spec => spec.slack.ansiDichromatCollisions).sort((a, b) => a - b);
	const warnings = specs.map(spec => spec.slack.warnings).sort((a, b) => a - b);
	const spreadRatios = specs.map(spec => spec.slack.syntaxContrastRatio).sort((a, b) => a - b);
	const band = (values: readonly number[]): string => `min ${values[0]}, median ${values[Math.floor(values.length / 2)]}, max ${values[values.length - 1]}`;
	console.log(`  worst ANSI pair, trichromat (floor 10):    ${band(worst)}`);
	console.log(`  ANSI pairs a dichromat cannot resolve/120: ${band(collisions)}`);
	console.log(`  loudest-over-quietest syntax contrast:     ${band(spreadRatios)}`);
	console.log(`  validator warnings (the six vibes: 43-60): ${band(warnings)}`);
	console.log("  The ANSI ramp is trichromat-safe by construction and best-effort for a dichromat, which is the");
	console.log("  same claim the product already makes. The semantics you depend on are guaranteed to everyone.");

	const { identities, sheet } = buildCatalogue();
	const synthesisedKeys = new Set(sheet.map(entry => entry.key));
	const nearest = nearestNeighbours(identities);
	console.log("");
	console.log(`  ${identities.length} families in the whole catalogue. Nearest-neighbour D_owner, closest first:`);
	for (const row of nearest.slice(0, 12)) {
		console.log(`    ${row.distance.toFixed(2).padStart(5)}  ${row.key.padEnd(18)} -> ${row.nearest}`);
	}
	const sharedGround = closestPairs(identities).filter(pair => pair.admitted.startsWith("shared ground")).length;
	console.log(`  ${sharedGround} pair(s) share a ground within a JND and are admitted on what they carry elsewhere.`);
	const unreviewed = specs.filter(spec => spec.approval.by === "unreviewed").length;
	console.log(`  ${unreviewed} of ${specs.length} synthesised families carry no human approval.`);
	console.log(`  ${synthesisedKeys.size} of them are on the contact sheet as synthesised; the rest of the sheet is what already ships.`);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface BuildOutput {
	readonly emitted: readonly Emitted[];
	readonly vibes: readonly VibeBuilt[];
	readonly files: ReadonlyMap<string, string>;
	/** Every shipped family, for the distinctness gate and the contact sheet. */
	readonly identities: readonly FamilyIdentity[];
	/** The synthesised families, keyed by name, with a theme per expressible depth. */
	readonly sheet: readonly SheetEntry[];
	/** Every family on the contact sheet: the vibes and corpus families too. */
	readonly fullSheet: readonly SheetEntry[];
}

/** Generate everything the catalogue asks for. Throws if a chosen family stopped passing. */
function buildCatalogue(): BuildOutput {
	const corpus = loadCorpus();
	const emitted: Emitted[] = [];
	const files = new Map<string, string>();

	// The six original vibes first, on the same gate as everything else.
	const vibes: VibeBuilt[] = [];
	for (const entry of HAND_AUTHORED) {
		const variant = loadVibes().find(candidate => candidate.id === entry.vibe);
		if (variant === undefined) throw new Error(`buildThemes: vibe-tokens.json has no variant "${entry.vibe}"`);
		const built = buildVibe(variant);
		if (built.blocking.length > 0) {
			const detail = built.blocking.map(f => `      ${f.check} | ${f.token} | ${f.measured}`).join("\n");
			throw new Error(`buildThemes: ${variant.label} has ${built.blocking.length} blocking error(s) and cannot ship:\n${detail}`);
		}
		if (themeFileName(variant.id) !== entry.file) {
			throw new Error(`buildThemes: vibe "${variant.id}" would be written to ${themeFileName(variant.id)}, but the picker registers ${entry.file}`);
		}
		files.set(join(THEMES_DIR, entry.file), serialiseTheme(built.theme as Parameters<typeof serialiseTheme>[0]));
		vibes.push(built);
	}

	for (const family of CATALOGUE) {
		const scheme = corpus.find(entry => entry.source === family.source);
		if (scheme === undefined) throw new Error(`buildThemes: catalogue names ${family.source}, which is not in the corpus`);
		const excluded = excludedBecause(scheme);
		if (excluded !== null) throw new Error(`buildThemes: catalogue names ${family.source}, which the naming rules exclude: ${excluded}`);

		const depths = expressibleDepths(scheme);
		if (depths.length === 0) throw new Error(`buildThemes: ${family.source} cannot express any depth`);
		for (const depth of ["soft", "medium", "hard"] as const) {
			if (!depths.includes(depth)) continue;
			const label = variantLabel(family, depth);
			const built = build(scheme, depth, label);
			if (built.blocking.length > 0) {
				const detail = built.blocking.map(f => `      ${f.check} | ${f.token} | ${f.measured}`).join("\n");
				throw new Error(
					`buildThemes: ${label} (${family.source} @ ${depth}) has ${built.blocking.length} blocking error(s) and cannot ship:\n${detail}`
				);
			}
			const id = variantId(family, depth);
			const file = themeFileName(id);
			files.set(join(THEMES_DIR, file), serialiseTheme(built.theme as Parameters<typeof serialiseTheme>[0]));
			emitted.push({ family, built, synth: null, mode: built.scheme.mode, id, label, nls: nlsKey(family, depth), file });
		}
	}

	// The third producer, LAST, so every existing contributes.themes entry keeps
	// the position it has and new ones append. A picker that reshuffles itself
	// when the catalogue grows is a picker whose muscle memory is worthless.
	const errors: CatalogueError[] = [];
	const sheet: SheetEntry[] = [];
	for (const spec of loadFamilies()) {
		const seedsByDepth = new Map<Depth, Seed>();
		const themesByDepth = new Map<Depth, ColorTheme>();
		const staged: { readonly built: SynthBuilt; readonly id: string; readonly label: string; readonly file: string }[] = [];
		let broken = false;
		for (const depth of spec.depths) {
			const label = synthVariantLabel(spec, depth);
			const outcome = buildSynthesised(spec, depth, label);
			if (isCatalogueError(outcome)) {
				errors.push(outcome);
				broken = true;
				continue;
			}
			seedsByDepth.set(depth, outcome.seed);
			themesByDepth.set(depth, outcome.theme);
			const id = synthVariantId(spec, depth);
			staged.push({ built: outcome, id, label, file: themeFileName(id) });
		}
		if (broken) {
			continue;
		}
		const medium = staged.find(entry => entry.built.depth === "medium");
		if (medium === undefined) {
			errors.push({ family: spec.name, detail: "states no medium depth; every family must be able to express it" });
			continue;
		}
		const ledger = verifyLedger(spec, seedsByDepth, medium.built.report);
		if (ledger.length > 0) {
			errors.push({ family: spec.name, detail: ledger.map(line => `        ${line}`).join("\n") });
			continue;
		}
		for (const entry of staged) {
			files.set(join(THEMES_DIR, entry.file), serialiseTheme(entry.built.theme as Parameters<typeof serialiseTheme>[0]));
			emitted.push({
				family: null,
				built: null,
				synth: entry.built,
				mode: spec.mode,
				id: entry.id,
				label: entry.label,
				nls: synthNlsKey(spec, entry.built.depth),
				file: entry.file
			});
		}
		sheet.push({
			key: spec.name,
			label: `Primal ${spec.name}`,
			identity: identityOf(spec.name, medium.built.seed, spec.mode, spec.syntaxEmphasis),
			themes: themesByDepth,
			origin: "synthesised",
			caption:
				`${spec.mode} - ${spec.register} - ${spec.syntaxEmphasis} - depths ${spec.depths.join("/")} - ` +
				`worst ANSI pair ${spec.slack.ansiWorstPair} dE00, ${spec.slack.ansiDichromatCollisions}/120 dichromat collisions, ` +
				`syntax spread ${spec.slack.syntaxContrastRatio}x, ${spec.slack.warnings} warnings - approval: ${spec.approval.by}`,
			sheetHash: spec.approval.sheet
		});
	}
	if (errors.length > 0) {
		const detail = errors.map(error => `  ${error.family}\n      ${error.detail}`).join("\n");
		throw new Error(
			`buildThemes: ${errors.length} synthesised ${errors.length === 1 ? "family" : "families"} cannot be built:\n${detail}\n` +
			"Run `buildThemes.ts --repair` to see whether a bounded move inside each spec's own box fixes it, or drop the family."
		);
	}

	// Every family the catalogue ships, measured against every other, for THIS
	// owner. Vibes and corpus families are in here too: a rule that only applied
	// to the new work would be a rule the catalogue does not actually hold to.
	const identities: FamilyIdentity[] = [];
	for (const built of vibes) {
		identities.push(identityOf(`vibe:${built.variant.id}`, built.variant.seed, built.variant.mode, built.variant.syntaxEmphasis));
	}
	for (const family of CATALOGUE) {
		// The medium depth explicitly. Identity is depth-independent - every one of
		// the seven identity slots comes straight from the scheme and none of them
		// moves with the depth step - but naming the depth means the pinned
		// calibration matrix cannot start measuring a different variant because the
		// emission order changed.
		const entries = emitted.filter(candidate => candidate.family?.name === family.name && candidate.built !== null);
		const chosen = entries.find(candidate => candidate.built?.depth === "medium") ?? entries[0];
		const built = chosen?.built;
		if (built === undefined || built === null) {
			continue;
		}
		identities.push(identityOf(family.name, seedOf(built), built.scheme.mode, "plain"));
	}
	for (const entry of sheet) {
		identities.push(entry.identity);
	}
	assertCatalogueDistinct(identities);

	// The contact sheet carries the vibes and the corpus families as well as the
	// synthesised ones. A reviewer judging a new family against nothing is not
	// reviewing it; he needs the ones he already approved in the same grid.
	const fullSheet: SheetEntry[] = [];
	for (const built of vibes) {
		fullSheet.push({
			key: `vibe:${built.variant.id}`,
			label: built.variant.label,
			identity: identityOf(`vibe:${built.variant.id}`, built.variant.seed, built.variant.mode, built.variant.syntaxEmphasis),
			themes: new Map([["medium", built.theme]]),
			origin: "hand-authored vibe",
			caption: `${built.variant.mode} - ${built.variant.syntaxEmphasis} - ${built.warnings.length} warnings - approval: shipped`,
			sheetHash: "".padEnd(64, "0")
		});
	}
	for (const family of CATALOGUE) {
		const entries = emitted.filter(entry => entry.family?.name === family.name && entry.built !== null);
		const medium = entries.find(entry => entry.built?.depth === "medium") ?? entries[0];
		const built = medium?.built;
		if (built === undefined || built === null) {
			continue;
		}
		fullSheet.push({
			key: family.name,
			label: `Primal ${family.name}`,
			identity: identityOf(family.name, seedOf(built), built.scheme.mode, "plain"),
			themes: new Map(entries.map(entry => [entry.built!.depth, entry.built!.theme])),
			origin: `corpus (${family.source})`,
			caption: `${built.scheme.mode} - derived from ${family.source} - ${built.warnings.length} warnings - approval: shipped`,
			sheetHash: "".padEnd(64, "0")
		});
	}
	fullSheet.push(...sheet);
	files.set(CONTACT_SHEET_PATH, renderContactSheet(fullSheet, "primal/theme/buildThemes.ts"));

	files.set(join(EXTENSION_DIR, "package.json"), renderPackageJson(emitted));
	files.set(join(EXTENSION_DIR, "package.nls.json"), renderPackageNls(emitted));
	files.set(CGMANIFEST_PATH, renderCgManifest());
	files.set(ATTRIBUTION_PATH, renderAttribution(emitted));
	return { emitted, vibes, files, identities, sheet, fullSheet };
}

/** The seed a Built came from. Cheap: toSeed is pure and deterministic. */
function seedOf(built: Built): ReturnType<typeof toSeed> {
	return toSeed(built.scheme, { depth: built.depth });
}

function reportVibes(vibes: readonly VibeBuilt[]): void {
	console.log("The six original vibes, regenerated from their seeds in primal/design/vibe-tokens.json:");
	for (const built of vibes) {
		console.log(
			`    ${built.variant.label.padEnd(26)} ${built.variant.mode.padEnd(5)} ` +
			`worst pair dE00 ${built.ladder.minDeltaE.toFixed(2)}  ` +
			`minContrast ${built.ladder.minContrast.toFixed(2)}:1  ` +
			`wash text ${built.ladder.minWashTextContrast.toFixed(2)}:1  ` +
			`lightness-alone ${built.ladder.hueAssistedFamilies.length === 0 ? "all families" : `all but ${built.ladder.hueAssistedFamilies.join(", ")}`}  ` +
			`ansiCollisions ${built.ansiCollisions}  warnings ${built.warnings.length}`
		);
	}
	console.log("");
}

function reportEmitted(emitted: readonly Emitted[]): void {
	for (const family of CATALOGUE) {
		const mine = emitted.filter(entry => entry.family?.name === family.name);
		if (mine.length === 0) continue;
		const first = mine[0].built;
		if (first === null) continue;
		const scheme = first.scheme;
		console.log(`Primal ${family.name}  <- ${scheme.source}  "${scheme.name}" by ${scheme.author}`);
		console.log(`    ${family.why}`);
		for (const entry of mine) {
			const built = entry.built;
			if (built === null) continue;
			console.log(
				`    ${entry.label.padEnd(26)} ${built.scheme.mode.padEnd(5)} depth ${built.depth.padEnd(6)} ` +
				`plane dL ${realisedDepth(seedOf(built).editorBg, seedOf(built).chromeBg).toFixed(4)} (asked ${DEPTH_STEPS[built.depth].toFixed(4)})  ` +
				`worst pair dE00 ${built.ladder.minDeltaE.toFixed(2)}  ` +
				`lightness-alone ${built.ladder.hueAssistedFamilies.length === 0 ? "all" : `all but ${built.ladder.hueAssistedFamilies.join("/")}`}  ` +
				`minContrast ${built.ladder.minContrast.toFixed(2)}:1  ` +
				`worstConfusable dE00 ${Number.isFinite(built.worstConfusableDeltaE) ? built.worstConfusableDeltaE.toFixed(2) : "none"}  ` +
				`tolerated ${built.tolerated}  ansiCollisions ${built.ansiCollisions}  warnings ${built.warnings.length}`
			);
		}
	}
}

/**
 * What the synthesised catalogue actually is, printed in the order a reviewer
 * would look at it: closest pair first.
 *
 * The numbers here are the ones a human decision has to be made on - the
 * nearest neighbour, the dichromat collision count, and whether anybody has
 * looked at the family yet.
 */
function reportSynthesised(sheet: readonly SheetEntry[], identities: readonly FamilyIdentity[]): void {
	if (sheet.length === 0) {
		console.log("No synthesised families: primal/design/families.json is empty or absent.");
		console.log("");
		return;
	}
	const neighbours = new Map(nearestNeighbours(identities).map(row => [row.key, row]));
	const light = sheet.filter(entry => entry.identity.mode === "light").length;
	console.log(`${sheet.length} synthesised ${sheet.length === 1 ? "family" : "families"} (${sheet.length - light} dark, ${light} light), closest pair first:`);
	const ordered = [...sheet].sort((a, b) => (neighbours.get(a.key)?.distance ?? 0) - (neighbours.get(b.key)?.distance ?? 0));
	for (const entry of ordered) {
		const row = neighbours.get(entry.key);
		const spec = entry.themes.size;
		console.log(
			`    ${entry.label.padEnd(24)} ${entry.identity.mode.padEnd(5)} ${entry.identity.register.padEnd(11)} ` +
			`${spec} depth(s)  nearest ${(row?.nearest ?? "-").padEnd(16)} D ${(row?.distance ?? 0).toFixed(2)}`
		);
	}
	const unreviewed = sheet.filter(entry => entry.caption.includes("approval: unreviewed")).length;
	if (unreviewed > 0) {
		console.log(`    ${unreviewed} of ${sheet.length} carry no human approval. Run --contact-sheet and review them.`);
	}
	console.log("");
}

/**
 * Theme files on disk that this build did not produce and did not hand-author.
 *
 * A family dropped from the catalogue leaves its variants behind, still listed by
 * nothing and still loadable by anyone who edits their settings by hand. They are
 * drift, and a write has to remove them or `--check` fails immediately after a
 * successful build. Deliberately narrow: only `*-color-theme.json` directly in
 * THEMES_DIR, never anything else in the extension.
 */
function orphanedThemes(files: ReadonlyMap<string, string>): readonly string[] {
	const expected = new Set([...files.keys()]);
	// The six original vibes used to be excluded here because nothing generated
	// them. They are generated now, so they are in `expected` like everything
	// else and need no exception - which also means a stale one left behind by a
	// rename is caught instead of protected.
	return readdirSync(THEMES_DIR)
		.filter(file => file.endsWith("-color-theme.json"))
		.map(file => join(THEMES_DIR, file))
		.filter(path => !expected.has(path));
}

/** Returns the orphans it deleted, so the caller can say so out loud. */
function writeAll(files: ReadonlyMap<string, string>): readonly string[] {
	mkdirSync(THEMES_DIR, { recursive: true });
	const orphans = orphanedThemes(files);
	for (const path of orphans) rmSync(path);
	for (const [path, content] of files) writeFileSync(path, content, "utf8");
	return orphans;
}

/** Compare every generated file with what is on disk. Returns the paths that differ. */
function drift(files: ReadonlyMap<string, string>): readonly string[] {
	const differing: string[] = [];
	for (const [path, content] of files) {
		let onDisk: string;
		try {
			onDisk = readFileSync(path, "utf8");
		} catch {
			differing.push(`${path} (missing)`);
			continue;
		}
		if (onDisk !== content) differing.push(path);
	}
	// A generated theme file left behind after a catalogue change is drift too.
	for (const path of orphanedThemes(files)) differing.push(`${path} (orphaned)`);
	return differing;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * `--propose N`: the OFFLINE search that produces `primal/design/families.json`.
 *
 * It is not part of the build and the build never calls it. It draws specs,
 * keeps the clean ones, packs them farthest-point against the eleven families
 * that already ship, names them from `names.json`, and writes the file for a
 * human to review as a diff.
 *
 * IT WILL NOT PAD THE CATALOGUE. The packer stops when no candidate is
 * admissible and the number it returns is the number that ships. The report says
 * whether packing or the name book was the binding constraint, so a small answer
 * can be read for what it is rather than blamed on the wrong thing.
 */
function runPropose(draws: number, rngSeed: number): number {
	const { vibes, identities, sheet } = buildCatalogue();
	// Pack against what ships today MINUS the synthesised families, so a re-run
	// proposes a whole catalogue rather than squeezing new families into the gaps
	// left by the last one.
	const synthesisedKeys = new Set(sheet.map(entry => entry.key));
	const shipped = identities.filter(identity => !synthesisedKeys.has(identity.key));
	const names = loadNames();

	console.log(`propose: ${draws} draws, seed ${rngSeed}, packed against ${shipped.length} shipped families, ${names.length} names available.`);
	const started = Date.now();
	const proposal = propose(draws, rngSeed, shipped, names, (done, clean) => {
		process.stdout.write(`\r  ${done}/${draws} drawn, ${clean} clean   `);
	});
	process.stdout.write("\r");

	const report = proposal.report;
	const rejected = Object.entries(report.failures).sort((a, b) => b[1] - a[1]);
	console.log(`propose: ${report.clean.length} of ${report.draws} draws came back clean (${((100 * report.clean.length) / report.draws).toFixed(1)}%) in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
	for (const [stage, count] of rejected) {
		if (count > 0) {
			console.log(`    ${String(count).padStart(6)}  ${stage}`);
		}
	}
	const cleanLight = report.clean.filter(candidate => candidate.spec.mode === "light").length;
	console.log(`    clean pool: ${report.clean.length - cleanLight} dark, ${cleanLight} light`);

	const light = proposal.specs.filter(spec => spec.mode === "light").length;
	console.log("");
	console.log(`propose: ${proposal.specs.length} families accepted (${proposal.specs.length - light} dark, ${light} light).`);
	const themes = proposal.specs.reduce((sum, spec) => sum + spec.depths.length, 0);
	console.log(`         ${themes} picker entries across them, plus the ${vibes.length + CATALOGUE.length * 3} that ship today.`);
	const spread = new Map<string, number>();
	for (const spec of proposal.specs) {
		const key = `${spec.register}/${spec.syntaxEmphasis}`;
		spread.set(key, (spread.get(key) ?? 0) + 1);
	}
	console.log(`         register/emphasis spread: ${[...spread].map(([key, count]) => `${key} ${count}`).join(", ")}`);
	console.log(
		proposal.namesRemaining > 0
			? `         PACKING was the binding constraint: ${proposal.namesRemaining} names went unused.`
			: "         THE NAME BOOK was the binding constraint: every name was used, so a longer names.json may yield more families."
	);
	console.log("");
	writeFamilyBook(
		proposal.specs,
		`${proposal.specs.length} families from ${draws} draws at seed ${rngSeed}, packed farthest-point against the ` +
		`${shipped.length} families that ship without a synthesiser. Reproduce with: buildThemes.ts --propose ${draws} --seed ${rngSeed}`,
		FAMILIES_PATH
	);
	console.log(`propose: wrote ${FAMILIES_PATH.replace(`${REPO}/`, "")}. Review the diff, run --contact-sheet, then sign the approvals.`);
	return 0;
}

/**
 * `--repair`: for every family in `families.json` that no longer synthesises,
 * walk its declared repair ladder inside its own box and print the diff.
 *
 * It writes nothing. A repair changes what ships, so it produces a proposal and
 * stops.
 */
function runRepair(): number {
	const specs = loadFamilyBook(FAMILIES_PATH);
	let broken = 0;
	for (const spec of specs) {
		const outcome = buildSynthesised(spec, "medium", `Primal ${spec.name}`);
		if (!isCatalogueError(outcome)) {
			continue;
		}
		broken++;
		const attempt = repair(spec, REPAIR_LADDER.ramp);
		console.log(`${spec.name}: ${outcome.detail.split("\n")[0]}`);
		if (attempt.repaired === null) {
			console.log(`    NO REPAIR. ${attempt.why}`);
			continue;
		}
		for (const step of attempt.steps) {
			console.log(`    ${step.field}: ${step.from} -> ${step.to}`);
		}
		console.log("    repaired. Apply the moves above to families.json by hand, then re-run --check.");
	}
	console.log(broken === 0 ? "repair: every family in families.json synthesises; nothing to do." : `repair: ${broken} family(ies) need attention.`);
	return 0;
}

/**
 * `--contact-sheet`: writes the review artefact on its own.
 *
 * The sheet is part of the normal build output and `--check` covers it, in the
 * same discipline as `ATTRIBUTION.md` - this mode exists so a reviewer can
 * regenerate and open it without rewriting the whole catalogue.
 */
function runContactSheet(): number {
	const { fullSheet, identities, files } = buildCatalogue();
	const html = files.get(CONTACT_SHEET_PATH);
	if (html === undefined) {
		throw new Error("buildThemes: the catalogue produced no contact sheet");
	}
	writeFileSync(CONTACT_SHEET_PATH, html, "utf8");
	const order = sheetOrder(fullSheet);
	console.log(`contact sheet: wrote ${CONTACT_SHEET_PATH.replace(`${REPO}/`, "")} with ${fullSheet.length} cards, ${identities.length} families measured.`);
	console.log(`               closest pair in the catalogue: ${order[0]?.key} | ${order[0]?.nearest} at D_owner ${(order[0]?.distance ?? 0).toFixed(2)}`);
	console.log("               Cards are sorted worst-first. The deuteranope grid is the one that decides.");
	return 0;
}

/**
 * `--self-test`: every suite under `primal/theme/synth/`, plus the catalogue-level
 * properties that need a built catalogue to state.
 *
 * There are no tests under `primal/` that the repository's own runner can see, so
 * this follows the `--check` / `--self-test` idiom the sibling files already use.
 */
function runSelfTest(propertyDraws: number): number {
	const suites: readonly { readonly name: string; readonly run: () => readonly string[] }[] = [
		{ name: "spec", run: runSpecTests },
		{ name: "ramp", run: runRampTests },
		{ name: "ground", run: runGroundTests },
		{ name: "distinct", run: runDistinctTests },
		{ name: "synthesise", run: runSynthesiseTests },
		{ name: "propose", run: runProposeTests },
		{ name: `property (${propertyDraws} draws over the whole spec box)`, run: () => runPropertyTests(propertyDraws) }
	];
	const failures: string[] = [];
	for (const suite of suites) {
		const found = suite.run();
		failures.push(...found);
		console.log(`  ${found.length === 0 ? "ok  " : "FAIL"}  ${suite.name} (${found.length} failing)`);
	}

	// The golden calibration: the eleven shipped families' D_owner matrix.
	const { identities, sheet, emitted } = buildCatalogue();
	const synthesisedKeys = new Set(sheet.map(entry => entry.key));
	const shipped = identities.filter(identity => !synthesisedKeys.has(identity.key));
	const calibration = checkShippedCalibration(shipped);
	failures.push(...calibration);
	console.log(`  ${calibration.length === 0 ? "ok  " : "FAIL"}  the pinned D_owner matrix of the ${shipped.length} pre-synthesiser families`);

	// Depth carries no identity. The design says D_owner(soft, hard) is 0.000 for
	// every family; this asserts it on the emitted themes rather than repeating it.
	let depthFailures = 0;
	for (const entry of sheet) {
		const depths = [...entry.themes.keys()];
		if (depths.length < 2) {
			continue;
		}
		const first = entry.themes.get(depths[0]);
		const last = entry.themes.get(depths[depths.length - 1]);
		if (first === undefined || last === undefined) {
			continue;
		}
		for (const token of ["editor.background", "editor.foreground"]) {
			if (first.colors?.[token] !== last.colors?.[token]) {
				failures.push(`buildThemes: ${entry.label} moves ${token} between depths, so depth is carrying identity`);
				depthFailures++;
			}
		}
	}
	console.log(`  ${depthFailures === 0 ? "ok  " : "FAIL"}  depth moves no identity colour in any synthesised family`);

	// Determinism over the SHIPPING families, which is the property the whole
	// design rests on: the build is a lookup, so the same spec must produce the
	// same bytes every time. The design asks for this as Part 4 of
	// `generateTheme.ts --check`; it cannot live there, because `synthesise.ts`
	// imports `expandSeed` from `generateTheme.ts` and the dependency would be a
	// cycle. It is the same assertion, made where it can be made.
	let nonDeterministic = 0;
	for (const spec of loadFamilies()) {
		for (const depth of spec.depths) {
			const first = synthesise(spec, depth, `Primal ${spec.name}`);
			const second = synthesise(spec, depth, `Primal ${spec.name}`);
			const same = first.ok && second.ok && JSON.stringify(first.value.seed) === JSON.stringify(second.value.seed);
			if (!same) {
				failures.push(`buildThemes: ${spec.name} @ ${depth} does not synthesise deterministically`);
				nonDeterministic++;
			}
		}
	}
	console.log(`  ${nonDeterministic === 0 ? "ok  " : "FAIL"}  every family in families.json synthesises to byte-identical seeds twice`);

	// Every synthesised theme, at every depth, validates with ZERO errors.
	let errorful = 0;
	for (const entry of emitted) {
		if (entry.synth === null) {
			continue;
		}
		const result = validate(entry.synth.theme);
		if (result.errors.length > 0) {
			failures.push(`buildThemes: ${entry.label} has ${result.errors.length} validator error(s)`);
			errorful++;
		}
	}
	const synthCount = emitted.filter(entry => entry.synth !== null).length;
	console.log(`  ${errorful === 0 ? "ok  " : "FAIL"}  all ${synthCount} synthesised theme(s) validate with zero errors`);

	for (const line of failures) {
		console.error(`    ${line}`);
	}
	if (failures.length > 0) {
		console.error(`\nbuildThemes: ${failures.length} failing assertion(s)`);
		return 1;
	}
	console.log("buildThemes --self-test: every suite passes.");
	return 0;
}

function numberAfter(argv: readonly string[], flag: string, fallback: number): number {
	const index = argv.indexOf(flag);
	if (index < 0 || index + 1 >= argv.length) {
		return fallback;
	}
	const value = Number(argv[index + 1]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function main(argv: readonly string[]): number {
	if (argv.includes("--survey")) {
		printSurvey(survey());
		return 0;
	}
	if (argv.includes("--self-test")) {
		return runSelfTest(numberAfter(argv, "--property-draws", 300));
	}
	if (argv.includes("--propose")) {
		return runPropose(numberAfter(argv, "--propose", 20000), numberAfter(argv, "--seed", 20260910));
	}
	if (argv.includes("--repair")) {
		return runRepair();
	}
	if (argv.includes("--contact-sheet")) {
		return runContactSheet();
	}

	const { emitted, vibes, files, sheet, identities } = buildCatalogue();

	if (argv.includes("--check")) {
		const differing = drift(files);
		if (differing.length > 0) {
			console.error("buildThemes: generated output does not match the working tree:");
			for (const path of differing) console.error(`  ${path.replace(`${REPO}/`, "")}`);
			console.error("Run `node --experimental-strip-types primal/theme/buildThemes.ts` to regenerate.");
			return 1;
		}
		console.log(`buildThemes: ${vibes.length + emitted.length} generated theme(s) match the working tree.`);
		return 0;
	}

	const removed = writeAll(files);
	reportVibes(vibes);
	reportEmitted(emitted);
	console.log("");
	reportSynthesised(sheet, identities);
	for (const path of removed) console.log(`removed orphaned theme ${path.replace(`${REPO}/`, "")}`);
	const synthesised = emitted.filter(entry => entry.synth !== null).length;
	console.log(
		`buildThemes: wrote ${vibes.length} original vibe(s), ${emitted.length - synthesised} theme(s) from ${CATALOGUE.length} corpus families ` +
		`and ${synthesised} synthesised theme(s) from ${sheet.length} families, ` +
		`plus package.json, package.nls.json, cgmanifest.json and ATTRIBUTION.md` +
		`${removed.length > 0 ? `, and removed ${removed.length} orphan(s)` : ""}.`
	);
	return 0;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error((error as Error).message);
		process.exit(2);
	}
}
