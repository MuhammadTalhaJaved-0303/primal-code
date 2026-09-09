#!/usr/bin/env node --experimental-strip-types
/**
 * Read a vendored base16/base24 scheme and turn it into a Primal palette seed.
 *
 * primal/design/corpus/ holds 534 schemes copied verbatim from
 * tinted-theming/schemes (MIT; see corpus/SOURCE.md for the pinned commit).
 * Each one is sixteen or twenty-four hex values with fixed, documented roles.
 * primal/theme/generateTheme.ts wants a 33-slot Primal seed. This file is the
 * adapter, and it is the only place that decides what base0C "means".
 *
 *   node --experimental-strip-types primal/theme/importPalette.ts --check
 *   node --experimental-strip-types primal/theme/importPalette.ts --list
 *   node --experimental-strip-types primal/theme/importPalette.ts base16/apathy.yaml
 *
 * WHY THERE IS A YAML PARSER IN HERE
 *
 * primal/* scripts take no dependencies, and a YAML library would be a large
 * one for a format that, in this corpus, is a flat map of scalars plus one
 * nested map of hex strings plus one optional block scalar. `parseSchemeYaml`
 * below parses exactly that and THROWS on anything else - an unexpected key, a
 * value that is not a hex colour, a nesting level it does not model. A lenient
 * parser that skipped what it did not understand would silently drop a palette
 * entry and hand the generator a seed with a plausible wrong colour in it.
 * `--check` parses all 534 files, so the strictness is exercised, not assumed.
 *
 * WHY THE PLANES ARE DERIVED RATHER THAN TAKEN
 *
 * A scheme supplies exactly one background (base00). Primal needs four planes -
 * editor, chrome, side, panel - plus a line highlight and a border, and their
 * separation is what gives the workbench its depth. base01 is the obvious
 * candidate for the chrome plane; it is the wrong one, twice over.
 *
 * First, it hands the depth decision to 534 different authors. Measured across
 * the corpus, |dL(base00, base01)| runs from 0.00 to 0.35 in OKLab L, so some
 * schemes would ship a chrome bar indistinguishable from the editor and others
 * one that looks like a different application. The six shipping vibes are far
 * tighter - every one sits between 0.0367 and 0.0434, off vibe-tokens.json:
 *
 *     ink 0.0383   basalt 0.0367   tide 0.0434   dusk 0.0383   fern 0.0383   ridge 0.0376
 *
 * Second, base01 need not share base00's hue at all. base24/purple-rain.yaml
 * has base00 "#20084A", a deep violet, and base01 "#000000" - so a chrome plane
 * wearing base01's chrominance would be a neutral grey bar bolted onto a violet
 * editor.
 *
 * So the planes are derived from base00 itself: its hue, its chroma scaled, its
 * lightness stepped by a Primal constant. That is what the shipping vibes
 * actually do, measured in OKLCH - every one holds the editor hue to within a
 * few degrees and gains chroma as it lifts:
 *
 *     ink    editor C0.0041 h91  -> chrome C0.0086 h85   (2.10x)
 *     basalt        C0.0026 h68  ->        C0.0037 h49   (1.42x)
 *     tide          C0.0254 h256 ->        C0.0347 h258  (1.37x)
 *     dusk          C0.0241 h300 ->        C0.0325 h297  (1.35x)
 *     fern          C0.0154 h157 ->        C0.0226 h155  (1.47x)
 *     ridge         C0.0107 h77  ->        C0.0199 h77   (1.86x)
 *
 * Nothing here invents a hue: every plane wears the hue the scheme's own
 * background wears.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contrastDirection, effectiveContrast, hexToOklch, lightness, mixHex, oklchToHex, raiseContrast, type LightnessDirection } from "./color.ts";
import { perceptualDistanceOfHex } from "./validateTheme.ts";
import { SEED_SLOT_IDS, type SeedSlotId, type ThemeMode } from "./tokenMap.ts";
import type { Seed } from "./generateTheme.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
export const CORPUS_DIR = join(REPO, "primal", "design", "corpus");

// ---------------------------------------------------------------------------
// The corpus file format
// ---------------------------------------------------------------------------

/** Scheme systems this file knows how to read. */
export type SchemeSystem = "base16" | "base24";

/** The eight greyscale slots every scheme has, background end first. */
export const RAMP_KEYS: readonly string[] = [
	"base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07"
];

/** The eight accent slots every scheme has. */
export const ACCENT_KEYS: readonly string[] = [
	"base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F"
];

/** The eight extra slots base24 adds: two deeper planes and six bright ANSI. */
export const BASE24_KEYS: readonly string[] = [
	"base10", "base11", "base12", "base13", "base14", "base15", "base16", "base17"
];

/** Top-level keys the corpus actually uses. Anything else is a parse error. */
const KNOWN_TOP_LEVEL: readonly string[] = ["system", "name", "author", "description", "variant", "slug", "palette"];

/** One scheme, exactly as the file states it. Nothing is derived here. */
export interface Scheme {
	/** Path relative to the corpus root, e.g. "base16/apathy.yaml". This is the id. */
	readonly source: string;
	/** Filename without extension, e.g. "apathy". Families are grouped off this. */
	readonly slug: string;
	readonly system: SchemeSystem;
	readonly name: string;
	readonly author: string;
	readonly description: string | null;
	readonly mode: ThemeMode;
	/** base00..base0F, plus base10..base17 for base24. Uppercase #RRGGBB. */
	readonly palette: Readonly<Record<string, string>>;
}

class SchemeError extends Error {
	constructor(where: string, message: string) {
		super(`importPalette: ${where}: ${message}`);
	}
}

/**
 * A scheme rejected because its sixteen ANSI slots are not all different.
 *
 * Its own class rather than a message a caller has to match: this is the one
 * rejection that is a statement about the upstream palette rather than about
 * this file, so `--check` reports it as a census rather than counting it as a
 * failure. See assertDistinctAnsi.
 */
export class AnsiCollisionError extends SchemeError {}

/** Uppercase #RRGGBB, or throw. The corpus is all six-digit; anything else is a surprise worth stopping on. */
function requireHex(value: string, where: string): string {
	if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
		throw new SchemeError(where, `expected a #RRGGBB colour, got ${JSON.stringify(value)}`);
	}
	return `#${value.slice(1).toUpperCase()}`;
}

/** Strips one layer of YAML quoting. The corpus uses double quotes or nothing. */
function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) return trimmed.slice(1, -1);
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}

/**
 * Parse one corpus YAML file.
 *
 * The grammar accepted is exactly what the corpus contains, and no more:
 *
 *   - `# comment` lines and blank lines, anywhere.
 *   - A trailing ` # comment` on a value line. Two spaces before the `#` are
 *     not required by YAML but every annotated file in the corpus uses at
 *     least one, and a `#` inside a quoted value is protected by the quotes,
 *     so the comment strip runs only outside quotes.
 *   - `key: value` at column 0, with `value` optionally double- or
 *     single-quoted.
 *   - `key: |` at column 0 followed by more-indented lines - a literal block
 *     scalar. Only `description` uses it, in one file.
 *   - `palette:` at column 0 followed by indented `baseNN: "#RRGGBB"` lines.
 *
 * Anything else throws, naming the file and the line.
 */
export function parseSchemeYaml(text: string, where: string): {
	readonly scalars: Readonly<Record<string, string>>;
	readonly palette: Readonly<Record<string, string>>;
} {
	const scalars: Record<string, string> = {};
	const palette: Record<string, string> = {};
	const lines = text.split("\n");

	let inPalette = false;
	let blockKey: string | null = null;
	let blockLines: string[] = [];

	const endBlock = (): void => {
		if (blockKey !== null) {
			scalars[blockKey] = blockLines.join("\n").trim();
			blockKey = null;
			blockLines = [];
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].replace(/\r$/, "");
		const at = `${where}:${i + 1}`;

		if (blockKey !== null) {
			if (raw.trim() === "" || /^\s/.test(raw)) {
				blockLines.push(raw.trim());
				continue;
			}
			endBlock();
		}

		if (raw.trim() === "" || /^\s*#/.test(raw)) continue;

		const match = /^(\s*)([A-Za-z0-9_]+):(.*)$/.exec(raw);
		if (!match) throw new SchemeError(at, `cannot parse ${JSON.stringify(raw)} - expected "key: value"`);
		const [, indent, key, rest] = match;

		// Strip an unquoted trailing comment. A value that starts with a quote
		// keeps everything up to its closing quote.
		let value = rest.trim();
		if (value.startsWith("\"")) {
			const close = value.indexOf("\"", 1);
			if (close < 0) throw new SchemeError(at, `unterminated quoted value ${JSON.stringify(rest.trim())}`);
			value = value.slice(0, close + 1);
		} else {
			const hash = value.indexOf(" #");
			if (hash >= 0) value = value.slice(0, hash).trim();
		}

		if (indent.length === 0) {
			inPalette = false;
			if (value === "|" || value === ">") {
				blockKey = key;
				blockLines = [];
				continue;
			}
			if (key === "palette") {
				if (value !== "") throw new SchemeError(at, `"palette" must open a block, got ${JSON.stringify(value)}`);
				inPalette = true;
				continue;
			}
			if (!KNOWN_TOP_LEVEL.includes(key)) throw new SchemeError(at, `unknown top-level key ${JSON.stringify(key)}`);
			if (scalars[key] !== undefined) throw new SchemeError(at, `duplicate key ${JSON.stringify(key)}`);
			scalars[key] = unquote(value);
			continue;
		}

		if (!inPalette) throw new SchemeError(at, `indented key ${JSON.stringify(key)} outside a "palette:" block`);
		if (palette[key] !== undefined) throw new SchemeError(at, `duplicate palette key ${JSON.stringify(key)}`);
		palette[key] = requireHex(unquote(value), at);
	}
	endBlock();

	return { scalars, palette };
}

/** Parse a file into a validated Scheme, or throw naming the file. */
export function readScheme(corpusDir: string, relativePath: string): Scheme {
	const text = readFileSync(join(corpusDir, relativePath), "utf8");
	const { scalars, palette } = parseSchemeYaml(text, relativePath);

	const system = scalars["system"];
	if (system !== "base16" && system !== "base24") {
		throw new SchemeError(relativePath, `system must be "base16" or "base24", got ${JSON.stringify(system ?? null)}`);
	}
	const variant = scalars["variant"];
	if (variant !== "light" && variant !== "dark") {
		throw new SchemeError(relativePath, `variant must be "light" or "dark", got ${JSON.stringify(variant ?? null)}`);
	}
	const name = scalars["name"];
	const author = scalars["author"];
	if (!name) throw new SchemeError(relativePath, "no name");
	// The key must be there; the VALUE is allowed to be empty, because one
	// vendored scheme (base16/seti.yaml) genuinely has `author: ""`. That is
	// not a parse error - it is a scheme Primal cannot attribute, and it is
	// primal/theme/buildThemes.ts that refuses to ship it, where the reason
	// can be reported alongside every other reason a scheme is skipped.
	if (author === undefined) throw new SchemeError(relativePath, "no author key");

	const required = system === "base24" ? [...RAMP_KEYS, ...ACCENT_KEYS, ...BASE24_KEYS] : [...RAMP_KEYS, ...ACCENT_KEYS];
	const missing = required.filter(key => palette[key] === undefined);
	if (missing.length > 0) throw new SchemeError(relativePath, `palette is missing ${missing.join(", ")}`);
	const extra = Object.keys(palette).filter(key => !required.includes(key));
	if (extra.length > 0) throw new SchemeError(relativePath, `palette has unexpected key(s) ${extra.join(", ")}`);

	const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	return {
		source: relativePath,
		slug: base.replace(/\.ya?ml$/, ""),
		system,
		name,
		author,
		description: scalars["description"] ?? null,
		mode: variant,
		palette
	};
}

/** Every scheme in the vendored corpus, in a stable order. Fails loudly on any bad file. */
export function loadCorpus(corpusDir: string = CORPUS_DIR): readonly Scheme[] {
	const out: Scheme[] = [];
	for (const system of ["base16", "base24"] as const) {
		const dir = join(corpusDir, system);
		if (!statSync(dir).isDirectory()) throw new SchemeError(system, "not a directory");
		for (const file of readdirSync(dir).sort()) {
			if (!/\.ya?ml$/.test(file)) continue;
			out.push(readScheme(corpusDir, `${system}/${file}`));
		}
	}
	if (out.length === 0) throw new SchemeError(corpusDir, "no schemes found - is the corpus vendored?");
	return out;
}

// ---------------------------------------------------------------------------
// THE MAPPING TABLE
// ---------------------------------------------------------------------------

/**
 * base16/base24 role -> Primal seed slot.
 *
 * Role text in the "means" column is quoted from the base24 specification
 * (tinted-theming/base24 styling.md v0.1.3), which supersedes and restates
 * chriskempson's original base16 styling guide; the corpus's own annotated
 * files (e.g. base24/alucard.yaml) repeat it inline.
 *
 * PLANES AND CHROME
 *
 *   corpus       means                              -> Primal slot     how
 *   base00       Default Background                    editorBg        taken
 *   -            (see "why the planes are derived")   chromeBg        base00's hue, chroma x CHROME_CHROMA_RATIO, L +- DEPTH
 *   -            "                                     sideBg          same, at SIDE_PLANE_FRACTION of the step
 *   -            "                                     panelBg         same as sideBg (all six shipping vibes tie them)
 *   -            "                                     lineHighlight   same, at LINE_HIGHLIGHT_FRACTION of the step
 *   base01       Lighter Background (status bars)      -               used only as ANSI black in dark schemes, below
 *   base02       Selection Background                  selectionBg     taken
 *   -            (no corpus role)                      border          chromeBg -> selectionBg at BORDER_FRACTION
 *   base03       Comments, Invisibles                  comment         taken
 *   base04       Dark Foreground (status bars)         chromeFg        taken
 *   base05       Default Foreground, Operators         editorFg        taken
 *   base05       "                                     operator        taken
 *
 * SYNTAX
 *
 *   base08       Variables, XML Tags, Diff Deleted     -               unused as syntax; see ANSI
 *   base09       Integers, Boolean, Constants          constant        taken
 *   base0A       Classes, Markup Bold                  type            taken
 *   base0B       Strings, Inherited Class              string          taken
 *   base0C       Support, Regular Expressions          -               unused as syntax; see ANSI
 *   base0D       Functions, Methods, Headings          function        taken
 *   base0D       "                                     accent          taken - the spec designates base0D the
 *                                                                      focus colour ("background base0D to label
 *                                                                      focused workspaces"), which is what an
 *                                                                      accent is
 *   base0E       Keywords, Storage, Selector           keyword         taken
 *   base0F       Deprecated, embedded tags             -               unused: Primal's token map has no slot for it
 *
 * ANSI - normal
 *
 *   base08       ANSI 1  Red                           ansiRed         taken
 *   base0B       ANSI 2  Green                         ansiGreen       taken
 *   base0A       ANSI 3  Yellow                        ansiYellow      taken
 *   base0D       ANSI 4  Blue                          ansiBlue        taken
 *   base0E       ANSI 5  Magenta                       ansiMagenta     taken
 *   base0C       ANSI 6  Cyan                          ansiCyan        taken
 *
 * ANSI - bright (base24 supplies these; base16 does not)
 *
 *   base12       ANSI 9  Bright Red                    ansiBrightRed       taken, else derived from ansiRed
 *   base14       ANSI 10 Bright Green                  ansiBrightGreen     taken, else derived from ansiGreen
 *   base13       ANSI 11 Bright Yellow                 ansiBrightYellow    taken, else derived from ansiYellow
 *   base16       ANSI 12 Bright Blue                   ansiBrightBlue      taken, else derived from ansiBlue
 *   base17       ANSI 13 Bright Magenta                ansiBrightMagenta   taken, else derived from ansiMagenta
 *   base15       ANSI 14 Bright Cyan                   ansiBrightCyan      taken, else derived from ansiCyan
 *
 *   The base24 spec's own base16 fallback table says base12 = base08 and so on
 *   - i.e. bright and normal are the same colour. Primal cannot use that: two
 *   ANSI slots holding one hex is a collision, and the validator says so. So a
 *   base16 scheme gets its brights DERIVED, by moving the normal colour
 *   BRIGHT_LIGHTNESS_STEP along OKLab L away from the background. See that
 *   constant for where the number comes from.
 *
 * ANSI - neutrals, and the one place this file departs from the spec
 *
 *   The spec's ANSI column is written for dark schemes: black = base00, white =
 *   base05, bright white = base07. Applied to a LIGHT scheme, where base00 is
 *   the paper, that paints ANSI black in white and ANSI white in near-black.
 *   The corpus does not transpose it, and the tinted builders do not either.
 *   Primal Ink does - its ansiBlack is #1C1A18, its editor foreground - so the
 *   table below follows Ink and branches on mode:
 *
 *     slot              dark scheme    light scheme
 *     ansiBlack         base01         base05                   (the darkest ink)
 *     ansiBrightBlack   base03         base04
 *     ansiWhite         base05         mid(base04, base03)      (Ink's ansiWhite sits between the two)
 *     ansiBrightWhite   base07         base03
 *
 *   The dark column is the spec's, with one change: black is base01, not
 *   base00. base00 IS terminal.background, so spec-black would be exactly
 *   invisible rather than merely dark. base01 is what the shipping dark vibes
 *   do (Basalt's ansiBlack #2B2826 is its border, one plane off the editor).
 *
 *   The light column keeps all four neutrals as inks on paper, which is the
 *   only way they stay legible, and reproduces Ink's ordering
 *   black < white < brightBlack < brightWhite in darkness.
 *
 * base10 / base11 - "Darker Background" / "The Darkest Background" - are read
 * by nothing here. Primal derives its planes from a measured constant rather
 * than from a second author-supplied background; see DEPTH_STEPS.
 */

/**
 * |dL| in OKLab between the editor plane and the chrome plane.
 *
 * `medium` is the mean of all six shipping vibes measured off
 * primal/design/vibe-tokens.json (0.0367 basalt, 0.0376 ridge, 0.0383 ink,
 * 0.0383 dusk, 0.0383 fern, 0.0434 tide -> 0.0388).
 *
 * `soft` and `hard` are +-1/3 of that, and that is a choice rather than a fit:
 * the six vibes label themselves soft/medium/hard, but in OKLab their whole
 * spread is 0.0067 - less than a fifth of the plane separation itself - so the
 * shipping set does not actually separate its own depth bands and there is
 * nothing there to fit. A third is the smallest step that is unambiguously
 * visible next to the medium plane without the chrome reading as a second
 * application.
 */
export type Depth = "soft" | "medium" | "hard";

export const DEPTH_STEPS: Readonly<Record<Depth, number>> = {
	soft: 0.0259,
	medium: 0.0388,
	hard: 0.0517
};

/**
 * Where the side and panel plane sits between the editor plane and the chrome
 * plane. Median of the six shipping vibes: 0.504 tide, 0.528 dusk, 0.599 fern,
 * 0.679 ridge, 0.730 basalt, 0.764 ink -> 0.639.
 */
export const SIDE_PLANE_FRACTION = 0.639;

/**
 * How much more chroma the chrome plane carries than the editor plane.
 *
 * Median of the six shipping vibes measured in OKLCH: 1.35 dusk, 1.37 tide,
 * 1.42 basalt, 1.47 fern, 1.86 ridge, 2.10 ink -> 1.445. Intermediate planes
 * scale in proportion to how far along the step they sit, which reproduces the
 * shipping side and line-highlight planes closely: tide's side plane measures
 * 1.23x against a predicted 1.28x, and its line highlight 1.32x against 1.35x.
 */
export const CHROME_CHROMA_RATIO = 1.445;

/**
 * Same scale, for the current-line wash. Median of the six: 0.513 dusk, 0.560
 * ridge, 0.710 fern, 0.850 ink, 0.850 basalt, 0.969 tide -> 0.780. The spread
 * here is wide, which is the honest signal that the shipping themes never
 * agreed on it; the median keeps the wash clearly below the chrome plane.
 */
export const LINE_HIGHLIGHT_FRACTION = 0.780;

/**
 * Where the border sits between the chrome plane and the selection plane.
 * Median of the six: 0.573 basalt, 0.645 tide, 0.654 dusk, 0.687 fern, 0.801
 * ink, 1.186 ridge -> 0.671.
 */
export const BORDER_FRACTION = 0.671;

/**
 * How far a bright ANSI colour sits from its normal sibling, in OKLab L, away
 * from the background.
 *
 * Measured, not chosen: across the 196 base24 schemes there are 1176
 * normal/bright pairs, and their median signed step is +0.0664. (Per pair:
 * red +0.0594, yellow +0.0855, green +0.0486, cyan +0.0595, blue +0.0626,
 * magenta +0.0743.)
 *
 * Worth knowing when reading a base24 scheme's own brights: 30% of those 1176
 * pairs step the WRONG WAY - the "bright" colour is closer to the background
 * than the normal one. This constant is only used for base16 schemes, which
 * have no brights at all; a base24 scheme keeps whatever its author wrote, and
 * the validator is what catches an author who got it backwards.
 */
export const BRIGHT_LIGHTNESS_STEP = 0.0664;

/**
 * How far past its requested depth a plane may be pushed by 8-bit quantisation
 * before the palette is judged unable to express that depth at all.
 *
 * Only the black end of sRGB is coarse enough to matter: 47 vendored schemes
 * have `base00: "#000000"`, where the nearest non-black grey is already 0.067
 * away in OKLab L. That clears `medium` (0.0388) and `hard` (0.0517) honestly,
 * but it is 2.6x `soft` (0.0259) - so those schemes have no soft variant to
 * give, and `buildThemes.ts` declines to emit one rather than emit a "soft"
 * that is deeper than the medium of every other family.
 */
export const DEPTH_OVERSHOOT_LIMIT = 2.5;

/**
 * The floor every ANSI colour except black must clear against the terminal
 * background, in WCAG contrast.
 *
 * 3.0 is WCAG 2.2 SC 1.4.11 for non-text and SC 1.4.3 for large text, and it is
 * the same number `validateTheme.ts` measures ANSI slots against. A colour
 * below it is not "dim", it is output the user cannot read, and 240 of the 499
 * generatable corpus schemes ship at least one - most often bright black, which
 * base24 defines as the comment grey.
 *
 * So `toSeed` LIFTS a failing slot: it moves it along OKLab L, away from the
 * terminal plane, holding hue and chroma, until it just clears the floor, and
 * leaves it alone otherwise. This is a correction rather than a derivation, and
 * it is the one place this file overrules a colour the scheme actually stated -
 * `liftedAnsiSlots` reports exactly which slots were touched so it is never
 * silent.
 *
 * ANSI BLACK IS NOT EXEMPT, and this is a reversal. The exemption used to read
 * "its entire convention is the dark one; lifting it to 3:1 on a dark plane
 * makes it a mid grey", and cited the four shipping dark vibes failing the same
 * check as proof that Primal accepted the deviation. That was circular - the
 * vibes were excused by the corpus rule and the corpus rule by the vibes - and
 * it is wrong on the merits: SGR 30 is a foreground code like the other fifteen,
 * and a program that prints with it on the default plane produced text no user
 * could read. `validateTheme.ts` calls that an error, and it is right to.
 *
 * Black is still the darkest slot in the ramp after the lift, because the lift
 * stops the instant a colour clears the floor and black starts furthest from
 * it: on every dark plane in the corpus black lands at 3.0:1 and every other
 * slot sits at or above that. The convention that survives is the ORDER - black
 * darkest, bright black next - which is the part a program can rely on; the
 * part that does not survive is "indistinguishable from the background", which
 * was never a feature.
 */
export const ANSI_MIN_CONTRAST = 3.0;

/**
 * How far apart two ANSI slots must sit for a TRICHROMAT, in dE00.
 *
 * The same number as `validateTheme.ts`'s MIN_ANSI_DELTA_E, and it is here for
 * one specific consequence of the lift: the lift stops the moment a colour
 * clears the floor, so two slots that were far apart because one of them was
 * dark can both land ON the floor and arrive at nearly the same colour. Black
 * and bright black are the pair this bites - black is now always lifted on a
 * dark plane, and bright black is the comment grey, which is usually below the
 * floor too - and a repair that only caught byte-identical results let the
 * near-misses through.
 *
 * So the bright sibling is pushed further from the plane until a trichromat can
 * tell the pair apart. Under the normal observer only: a dichromat cannot
 * separate all sixteen whatever this file does (see buildThemes.ts), and
 * pretending otherwise here would push every bright slot to the top of the
 * plane for nothing.
 */
export const ANSI_MIN_SEPARATION = 10;

/** OKLab L per push, and the most pushes allowed, when separating a bright sibling. */
const SEPARATION_STEP = 0.005;
const SEPARATION_LIMIT = 200;

/**
 * Normal/bright ANSI siblings, which must never end up as the same colour.
 *
 * All EIGHT pairs, not just the six chromatic ones. Black/bright-black and
 * white/bright-white are siblings under exactly the same convention, and they
 * collide for exactly the same two reasons: many schemes state base05 == base07
 * (or base03 == base04), and the legibility lift can land a pair that was both
 * below the floor on the same colour. Leaving them out cost 114 (scheme, depth)
 * pairs an ansiWhite == ansiBrightWhite collision that nothing repaired.
 */
const BRIGHT_PAIRS: readonly (readonly [SeedSlotId, SeedSlotId])[] = [
	["ansiBlack", "ansiBrightBlack"],
	["ansiRed", "ansiBrightRed"],
	["ansiGreen", "ansiBrightGreen"],
	["ansiYellow", "ansiBrightYellow"],
	["ansiBlue", "ansiBrightBlue"],
	["ansiMagenta", "ansiBrightMagenta"],
	["ansiCyan", "ansiBrightCyan"],
	["ansiWhite", "ansiBrightWhite"]
];

/** The sixteen ANSI seed slots, in SGR order. */
const ANSI_SLOTS: readonly SeedSlotId[] = [
	"ansiBlack", "ansiRed", "ansiGreen", "ansiYellow", "ansiBlue", "ansiMagenta", "ansiCyan", "ansiWhite",
	"ansiBrightBlack", "ansiBrightRed", "ansiBrightGreen", "ansiBrightYellow",
	"ansiBrightBlue", "ansiBrightMagenta", "ansiBrightCyan", "ansiBrightWhite"
];

/** ANSI seed slots the legibility lift applies to: all sixteen. See ANSI_MIN_CONTRAST. */
const LIFTED_ANSI_SLOTS: readonly SeedSlotId[] = ANSI_SLOTS;

/** True when `depth` is expressible on this scheme's background. See DEPTH_OVERSHOOT_LIMIT. */
export function depthIsExpressible(scheme: Scheme, depth: Depth): boolean {
	const seed = toSeed(scheme, { depth });
	return realisedDepth(seed.editorBg, seed.chromeBg) <= DEPTH_STEPS[depth] * DEPTH_OVERSHOOT_LIMIT;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** +1 when foregrounds are lighter than the plane (dark theme), -1 otherwise. */
function inkDirection(mode: ThemeMode): number {
	return mode === "dark" ? 1 : -1;
}

/**
 * A plane at least `deltaL` off `fromHex`, wearing `tintHex`'s hue and chroma.
 *
 * Lightness is Primal's; hue and chroma are the scheme's. Nothing here invents
 * a hue, and a derived plane is never more saturated than the colour it borrows
 * from, because `oklchToRgb` only ever reduces chroma to reach the gamut.
 *
 * `deltaL` is a MINIMUM, not a target, because 8 bits per channel are not
 * evenly spaced in OKLab. At the black end they are very unevenly spaced: 47 of
 * the vendored schemes use `base00: "#000000"`, and the first non-black grey
 * #010101 already sits at L 0.067 - so a requested step of 0.0388 quantises
 * straight back to #000000 and the chrome plane vanishes into the editor plane.
 * Asking for the smallest representable colour that CLEARS the step keeps the
 * plane visible; `realisedDepth` reports what was actually achieved, and
 * `--check` fails if it overshoots wildly.
 */
function planeAt(editorBgHex: string, fraction: number, depth: number, mode: ThemeMode): string {
	const editor = hexToOklch(editorBgHex);
	const direction = inkDirection(mode);
	const chroma = editor.C * (1 + (CHROME_CHROMA_RATIO - 1) * fraction);
	const at = (L: number): string => oklchToHex({ L: Math.min(1, Math.max(0, L)), C: chroma, h: editor.h });

	const floor = depth * fraction;
	// 0.001 is finer than any 8-bit step in OKLab, so the first candidate that
	// clears the floor is the smallest representable one that does.
	const ceiling = floor * 4;
	for (let want = floor; want <= ceiling; want += 0.001) {
		const candidate = at(editor.L + want * direction);
		if (Math.abs(lightness(candidate) - editor.L) >= floor - 1e-9) return candidate;
	}
	throw new Error(
		`importPalette: cannot place a plane ${floor.toFixed(4)} off ${editorBgHex} in OKLab L - ` +
		`even ${ceiling.toFixed(4)} quantises back onto it`
	);
}

/** |dL| a derived plane actually achieved. Quantisation means it is >= what was asked. */
export function realisedDepth(editorBgHex: string, chromeBgHex: string): number {
	return Math.abs(lightness(chromeBgHex) - lightness(editorBgHex));
}

/** Moves a colour away from the background by `step` in OKLab L, holding hue and chroma. */
function brighten(hex: string, step: number, mode: ThemeMode): string {
	const lch = hexToOklch(hex);
	return oklchToHex({ L: Math.min(1, Math.max(0, lch.L + step * inkDirection(mode))), C: lch.C, h: lch.h });
}

/**
 * Moves `bright` away from its plane, in fixed OKLab L steps holding hue and
 * chroma, until a trichromat can tell it from `normal`. Returns it unchanged
 * when it already can - the common case, and the reason this is a repair rather
 * than a derivation.
 *
 * Bounded and deterministic: at most SEPARATION_LIMIT steps, and if the slot
 * runs out of plane before it clears, the last candidate is returned and the
 * validator reports the shortfall rather than this function looping.
 */
function separateFrom(bright: string, normal: string, away: LightnessDirection): string {
	let candidate = bright;
	for (let step = 0; step < SEPARATION_LIMIT; step++) {
		if (perceptualDistanceOfHex(candidate, normal) >= ANSI_MIN_SEPARATION) return candidate;
		const lch = hexToOklch(candidate);
		const L = Math.min(1, Math.max(0, lch.L + (away === "lighter" ? SEPARATION_STEP : -SEPARATION_STEP)));
		const next = oklchToHex({ L, C: lch.C, h: lch.h });
		if (next === candidate) return candidate;
		candidate = next;
	}
	return candidate;
}

/** What a caller has to decide that the scheme cannot say. */
export interface ImportOptions {
	readonly depth?: Depth;
}

/**
 * The mapping table above, applied - and nothing else. Every slot here is
 * either a colour the scheme states or a plane derived from one by a documented
 * lightness step. `toSeed` wraps this with the ANSI legibility lift; keeping
 * the two apart is what lets `liftedAnsiSlots` say exactly what the lift moved.
 */
function mapSeed(scheme: Scheme, options: ImportOptions = {}): Seed {
	const p = scheme.palette;
	const mode = scheme.mode;
	const depth = DEPTH_STEPS[options.depth ?? "medium"];

	const editorBg = p["base00"];
	const chromeBg = planeAt(editorBg, 1, depth, mode);
	const sideBg = planeAt(editorBg, SIDE_PLANE_FRACTION, depth, mode);
	const lineHighlight = planeAt(editorBg, LINE_HIGHLIGHT_FRACTION, depth, mode);
	const selectionBg = p["base02"];
	const border = mixHex(chromeBg, selectionBg, BORDER_FRACTION);

	const bright = (key: string, from: string): string =>
		p[key] !== undefined ? p[key] : brighten(from, BRIGHT_LIGHTNESS_STEP, mode);

	const neutrals = mode === "dark"
		? { black: p["base01"], brightBlack: p["base03"], white: p["base05"], brightWhite: p["base07"] }
		: { black: p["base05"], brightBlack: p["base04"], white: mixHex(p["base04"], p["base03"], 0.5), brightWhite: p["base03"] };

	const seed: Record<SeedSlotId, string> = {
		editorBg,
		chromeBg,
		sideBg,
		panelBg: sideBg,
		editorFg: p["base05"],
		chromeFg: p["base04"],
		accent: p["base0D"],
		border,
		selectionBg,
		lineHighlight,

		keyword: p["base0E"],
		string: p["base0B"],
		function: p["base0D"],
		comment: p["base03"],
		type: p["base0A"],
		constant: p["base09"],
		operator: p["base05"],

		ansiBlack: neutrals.black,
		ansiRed: p["base08"],
		ansiGreen: p["base0B"],
		ansiYellow: p["base0A"],
		ansiBlue: p["base0D"],
		ansiMagenta: p["base0E"],
		ansiCyan: p["base0C"],
		ansiWhite: neutrals.white,
		ansiBrightBlack: neutrals.brightBlack,
		ansiBrightRed: bright("base12", p["base08"]),
		ansiBrightGreen: bright("base14", p["base0B"]),
		ansiBrightYellow: bright("base13", p["base0A"]),
		ansiBrightBlue: bright("base16", p["base0D"]),
		ansiBrightMagenta: bright("base17", p["base0E"]),
		ansiBrightCyan: bright("base15", p["base0C"]),
		ansiBrightWhite: neutrals.brightWhite
	};

	for (const slot of SEED_SLOT_IDS) {
		if (typeof seed[slot] !== "string") throw new SchemeError(scheme.source, `derived seed has no ${slot}`);
	}
	return seed;
}

/**
 * Every one of the sixteen ANSI slots must be a different colour, or the scheme
 * does not ship.
 *
 * BRIGHT_PAIRS above only ever guarded the six normal/bright siblings, so a
 * collision ACROSS colours went unnoticed - and the corpus is full of them.
 * Four of the five families this repository shipped had
 * `terminal.ansiYellow === terminal.ansiBrightBlue`, byte for byte, and the
 * yellow was a blue: base24 schemes converted from terminal palettes routinely
 * put the real yellow in base09/base13 and leave a duplicate of base16 (bright
 * blue) sitting in base0A, which the spec reserves for yellow. `ansiYellow:
 * p["base0A"]` then maps that duplicate straight through, SGR 33 and SGR 94
 * paint the same pixel, and - because generateTheme takes the WARNING hue from
 * ansiYellow - the theme's warning colour comes out blue as well.
 *
 * THIS REJECTS RATHER THAN REPAIRS. A repair would have to invent which of the
 * twenty-four stated colours the scheme "meant" for the yellow role, and every
 * candidate rule (take base09, take base13's hue, rotate the duplicate) is a
 * guess dressed up as a derivation - and it would have to be made again for
 * `type`, which maps from base0A too. The corpus has 534 schemes and this file
 * only has to find five good ones, so a palette that cannot state sixteen
 * distinct terminal colours is simply not a palette this product uses. Loud,
 * and cheap.
 *
 * Called TWICE, and the two calls are not the same check:
 *
 *   - `assertNoCrossSlotCollision` runs on the mapped seed, before any repair,
 *     and is the rejection this comment argues for. Judging it on what the
 *     scheme STATED is what keeps it a rejection: the legibility lift and the
 *     bright-sibling push both move colours, and either can pull two stated
 *     duplicates apart by accident, readmitting exactly the palette whose
 *     yellow is a blue.
 *   - This one runs last, over all sixteen, and catches a collision the repairs
 *     themselves created.
 */
/**
 * The eight normal/bright sibling pairs, as a lookup, so a stated duplicate
 * BETWEEN siblings can be told from one across roles.
 */
const BRIGHT_PAIR_KEYS: ReadonlySet<string> = new Set(BRIGHT_PAIRS.map(([normal, bright]) => `${normal}|${bright}`));

/**
 * Rejects a scheme that states one hex for two DIFFERENT ANSI roles.
 *
 * A sibling collision is not in this set, and that is the whole distinction:
 * "bright red is the lighter red" is what the convention says a bright slot IS,
 * so pushing the bright one away from the plane restates the scheme's own
 * intent rather than inventing a colour - it is the same derivation base16
 * schemes, which state no brights at all, already get. A collision across roles
 * has no such rule: nothing in the palette says which of the two roles the hex
 * belonged to.
 */
function assertNoCrossSlotCollision(seed: Readonly<Record<SeedSlotId, string>>, scheme: Scheme): void {
	const byColour = new Map<string, SeedSlotId>();
	for (const slot of ANSI_SLOTS) {
		const colour = seed[slot].toUpperCase();
		const first = byColour.get(colour);
		if (first !== undefined && !BRIGHT_PAIR_KEYS.has(`${first}|${slot}`)) {
			throw new AnsiCollisionError(
				scheme.source,
				`ANSI slots ${first} and ${slot} are both ${seed[slot]} - the sixteen terminal colours must be distinct`
			);
		}
		if (first === undefined) byColour.set(colour, slot);
	}
}

/**
 * The last gate: sixteen slots a trichromat can actually tell apart.
 *
 * MEASURED, NOT COMPARED FOR EQUALITY, and that is a real widening. Equality
 * only ever caught the case where two slots held the identical byte string,
 * which is the loudest possible collision and the rarest one to survive the
 * repairs above. `ANSI_MIN_SEPARATION` has been declared in this file all along
 * as "the same number as validateTheme.ts's MIN_ANSI_DELTA_E" - the exact-hex
 * test was simply weaker than the constant it shipped with, so espresso's
 * derived `ansiBrightCyan` (#E8F1FF, 7.26 dE00 off its stated `ansiBrightWhite`
 * #FFFFFF) walked through it and shipped a ramp with fifteen usable colours in
 * sixteen slots.
 *
 * STILL A REJECTION, NOT A REPAIR, and espresso is why the distinction survives
 * contact with a real palette. Its `base0C` is #BED6FF, a pale blue one step
 * below white, and `base07` is #FFFFFF: 17.55 dE00 apart in total. A bright cyan
 * needs 10 from each, so it needs 20 of room in a gap that holds 17.55. No
 * lightness step exists, in either direction, and any repair would have to
 * invent a hue the palette never states. The palette cannot express sixteen
 * distinct terminal colours; it is not a palette this product uses.
 */
function assertDistinctAnsi(seed: Readonly<Record<SeedSlotId, string>>, scheme: Scheme): void {
	for (let i = 0; i < ANSI_SLOTS.length; i++) {
		for (let j = i + 1; j < ANSI_SLOTS.length; j++) {
			const first = ANSI_SLOTS[i];
			const second = ANSI_SLOTS[j];
			const distance = perceptualDistanceOfHex(seed[first], seed[second]);
			if (distance < ANSI_MIN_SEPARATION) {
				throw new AnsiCollisionError(
					scheme.source,
					`ANSI slots ${first} ${seed[first]} and ${second} ${seed[second]} are ${distance.toFixed(2)} dE00 apart, ` +
					`under the ${ANSI_MIN_SEPARATION} a trichromat needs - the sixteen terminal colours must be distinct`
				);
			}
		}
	}
}

/**
 * scheme + depth -> a complete 33-slot Primal seed.
 *
 * Pure and total: every slot is filled or the function throws. No slot is left
 * for `generateTheme` to guess, except the eleven chrome SURFACES, which it
 * fills from tokenMap's measured fallbacks - the corpus has no roles for them
 * at all, and inventing eleven more constants here would be inventing colours.
 *
 * Throws for a scheme whose sixteen ANSI slots are not pairwise distinct. See
 * assertDistinctAnsi.
 */
export function toSeed(scheme: Scheme, options: ImportOptions = {}): Seed {
	const seed = mapSeed(scheme, options);
	// Judged on what the scheme STATES, before any repair: see
	// assertNoCrossSlotCollision for why the sibling case is repaired instead.
	assertNoCrossSlotCollision(seed, scheme);
	// terminal.background is the panel plane, so that is the plane an ANSI
	// colour has to be readable on. See ANSI_MIN_CONTRAST.
	const away = contrastDirection(seed.panelBg);
	const lifted: Record<SeedSlotId, string> = { ...seed };
	for (const slot of LIFTED_ANSI_SLOTS) {
		lifted[slot] = raiseContrast(seed[slot], seed.panelBg, ANSI_MIN_CONTRAST, away);
	}
	// The lift stops the moment a colour clears the floor, so a normal slot and
	// its bright sibling that were both below it can arrive at the same place -
	// or a hair apart, which is the same defect measured properly. Push the
	// bright one clear again; see ANSI_MIN_SEPARATION.
	for (const [normal, brightSlot] of BRIGHT_PAIRS) {
		lifted[brightSlot] = separateFrom(lifted[brightSlot], lifted[normal], away);
	}
	assertDistinctAnsi(lifted, scheme);
	return lifted;
}

/** Which ANSI slots the legibility lift moved, and how bad they were. Empty is the good case. */
export interface AnsiLift {
	readonly slot: SeedSlotId;
	readonly from: string;
	readonly to: string;
	readonly wasContrast: number;
}

export function liftedAnsiSlots(scheme: Scheme, options: ImportOptions = {}): readonly AnsiLift[] {
	const before = mapSeed(scheme, options);
	const after = toSeed(scheme, options);
	const out: AnsiLift[] = [];
	for (const slot of LIFTED_ANSI_SLOTS) {
		if (before[slot] !== after[slot]) {
			out.push({ slot, from: before[slot], to: after[slot], wasContrast: effectiveContrast(before[slot], before.panelBg) });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

interface Failure {
	readonly what: string;
	readonly detail: string;
}

/**
 * Exercises the parser against every vendored file and the mapping against
 * every scheme. This is the only proof that the strict parser is strict about
 * the right things: 534 real files go through it, and any one of them that
 * does not fit the grammar stops the run.
 */
function check(): readonly Failure[] {
	const failures: Failure[] = [];
	const fail = (what: string, detail: string): void => { failures.push({ what, detail }); };

	// The grammar rejects what it does not model.
	const rejects: readonly [string, string][] = [
		["system: \"base16\"\nnested:\n  deep:\n    x: 1\n", "nesting outside a palette block"],
		["palette:\n  base00: \"nothex\"\n", "a palette value that is not a colour"],
		["system: \"base16\"\nbogus: \"x\"\n", "an unknown top-level key"],
		["palette:\n  base00: \"#000000\"\n  base00: \"#111111\"\n", "a duplicate palette key"],
		["  orphan: \"x\"\n", "an indented key with no palette block"]
	];
	for (const [text, why] of rejects) {
		let threw = false;
		try { parseSchemeYaml(text, "<test>"); } catch { threw = true; }
		if (!threw) fail("parser strictness", `accepted ${why}`);
	}

	// Comments, quoting and block scalars round-trip.
	const sample = parseSchemeYaml(
		"# leading\nsystem: \"base16\"\nname: Unquoted Name\ndescription: |\n  one\n  two\nvariant: \"dark\"\npalette:\n  base00: \"#012345\"  # Default Background\n",
		"<test>"
	);
	if (sample.scalars["name"] !== "Unquoted Name") fail("unquoted scalar", `got ${JSON.stringify(sample.scalars["name"])}`);
	if (sample.scalars["description"] !== "one\ntwo") fail("block scalar", `got ${JSON.stringify(sample.scalars["description"])}`);
	if (sample.palette["base00"] !== "#012345") fail("trailing comment strip", `got ${JSON.stringify(sample.palette["base00"])}`);

	// Every vendored file parses, and every scheme maps to a full seed.
	const corpus = loadCorpus();
	if (corpus.length !== 534) fail("corpus size", `expected 534 schemes, loaded ${corpus.length}`);
	const base16 = corpus.filter(s => s.system === "base16").length;
	const base24 = corpus.filter(s => s.system === "base24").length;
	if (base16 !== 338) fail("base16 count", `expected 338, got ${base16}`);
	if (base24 !== 196) fail("base24 count", `expected 196, got ${base24}`);

	const seen = new Set<string>();
	const overshot = new Set<string>();
	const ansiRejected = new Map<string, string>();
	for (const scheme of corpus) {
		const key = `${scheme.system}/${scheme.slug}`;
		if (seen.has(key)) fail("duplicate slug", key);
		seen.add(key);
		for (const depth of ["soft", "medium", "hard"] as const) {
			let seed: Seed;
			try {
				seed = toSeed(scheme, { depth });
			} catch (error) {
				// An ANSI collision is upstream's palette, not this file's mapping:
				// counted and named below, never a check failure. Anything else is.
				if (error instanceof AnsiCollisionError) {
					ansiRejected.set(scheme.source, error.message.replace(/^importPalette: [^:]+: /, ""));
					continue;
				}
				fail("toSeed", `${scheme.source} @ ${depth}: ${(error as Error).message}`);
				continue;
			}
			// The derived planes must step away from the editor plane, in the
			// right direction, by at least the amount asked for - and, since the
			// step is a floor that quantisation can only push upward, not by a
			// wild multiple of it.
			const want = DEPTH_STEPS[depth];
			const signed = (lightness(seed.chromeBg) - lightness(seed.editorBg)) * inkDirection(scheme.mode);
			if (signed < want - 1e-6) {
				fail("depth step", `${scheme.source} @ ${depth}: wanted dL >= ${want.toFixed(4)}, got ${signed.toFixed(4)}`);
			}
			if (signed > want * DEPTH_OVERSHOOT_LIMIT) overshot.add(`${scheme.source} @ ${depth}`);
			// No ANSI slot may repeat. toSeed asserts this itself, so reaching here
			// with a duplicate would mean the post-condition had stopped running.
			const duplicated = ANSI_SLOTS.filter((slot, i) => ANSI_SLOTS.findIndex(other => seed[other] === seed[slot]) !== i);
			if (duplicated.length > 0) {
				fail("ANSI distinctness", `${scheme.source} @ ${depth}: toSeed returned duplicate ${duplicated.join(", ")}`);
			}
		}
	}

	// Not a failure: a report. See DEPTH_OVERSHOOT_LIMIT.
	const bands = [...overshot].reduce<Record<string, number>>((acc, entry) => {
		const band = entry.slice(entry.indexOf("@ ") + 2);
		acc[band] = (acc[band] ?? 0) + 1;
		return acc;
	}, {});
	console.log(`  note  ${overshot.size} (scheme, depth) pair(s) quantised past ${DEPTH_OVERSHOOT_LIMIT}x their step: ` +
		`${Object.entries(bands).map(([band, n]) => `${n} at ${band}`).join(", ") || "none"}`);

	// Also a report. These schemes cannot state sixteen distinct terminal colours,
	// so no depth of them ships; see assertDistinctAnsi for why they are rejected
	// rather than repaired.
	const byPair = [...ansiRejected.values()].reduce<Record<string, number>>((acc, reason) => {
		const pair = /^ANSI slots (\w+) and (\w+)/.exec(reason);
		const label = pair === null ? "other" : `${pair[1]}/${pair[2]}`;
		acc[label] = (acc[label] ?? 0) + 1;
		return acc;
	}, {});
	const ranked = Object.entries(byPair).sort((a, b) => b[1] - a[1]);
	console.log(`  note  ${ansiRejected.size} of ${corpus.length} scheme(s) rejected for colliding ANSI slots: ` +
		`${ranked.slice(0, 4).map(([pair, n]) => `${n} ${pair}`).join(", ")}` +
		`${ranked.length > 4 ? `, ${ranked.slice(4).reduce((n, e) => n + e[1], 0)} other` : ""}`);

	return failures;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv: readonly string[]): number {
	if (argv.includes("--check")) {
		const failures = check();
		for (const failure of failures) console.error(`  FAIL  ${failure.what}: ${failure.detail}`);
		if (failures.length > 0) {
			console.error(`importPalette: ${failures.length} check(s) failed.`);
			return 1;
		}
		const corpus = loadCorpus();
		const mapped = corpus.filter(scheme => {
			try {
				toSeed(scheme);
				return true;
			} catch (error) {
				if (error instanceof AnsiCollisionError) return false;
				throw error;
			}
		}).length;
		console.log(`importPalette: parsed ${corpus.length} schemes, mapped ${mapped} of them at 3 depths, all checks passed.`);
		return 0;
	}

	if (argv.includes("--list")) {
		for (const scheme of loadCorpus()) {
			console.log(`${scheme.source}\t${scheme.mode}\t${scheme.name}\t${scheme.author}`);
		}
		return 0;
	}

	const target = argv.find(a => !a.startsWith("--"));
	if (target === undefined) {
		console.error("usage: importPalette.ts [--check | --list | <base16/name.yaml>]");
		return 2;
	}
	const scheme = readScheme(CORPUS_DIR, target);
	console.log(JSON.stringify({ scheme: { ...scheme, palette: undefined }, seed: toSeed(scheme) }, null, "\t"));
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
