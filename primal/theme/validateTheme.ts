#!/usr/bin/env node --experimental-strip-types
/**
 * Machine-validate a Primal colour theme before it is allowed to ship.
 *
 * primal/theme/tokenMap.ts turns a palette seed into ~449 workbench colours. Nobody
 * can eyeball 449 colours, and the person who would have to eyeball them is colour
 * blind - amber reads as green to him - so the one failure that matters most to this
 * product is invisible to its owner by definition. Hence this file: every check that
 * a human would otherwise have to make by looking, stated as a number.
 *
 *   node --experimental-strip-types primal/theme/validateTheme.ts            # the six shipping themes
 *   node --experimental-strip-types primal/theme/validateTheme.ts a.json b.json
 *   node --experimental-strip-types primal/theme/validateTheme.ts --json
 *
 * Exits non-zero if any theme has an error. Warnings never fail the run; they are
 * things worth knowing that are not, on their own, grounds to block a release.
 *
 * WHAT IS CHECKED, AND WHY EACH THRESHOLD IS WHAT IT IS - see the constants below.
 * Every finding names the token, the value measured, and the threshold it missed,
 * because a report that says "contrast too low" and nothing else cannot be acted on.
 *
 * Colour maths lives in this file rather than being imported because primal/* scripts
 * take no dependencies and this one must keep working if the generator is refactored.
 * CVD simulation is the exception: it is genuinely intricate, and it lives in
 * primal/theme/cvd.ts with its own self-test.
 *
 * The file is long, and most of that length is tables - which colours a user has to be
 * able to tell apart, which backgrounds get painted behind text - plus the argument for
 * every threshold. Splitting the tables out would only make a row harder to find; the
 * logic they feed is a few hundred lines. Same reasoning as primal/theme/tokenMap.ts.
 *
 * Verify the colour maths, including CIEDE2000 against the CIE's own published test
 * data, with:
 *
 *   node --experimental-strip-types primal/theme/validateTheme.ts --self-test
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CVD_TYPES, simulateCvd, srgbToLinear, type CvdType, type Rgb } from "./cvd.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPING_THEMES_DIR = join(ROOT, "extensions", "theme-primal", "themes");

// ---------------------------------------------------------------------------
// Thresholds. Each one is a claim about human vision, so each one is argued.
// ---------------------------------------------------------------------------

/**
 * WCAG 2.2 SC 1.4.3 (AA) for normal-size text. Editor body text is the surface a
 * user stares at all day; there is no argument for holding it below the published
 * floor for ordinary text.
 */
const MIN_EDITOR_TEXT_CONTRAST = 4.5;

/**
 * Comments get their own floor, lower than body text and enforced in two tiers.
 *
 * Comments are deliberately de-emphasised, and every theme author reaches for the
 * same trick - drop the comment colour towards the background until it stops
 * competing with code. That is the classic way a theme becomes unreadable, and it
 * happens gradually, so one hard number would either be permanently violated or
 * useless. So: below 3.0 is an error, because 3.0 is the WCAG floor for large text
 * (1.4.3) and for non-text contrast (1.4.11), and text below it is not readable at
 * any size; between 3.0 and 4.5 is a warning, because comments are in fact normal-
 * size text and 4.5 is what that text is owed.
 */
const MIN_COMMENT_CONTRAST_ERROR = 3.0;
const MIN_COMMENT_CONTRAST_WARN = 4.5;

/**
 * A selection or find-match highlight is drawn behind text the user is actively
 * reading - usually the exact text they went looking for. Drawing a box behind a
 * word does not make that word less important, so the normal-text floor applies
 * unchanged. Measured on the composite: alpha is flattened over the base first,
 * because that is what the eye receives.
 */
const MIN_HIGHLIGHTED_TEXT_CONTRAST = 4.5;

/**
 * Perceptual distance (CIEDE2000) at which two colours read as different colours
 * without being compared side by side.
 *
 * ~1.0 is a just-noticeable difference under ideal side-by-side viewing; ~2.3 is the
 * usual quoted JND for ordinary viewing. A user glancing at a squiggle or a gutter
 * bar has nothing to compare it against, so the floor is set roughly an order of
 * magnitude above JND.
 */
const MIN_SEMANTIC_DELTA_E = 11;

/**
 * The house rule, made measurable: semantic colours must be separated by LIGHTNESS,
 * not by hue alone. Lightness is the one channel a dichromat keeps intact, so a pair
 * that leans on hue passes for most users and fails for the owner.
 *
 * THE NUMBER IS NOT A CONSTANT, AND IT USED TO BE 8. That was wrong, and wrong in
 * the direction that made this warning useless: it stayed silent on exactly the
 * pairs whose separation error it was supposed to explain.
 *
 * CIEDE2000 divides the lightness term by SL = 1 + 0.015(Lbar-50)^2/sqrt(20+(Lbar-50)^2),
 * which is >= 1 for every Lbar and equals 1 only at Lbar = 50. So a pair separated by
 * lightness ALONE scores dL* / SL, which is at most dL* and usually less - 8 L* is worth
 * exactly 8.00 dE00 at Lbar 50 and less everywhere else: 7.69 at L* 50-58, 6.50 at
 * 30-38, 5.78 at 20-28. It can never reach the 11 the error above demands. A pair could therefore clear the
 * old 8 L* rule and still fail the error with no warning to say why, which is what
 * happened: diffEditor.insertedTextBackground #19B0F6 vs removedTextBackground
 * #21A36D fails at dE00 9.22 under tritanopia with dL* 8.41 and drew no warning.
 *
 * So the threshold is the dL* that actually delivers MIN_SEMANTIC_DELTA_E on its own
 * at the lightness the pair sits at: dL* >= MIN_SEMANTIC_DELTA_E * SL(Lbar). That is
 * 11.0 L* at Lbar 50, 14.2 at Lbar 30 or 70, and 15.9 at Lbar 20 or 80 - the dark and
 * light ends need more because SL grows there. By construction the warning now fires
 * on every pair the error can catch, and only on those, so it always explains rather
 * than sometimes contradicting.
 *
 * It stays a warning: the error that blocks a release is the measured post-simulation
 * distance. This is the design rule that says why that measurement failed.
 */
function requiredLightnessDelta(lBar: number): number {
	return MIN_SEMANTIC_DELTA_E * lightnessWeight(lBar);
}

/**
 * Contrast floor for a syntax colour that is not a comment.
 *
 * tokenColors is the surface a user actually stares at, and until this check existed
 * every scope but `comment` and six diff/severity scopes was unmeasured: a theme
 * could paint keywords at 1.19:1 on the editor plane and validate clean. It is
 * enforced in the same two tiers as comments, and for the same reason - syntax colour
 * is deliberately varied in emphasis, so one hard number would either be permanently
 * violated or useless. The tiers are calibrated on the six hand-authored shipping
 * vibes, which are the ground truth this engine reproduces: across their 186 syntax
 * rules NONE falls below 3.0 (the lowest is Dusk's comment at 3.24) and 15 sit
 * between 3.0 and 4.5. So 3.0 is a floor the product already holds and 4.5 is the
 * WCAG AA figure that normal-size text is owed but that de-emphasised syntax
 * routinely trades away.
 */
const MIN_SYNTAX_CONTRAST_ERROR = 3.0;
const MIN_SYNTAX_CONTRAST_WARN = 4.5;

/**
 * The 16-colour ANSI ramp is denser than the semantic palette by design - each
 * bright slot is meant to read as a brighter relative of its normal slot, not as an
 * unrelated colour - so it gets a slightly lower floor than semantic pairs. It is
 * still far above JND: programs colour their output on the assumption that all 16
 * slots are telling apart, and a ramp with two slots that collide silently loses
 * whatever meaning the program encoded in them.
 */
const MIN_ANSI_DELTA_E = 10;

/**
 * ANSI colours are text on the terminal background. 3.0 is the WCAG large-text and
 * non-text floor; below it, coloured terminal output stops being legible. Body-text
 * 4.5 is not demanded here because terminal colour is usually carrying emphasis on
 * top of text that is also readable in the default foreground.
 */
const MIN_ANSI_CONTRAST = 3.0;

/** Colour ids a theme cannot omit: every later check reads through one of them. */
const REQUIRED_TOKENS: readonly string[] = [
	"editor.background",
	"editor.foreground",
	"terminal.background",
];

/** A crawl that finds fewer ids than this has broken, rather than VS Code having shrunk. */
const MIN_PLAUSIBLE_REGISTRY_SIZE = 500;

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

/** An sRGB colour with straight (non-premultiplied) alpha, exactly as a theme writes it. */
interface Rgba {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

interface Lab {
	readonly l: number;
	readonly a: number;
	readonly b: number;
}

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Parse the colour syntax a VS Code theme may use: #RGB, #RGBA, #RRGGBB, #RRGGBBAA.
 * Returns null for anything else so the caller can report it as a bad value rather
 * than silently measure garbage.
 */
function parseColor(value: unknown): Rgba | null {
	if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
		return null;
	}
	const hex = value.slice(1);
	const expand = (short: string): number => parseInt(short + short, 16);
	if (hex.length === 3 || hex.length === 4) {
		return {
			r: expand(hex[0]),
			g: expand(hex[1]),
			b: expand(hex[2]),
			a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
		};
	}
	return {
		r: parseInt(hex.slice(0, 2), 16),
		g: parseInt(hex.slice(2, 4), 16),
		b: parseInt(hex.slice(4, 6), 16),
		a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
	};
}

function formatRgb(rgb: Rgb): string {
	const channel = (v: number): string => Math.round(v).toString(16).padStart(2, "0").toUpperCase();
	return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/** Flatten a translucent colour over an opaque base, the way a compositor would. */
function composite(over: Rgba, base: Rgb): Rgb {
	const a = over.a;
	return {
		r: over.r * a + base.r * (1 - a),
		g: over.g * a + base.g * (1 - a),
		b: over.b * a + base.b * (1 - a),
	};
}

function opaque(colour: Rgba): Rgb {
	return { r: colour.r, g: colour.g, b: colour.b };
}

/** WCAG 2.2 relative luminance. */
function relativeLuminance(rgb: Rgb): number {
	const r = srgbToLinear(Math.min(Math.max(rgb.r / 255, 0), 1));
	const g = srgbToLinear(Math.min(Math.max(rgb.g / 255, 0), 1));
	const b = srgbToLinear(Math.min(Math.max(rgb.b / 255, 0), 1));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio, 1..21. Order of arguments does not matter. */
function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Linear sRGB -> CIEXYZ (IEC 61966-2-1, D65). */
const XYZ_FROM_LINEAR_SRGB: ReadonlyArray<readonly [number, number, number]> = [
	[0.4124564, 0.3575761, 0.1804375],
	[0.2126729, 0.7151522, 0.072175],
	[0.0193339, 0.119192, 0.9503041],
];

/**
 * The reference white, taken as the matrix's own response to linear white rather
 * than as the tabulated D65 triple. They differ in the seventh decimal, which is
 * enough to give a pure grey a non-zero a* and b* - harmless in itself, but it
 * would mean neutrals never test as exactly neutral, and a check nobody can state
 * exactly is a check nobody trusts.
 */
const XYZ_WHITE: readonly [number, number, number] = [
	XYZ_FROM_LINEAR_SRGB[0][0] + XYZ_FROM_LINEAR_SRGB[0][1] + XYZ_FROM_LINEAR_SRGB[0][2],
	XYZ_FROM_LINEAR_SRGB[1][0] + XYZ_FROM_LINEAR_SRGB[1][1] + XYZ_FROM_LINEAR_SRGB[1][2],
	XYZ_FROM_LINEAR_SRGB[2][0] + XYZ_FROM_LINEAR_SRGB[2][1] + XYZ_FROM_LINEAR_SRGB[2][2],
];

/** sRGB -> CIELAB, D65, the white point sRGB is defined against. */
function toLab(rgb: Rgb): Lab {
	const r = srgbToLinear(Math.min(Math.max(rgb.r / 255, 0), 1));
	const g = srgbToLinear(Math.min(Math.max(rgb.g / 255, 0), 1));
	const b = srgbToLinear(Math.min(Math.max(rgb.b / 255, 0), 1));
	const [xr, yr, zr] = XYZ_FROM_LINEAR_SRGB;
	const x = (xr[0] * r + xr[1] * g + xr[2] * b) / XYZ_WHITE[0];
	const y = (yr[0] * r + yr[1] * g + yr[2] * b) / XYZ_WHITE[1];
	const z = (zr[0] * r + zr[1] * g + zr[2] * b) / XYZ_WHITE[2];
	const epsilon = (6 / 29) ** 3;
	const f = (t: number): number => (t > epsilon ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
	const fx = f(x);
	const fy = f(y);
	const fz = f(z);
	return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * CIEDE2000 colour difference (CIE 142-2001), kL = kC = kH = 1.
 *
 * Plain euclidean distance in Lab (CIE76) would be simpler, but it badly
 * overestimates differences in the blue region and underestimates them in the
 * neutrals - exactly where a de-saturated editor palette lives. Getting that wrong
 * in either direction defeats the point of the check.
 */
/**
 * CIEDE2000's lightness weight SL, which is what stops a lightness difference from
 * being worth its face value in dE00.
 *
 * It is >= 1 everywhere and equals 1 only at Lbar 50, so dL* / SL <= dL* always, and the
 * penalty grows towards both ends of the range - which is where dark and light themes
 * put their text. It is factored out of deltaE2000 rather than written twice because
 * requiredLightnessDelta inverts it: the two must never be able to disagree.
 */
function lightnessWeight(lBar: number): number {
	return 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
}

function deltaE2000(first: Lab, second: Lab): number {
	const c1 = Math.hypot(first.a, first.b);
	const c2 = Math.hypot(second.a, second.b);
	const cBar = (c1 + c2) / 2;
	const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));

	const a1p = (1 + g) * first.a;
	const a2p = (1 + g) * second.a;
	const c1p = Math.hypot(a1p, first.b);
	const c2p = Math.hypot(a2p, second.b);

	const hue = (a: number, b: number): number => {
		if (a === 0 && b === 0) {
			return 0;
		}
		const h = toDegrees(Math.atan2(b, a));
		return h >= 0 ? h : h + 360;
	};
	const h1p = hue(a1p, first.b);
	const h2p = hue(a2p, second.b);

	const deltaLp = second.l - first.l;
	const deltaCp = c2p - c1p;

	let deltahp: number;
	if (c1p * c2p === 0) {
		deltahp = 0;
	} else if (Math.abs(h2p - h1p) <= 180) {
		deltahp = h2p - h1p;
	} else if (h2p - h1p > 180) {
		deltahp = h2p - h1p - 360;
	} else {
		deltahp = h2p - h1p + 360;
	}
	const deltaHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(toRadians(deltahp) / 2);

	const lBarp = (first.l + second.l) / 2;
	const cBarp = (c1p + c2p) / 2;

	let hBarp: number;
	if (c1p * c2p === 0) {
		hBarp = h1p + h2p;
	} else if (Math.abs(h1p - h2p) <= 180) {
		hBarp = (h1p + h2p) / 2;
	} else if (h1p + h2p < 360) {
		hBarp = (h1p + h2p + 360) / 2;
	} else {
		hBarp = (h1p + h2p - 360) / 2;
	}

	const t =
		1 -
		0.17 * Math.cos(toRadians(hBarp - 30)) +
		0.24 * Math.cos(toRadians(2 * hBarp)) +
		0.32 * Math.cos(toRadians(3 * hBarp + 6)) -
		0.2 * Math.cos(toRadians(4 * hBarp - 63));

	const deltaTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2));
	const rc = 2 * Math.sqrt(cBarp ** 7 / (cBarp ** 7 + 25 ** 7));
	const sl = lightnessWeight(lBarp);
	const sc = 1 + 0.045 * cBarp;
	const sh = 1 + 0.015 * cBarp * t;
	const rt = -Math.sin(toRadians(2 * deltaTheta)) * rc;

	const termL = deltaLp / sl;
	const termC = deltaCp / sc;
	const termH = deltaHp / sh;
	return Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + rt * termC * termH);
}

/**
 * Perceptual distance between two opaque colours written as theme values.
 *
 * Exported so buildThemes can compare two candidate editor planes without a second
 * CIEDE2000 in the tree. Throws on an unparseable colour rather than returning a
 * number that would silently mean "identical".
 */
export function perceptualDistanceOfHex(a: string, b: string): number {
	const first = parseColor(a);
	const second = parseColor(b);
	if (!first || !second) {
		throw new Error(`validateTheme: cannot measure distance between ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
	}
	return deltaE2000(toLab(opaque(first)), toLab(opaque(second)));
}

/** Perceptual distance between two opaque colours as seen by a given observer. */
function perceptualDistance(a: Rgb, b: Rgb, observer: CvdType | "normal"): number {
	const seenA = observer === "normal" ? a : simulateCvd(a, observer);
	const seenB = observer === "normal" ? b : simulateCvd(b, observer);
	return deltaE2000(toLab(seenA), toLab(seenB));
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface Finding {
	/** Which check produced this, so a report can be grouped and a fix can be targeted. */
	readonly check: string;
	/** The colour id (or ids) at fault. This is what the author has to edit. */
	readonly token: string;
	/** What was actually measured, with units. */
	readonly measured: string;
	/** The bar it had to clear. */
	readonly threshold: string;
	/** One line of plain English, for the person who has to act on it. */
	readonly detail: string;
	/**
	 * For a check measured under several observers: the one the measurement above
	 * came from. `"normal"` means a trichromat sees the failure too, which is a
	 * different class of defect from one that only a dichromat sees - a caller
	 * deciding what to forgive has to be able to tell them apart without parsing
	 * `measured`. Absent on checks that have only one observer.
	 */
	readonly observer?: CvdType | "normal";
}

export interface ValidationResult {
	readonly ok: boolean;
	readonly errors: readonly Finding[];
	readonly warnings: readonly Finding[];
}

export interface TokenColorRule {
	readonly scope?: string | readonly string[];
	readonly settings?: { readonly foreground?: string; readonly fontStyle?: string };
}

export interface ColorTheme {
	readonly name?: string;
	readonly type?: string;
	/** A theme may inherit from another file. Primal's generated themes never do; see checkSelfContained. */
	readonly include?: string;
	readonly colors?: Readonly<Record<string, string>>;
	readonly tokenColors?: readonly TokenColorRule[];
}

// ---------------------------------------------------------------------------
// The workbench colour registry, read off the source tree
// ---------------------------------------------------------------------------

/**
 * VS Code silently ignores a colour id it does not know. A typo'd token therefore
 * produces no error, no warning and no visible effect - it just quietly does
 * nothing forever. Nothing else in the build catches that, so this does.
 *
 * The ids come from three places, because that is where VS Code actually puts them:
 *
 *  1. registerColor('id', ...) calls anywhere under src/vs. colorRegistry.ts is the
 *     entry point but it is only a barrel of re-exports; the definitions are spread
 *     across platform/theme/common/colors/*.ts and dozens of workbench contribs, all
 *     registering into the same registry.
 *  2. The ANSI ramp, which is registered in a loop over the ansiColorMap object in
 *     the terminal contrib, so no literal ever appears in a registerColor call.
 *  3. contributes.colors in a bundled extension's package.json - this is how the git
 *     extension declares gitDecoration.*, and those ids are as real as any other.
 */
const TERMINAL_COLOR_REGISTRY = join(
	ROOT,
	"src",
	"vs",
	"workbench",
	"contrib",
	"terminal",
	"common",
	"terminalColorRegistry.ts"
);

let registryCache: ReadonlySet<string> | null = null;

function collectRegisterColorIds(directory: string, into: Set<string>): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "test") {
				continue;
			}
			collectRegisterColorIds(path, into);
		} else if (entry.name.endsWith(".ts")) {
			const source = readFileSync(path, "utf8");
			// The id can sit on the line after the paren, so this must span newlines.
			for (const match of source.matchAll(/registerColor\(\s*['"`]([^'"`$\n]+)['"`]/g)) {
				into.add(match[1]);
			}
		}
	}
}

function collectAnsiIds(into: Set<string>): void {
	const source = readFileSync(TERMINAL_COLOR_REGISTRY, "utf8");
	const start = source.indexOf("ansiColorMap");
	if (start < 0) {
		throw new Error(`validateTheme: ansiColorMap is gone from ${relative(ROOT, TERMINAL_COLOR_REGISTRY)}; the ANSI ids can no longer be found`);
	}
	let found = 0;
	for (const match of source.slice(start).matchAll(/'(terminal\.ansi[A-Za-z]+)'/g)) {
		into.add(match[1]);
		found++;
	}
	if (found < 16) {
		throw new Error(`validateTheme: found only ${found} ANSI colour ids in ansiColorMap; expected at least 16`);
	}
}

function collectExtensionContributedIds(into: Set<string>): void {
	const extensions = join(ROOT, "extensions");
	for (const entry of readdirSync(extensions, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const manifest = join(extensions, entry.name, "package.json");
		try {
			if (!statSync(manifest).isFile()) {
				continue;
			}
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(manifest, "utf8"));
		} catch (error) {
			throw new Error(`validateTheme: cannot parse ${relative(ROOT, manifest)}: ${(error as Error).message}`);
		}
		const colors = (parsed as { contributes?: { colors?: unknown } }).contributes?.colors;
		if (!Array.isArray(colors)) {
			continue;
		}
		for (const colour of colors) {
			const id = (colour as { id?: unknown }).id;
			if (typeof id === "string") {
				into.add(id);
			}
		}
	}
}

function knownColorIds(): ReadonlySet<string> {
	if (registryCache) {
		return registryCache;
	}
	const ids = new Set<string>();
	collectRegisterColorIds(join(ROOT, "src", "vs"), ids);
	collectAnsiIds(ids);
	collectExtensionContributedIds(ids);
	if (ids.size < MIN_PLAUSIBLE_REGISTRY_SIZE) {
		throw new Error(
			`validateTheme: only ${ids.size} colour ids found in the source tree (expected at least ${MIN_PLAUSIBLE_REGISTRY_SIZE}). ` +
				"The crawl is broken - fix it rather than trusting the result."
		);
	}
	registryCache = ids;
	return ids;
}

/** Cheap Levenshtein, capped: used only to say "did you mean" on an unknown id. */
function editDistance(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const next = Math.min(
				previous[j] + 1,
				previous[j - 1] + 1,
				diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
			diagonal = previous[j];
			previous[j] = next;
		}
	}
	return previous[b.length];
}

function nearestKnownId(id: string, known: ReadonlySet<string>): string | null {
	const budget = Math.max(1, Math.floor(id.length / 5));
	let best: string | null = null;
	let bestDistance = budget + 1;
	for (const candidate of known) {
		if (Math.abs(candidate.length - id.length) > bestDistance) {
			continue;
		}
		const distance = editDistance(id, candidate);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = candidate;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// What must be told apart from what
// ---------------------------------------------------------------------------

/**
 * A group of colours a user has to be able to tell apart at a glance. Every pair
 * within a group is checked, for a normal observer and for each of the three
 * dichromacies.
 *
 * `over` names the token the group's colours are composited onto when they carry
 * alpha - a 20%-alpha green and a 20%-alpha red are not 20% apart, they are as far
 * apart as what is left after the background eats most of them.
 */
interface SemanticGroup {
	readonly name: string;
	readonly tokens: readonly string[];
	readonly over?: string;
}

const SEMANTIC_GROUPS: readonly SemanticGroup[] = [
	{
		name: "diagnostic squiggles",
		tokens: ["editorError.foreground", "editorWarning.foreground", "editorInfo.foreground"],
		over: "editor.background",
	},
	{
		name: "problems panel icons",
		tokens: ["problemsErrorIcon.foreground", "problemsWarningIcon.foreground", "problemsInfoIcon.foreground"],
		over: "editor.background",
	},
	{
		name: "notification icons",
		tokens: [
			"notificationsErrorIcon.foreground",
			"notificationsWarningIcon.foreground",
			"notificationsInfoIcon.foreground",
		],
		over: "editor.background",
	},
	{
		name: "debug console severities",
		tokens: ["debugConsole.errorForeground", "debugConsole.warningForeground", "debugConsole.infoForeground"],
		over: "panel.background",
	},
	{
		name: "overview ruler diagnostics",
		tokens: [
			"editorOverviewRuler.errorForeground",
			"editorOverviewRuler.warningForeground",
			"editorOverviewRuler.infoForeground",
		],
		over: "editor.background",
	},
	{
		name: "editor gutter diff bars",
		tokens: ["editorGutter.addedBackground", "editorGutter.deletedBackground", "editorGutter.modifiedBackground"],
		over: "editorGutter.background",
	},
	{
		name: "overview ruler diff marks",
		tokens: [
			"editorOverviewRuler.addedForeground",
			"editorOverviewRuler.deletedForeground",
			"editorOverviewRuler.modifiedForeground",
		],
		over: "editor.background",
	},
	{
		name: "source control decorations",
		tokens: [
			"gitDecoration.addedResourceForeground",
			"gitDecoration.deletedResourceForeground",
			"gitDecoration.modifiedResourceForeground",
			"gitDecoration.untrackedResourceForeground",
			"gitDecoration.conflictingResourceForeground",
		],
		over: "sideBar.background",
	},
	{
		name: "diff editor text",
		tokens: ["diffEditor.insertedTextBackground", "diffEditor.removedTextBackground"],
		over: "editor.background",
	},
	{
		name: "diff editor lines",
		tokens: ["diffEditor.insertedLineBackground", "diffEditor.removedLineBackground"],
		over: "editor.background",
	},
	{
		name: "inline chat diff",
		tokens: ["inlineChatDiff.inserted", "inlineChatDiff.removed"],
		over: "editor.background",
	},
	{
		name: "chat diff summary",
		tokens: ["chat.linesAddedForeground", "chat.linesRemovedForeground"],
		over: "editor.background",
	},
	{
		name: "status bar severities",
		tokens: ["statusBarItem.errorBackground", "statusBarItem.warningBackground"],
		over: "statusBar.background",
	},
	{
		name: "list severities",
		tokens: ["list.errorForeground", "list.warningForeground"],
		over: "sideBar.background",
	},
	{
		name: "input validation borders",
		tokens: ["inputValidation.errorBorder", "inputValidation.warningBorder", "inputValidation.infoBorder"],
		over: "editor.background",
	},
];

/**
 * The same requirement applied to syntax highlighting, where diffs are rendered as
 * tokens rather than as workbench colours. Scopes are matched exactly against the
 * theme's tokenColors entries.
 */
const SEMANTIC_TOKEN_GROUPS: readonly { readonly name: string; readonly scopes: readonly string[] }[] = [
	{ name: "markup diff tokens", scopes: ["markup.inserted", "markup.deleted", "markup.changed"] },
	{ name: "output severity tokens", scopes: ["token.error-token", "token.warn-token", "token.info-token"] },
];

/**
 * Backgrounds painted behind text the user is reading. Each is composited over its
 * base and the reading colour is measured against the result.
 */
const HIGHLIGHT_CHECKS: readonly {
	readonly token: string;
	readonly over: string;
	readonly text: string;
}[] = [
	{ token: "editor.selectionBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.inactiveSelectionBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.selectionHighlightBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.wordHighlightBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.wordHighlightStrongBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.findMatchBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.findMatchHighlightBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.findRangeHighlightBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.rangeHighlightBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.lineHighlightBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "editor.hoverHighlightBackground", over: "editor.background", text: "editor.foreground" },
	{ token: "terminal.selectionBackground", over: "terminal.background", text: "terminal.foreground" },
	{ token: "terminal.inactiveSelectionBackground", over: "terminal.background", text: "terminal.foreground" },
	{ token: "terminal.findMatchBackground", over: "terminal.background", text: "terminal.foreground" },
	{ token: "terminal.findMatchHighlightBackground", over: "terminal.background", text: "terminal.foreground" },
	{ token: "list.activeSelectionBackground", over: "sideBar.background", text: "list.activeSelectionForeground" },
	{ token: "list.inactiveSelectionBackground", over: "sideBar.background", text: "list.inactiveSelectionForeground" },
	{ token: "list.hoverBackground", over: "sideBar.background", text: "list.hoverForeground" },
	{ token: "menu.selectionBackground", over: "menu.background", text: "menu.selectionForeground" },
	{ token: "peekViewResult.selectionBackground", over: "peekViewResult.background", text: "peekViewResult.selectionForeground" },
];

const ANSI_SLOTS: readonly string[] = [
	"terminal.ansiBlack",
	"terminal.ansiRed",
	"terminal.ansiGreen",
	"terminal.ansiYellow",
	"terminal.ansiBlue",
	"terminal.ansiMagenta",
	"terminal.ansiCyan",
	"terminal.ansiWhite",
	"terminal.ansiBrightBlack",
	"terminal.ansiBrightRed",
	"terminal.ansiBrightGreen",
	"terminal.ansiBrightYellow",
	"terminal.ansiBrightBlue",
	"terminal.ansiBrightMagenta",
	"terminal.ansiBrightCyan",
	"terminal.ansiBrightWhite",
];

/** Scopes that carry a theme's comment colour, most specific first. */
const COMMENT_SCOPES: readonly string[] = ["comment", "comment.line", "comment.block"];

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function scopesOf(rule: TokenColorRule): readonly string[] {
	const scope = rule.scope;
	if (typeof scope === "string") {
		return scope.split(",").map((s) => s.trim()).filter(Boolean);
	}
	return Array.isArray(scope) ? scope : [];
}

function foregroundForScope(theme: ColorTheme, scope: string): string | null {
	for (const rule of theme.tokenColors ?? []) {
		if (scopesOf(rule).includes(scope) && rule.settings?.foreground) {
			return rule.settings.foreground;
		}
	}
	return null;
}

/** Resolve a token to an opaque colour, flattening alpha over `base` when present. */
function resolveOpaque(
	colors: Readonly<Record<string, string>>,
	token: string,
	base: Rgb | null
): Rgb | null {
	const parsed = parseColor(colors[token]);
	if (!parsed) {
		return null;
	}
	if (parsed.a >= 1 || !base) {
		return opaque(parsed);
	}
	return composite(parsed, base);
}

/**
 * A theme with an `include` inherits most of its colours from another file, and this
 * validator does not follow that link - it measures what is in front of it. Half a
 * theme measured as if it were whole is a wrong answer delivered confidently, which
 * is worse than no answer, so say so. Primal's generated themes are self-contained
 * by construction, so this should never fire on one.
 */
function checkSelfContained(theme: ColorTheme, warnings: Finding[]): void {
	if (typeof theme.include === "string") {
		warnings.push({
			check: "self-contained theme",
			token: "include",
			measured: `inherits from "${theme.include}"`,
			threshold: "no include: every colour stated in this file",
			detail: "Inherited colours are not followed, so the results below describe only the overrides in this file.",
		});
	}
}

function checkRequiredAndKnownTokens(theme: ColorTheme, errors: Finding[]): void {
	const colors = theme.colors ?? {};
	for (const token of REQUIRED_TOKENS) {
		if (!parseColor(colors[token])) {
			errors.push({
				check: "required token",
				token,
				measured: colors[token] === undefined ? "absent" : `"${String(colors[token])}"`,
				threshold: "a #RGB, #RGBA, #RRGGBB or #RRGGBBAA value",
				detail: "Every other check reads through this token; a theme without it cannot be validated.",
			});
		}
	}

	const known = knownColorIds();
	for (const [token, value] of Object.entries(colors)) {
		if (!parseColor(value)) {
			errors.push({
				check: "colour syntax",
				token,
				measured: `"${String(value)}"`,
				threshold: "a #RGB, #RGBA, #RRGGBB or #RRGGBBAA value",
				detail: "VS Code cannot parse this and will fall back to its default colour.",
			});
		}
		if (!known.has(token)) {
			const suggestion = nearestKnownId(token, known);
			errors.push({
				check: "unknown colour id",
				token,
				measured: "not registered anywhere in src/vs or a bundled extension",
				threshold: `one of the ${known.size} registered workbench colour ids`,
				detail: suggestion
					? `VS Code ignores this key silently. Closest registered id is "${suggestion}".`
					: "VS Code ignores this key silently, so setting it has no effect at all.",
			});
		}
	}
}

function checkReadingContrast(theme: ColorTheme, errors: Finding[], warnings: Finding[]): void {
	const colors = theme.colors ?? {};
	const background = resolveOpaque(colors, "editor.background", null);
	const foreground = background ? resolveOpaque(colors, "editor.foreground", background) : null;
	if (!background || !foreground) {
		return; // already reported by checkRequiredAndKnownTokens
	}

	const bodyContrast = contrastRatio(foreground, background);
	if (bodyContrast < MIN_EDITOR_TEXT_CONTRAST) {
		errors.push({
			check: "editor text contrast",
			token: "editor.foreground on editor.background",
			measured: `${bodyContrast.toFixed(2)}:1 (${formatRgb(foreground)} on ${formatRgb(background)})`,
			threshold: `>= ${MIN_EDITOR_TEXT_CONTRAST.toFixed(1)}:1`,
			detail: "Body text in the editor is below the WCAG AA floor for normal-size text.",
		});
	}

	let commentScope: string | null = null;
	let commentColor: string | null = null;
	for (const scope of COMMENT_SCOPES) {
		const found = foregroundForScope(theme, scope);
		if (found) {
			commentScope = scope;
			commentColor = found;
			break;
		}
	}
	if (!commentColor || !commentScope) {
		warnings.push({
			check: "comment contrast",
			token: `tokenColors scope "${COMMENT_SCOPES[0]}"`,
			measured: "no rule sets a comment foreground",
			threshold: "a foreground for the comment scope",
			detail: "Comments will inherit editor.foreground and lose their de-emphasis.",
		});
		return;
	}
	const parsed = parseColor(commentColor);
	if (!parsed) {
		errors.push({
			check: "colour syntax",
			token: `tokenColors scope "${commentScope}"`,
			measured: `"${commentColor}"`,
			threshold: "a #RGB, #RGBA, #RRGGBB or #RRGGBBAA value",
			detail: "VS Code cannot parse this token colour.",
		});
		return;
	}
	const comment = parsed.a >= 1 ? opaque(parsed) : composite(parsed, background);
	const commentContrast = contrastRatio(comment, background);
	const finding: Finding = {
		check: "comment contrast",
		token: `tokenColors scope "${commentScope}" on editor.background`,
		measured: `${commentContrast.toFixed(2)}:1 (${formatRgb(comment)} on ${formatRgb(background)})`,
		threshold:
			commentContrast < MIN_COMMENT_CONTRAST_ERROR
				? `>= ${MIN_COMMENT_CONTRAST_ERROR.toFixed(1)}:1`
				: `>= ${MIN_COMMENT_CONTRAST_WARN.toFixed(1)}:1`,
		detail:
			commentContrast < MIN_COMMENT_CONTRAST_ERROR
				? "Comments are below the readability floor: this is the classic unreadable-theme failure."
				: "Comments clear the readability floor but not the WCAG AA floor for normal-size text.",
	};
	if (commentContrast < MIN_COMMENT_CONTRAST_ERROR) {
		errors.push(finding);
	} else if (commentContrast < MIN_COMMENT_CONTRAST_WARN) {
		warnings.push(finding);
	}
}

/**
 * Every syntax colour the theme states, parsed and measured against the editor plane.
 *
 * checkReadingContrast covers editor.foreground and the comment scope; the six
 * diff/severity scopes in SEMANTIC_TOKEN_GROUPS are checked for separation from each
 * other. Everything else in tokenColors - keywords, strings, types, functions, the
 * scopes a user spends the day reading - was measured by nothing at all, so a rule
 * could name an unparseable colour, or paint code at 1.19:1 on the background, and
 * this file reported clean.
 *
 * The rule's FIRST scope names the finding, because that is the scope
 * `foregroundForScope` resolves back to this rule; the rest of the rule's scopes ride
 * along and are named in `measured`.
 */
function checkSyntaxContrast(theme: ColorTheme, errors: Finding[], warnings: Finding[]): void {
	const colors = theme.colors ?? {};
	const background = resolveOpaque(colors, "editor.background", null);
	if (!background) {
		return; // already reported by checkRequiredAndKnownTokens
	}

	const rules = theme.tokenColors ?? [];
	for (let index = 0; index < rules.length; index++) {
		const rule = rules[index];
		const foreground = rule.settings?.foreground;
		if (foreground === undefined) {
			continue; // a fontStyle-only rule states no colour, so there is nothing to measure
		}
		const scopes = scopesOf(rule);
		const name = scopes.length > 0 ? `tokenColors "${scopes[0]}"` : `tokenColors rule ${index} (no scope)`;
		const where = scopes.length > 1 ? `rule ${index}, ${scopes.length} scopes` : `rule ${index}`;

		const parsed = parseColor(foreground);
		if (!parsed) {
			errors.push({
				check: "colour syntax",
				token: name,
				measured: `"${String(foreground)}" (${where})`,
				threshold: "a #RGB, #RGBA, #RRGGBB or #RRGGBBAA value",
				detail: "VS Code cannot parse this token colour and falls back to the default foreground.",
			});
			continue;
		}
		if (scopes.some((scope) => COMMENT_SCOPES.includes(scope))) {
			continue; // comments have their own floor and their own finding; see MIN_COMMENT_CONTRAST_ERROR
		}

		const composited = parsed.a >= 1 ? opaque(parsed) : composite(parsed, background);
		const ratio = contrastRatio(composited, background);
		if (ratio >= MIN_SYNTAX_CONTRAST_WARN) {
			continue;
		}
		const finding: Finding = {
			check: "syntax token contrast",
			token: name,
			measured: `${ratio.toFixed(2)}:1 (${formatRgb(composited)} on editor.background ${formatRgb(background)}, ${where})`,
			threshold:
				ratio < MIN_SYNTAX_CONTRAST_ERROR
					? `>= ${MIN_SYNTAX_CONTRAST_ERROR.toFixed(1)}:1`
					: `>= ${MIN_SYNTAX_CONTRAST_WARN.toFixed(1)}:1`,
			detail:
				ratio < MIN_SYNTAX_CONTRAST_ERROR
					? "Code in this scope is below the readability floor: it is text the user cannot reliably see."
					: "Code in this scope clears the readability floor but not the WCAG AA floor for normal-size text.",
		};
		if (ratio < MIN_SYNTAX_CONTRAST_ERROR) {
			errors.push(finding);
		} else {
			warnings.push(finding);
		}
	}
}

function checkSemanticSeparation(theme: ColorTheme, errors: Finding[], warnings: Finding[]): void {
	const colors = theme.colors ?? {};
	const editorBackground = resolveOpaque(colors, "editor.background", null);

	const resolveGroup = (group: SemanticGroup): ReadonlyArray<readonly [string, Rgb]> => {
		const base = group.over ? resolveOpaque(colors, group.over, editorBackground) ?? editorBackground : editorBackground;
		const resolved: [string, Rgb][] = [];
		for (const token of group.tokens) {
			const colour = resolveOpaque(colors, token, base);
			if (colour) {
				resolved.push([token, colour]);
			}
		}
		return resolved;
	};

	const named: { readonly name: string; readonly members: ReadonlyArray<readonly [string, Rgb]> }[] = [];
	for (const group of SEMANTIC_GROUPS) {
		named.push({ name: group.name, members: resolveGroup(group) });
	}
	for (const group of SEMANTIC_TOKEN_GROUPS) {
		const members: [string, Rgb][] = [];
		for (const scope of group.scopes) {
			const value = foregroundForScope(theme, scope);
			const parsed = value ? parseColor(value) : null;
			if (parsed) {
				members.push([
					`tokenColors "${scope}"`,
					parsed.a >= 1 || !editorBackground ? opaque(parsed) : composite(parsed, editorBackground),
				]);
			}
		}
		named.push({ name: group.name, members });
	}

	for (const group of named) {
		for (let i = 0; i < group.members.length; i++) {
			for (let j = i + 1; j < group.members.length; j++) {
				const [tokenA, colourA] = group.members[i];
				const [tokenB, colourB] = group.members[j];
				const pair = `${tokenA} vs ${tokenB}`;

				// The measurement that blocks a release: distance under the worst observer.
				let worstObserver: CvdType | "normal" = "normal";
				let worstDistance = Number.POSITIVE_INFINITY;
				for (const observer of ["normal", ...CVD_TYPES] as const) {
					const distance = perceptualDistance(colourA, colourB, observer);
					if (distance < worstDistance) {
						worstDistance = distance;
						worstObserver = observer;
					}
				}
				if (worstDistance < MIN_SEMANTIC_DELTA_E) {
					errors.push({
						check: `semantic separation (${group.name})`,
						token: pair,
						measured: `dE00 ${worstDistance.toFixed(2)} under ${worstObserver} (${formatRgb(colourA)} / ${formatRgb(colourB)})`,
						threshold: `>= ${MIN_SEMANTIC_DELTA_E} dE00 under every observer`,
						observer: worstObserver,
						detail:
							worstObserver === "normal"
								? "These two read as the same colour even to a trichromat."
								: `These two collapse together for a ${worstObserver.replace("nopia", "nope")}; separate them by lightness, not hue.`,
					});
				}

				// The design rule that explains the failure above. See requiredLightnessDelta:
				// the bar is whatever dL* is worth MIN_SEMANTIC_DELTA_E on its own at the
				// lightness this pair sits at, so clearing it means lightness alone already
				// carries the separation and no observer can take it away.
				const lightnessA = toLab(colourA).l;
				const lightnessB = toLab(colourB).l;
				const lightnessDelta = Math.abs(lightnessA - lightnessB);
				const required = requiredLightnessDelta((lightnessA + lightnessB) / 2);
				if (lightnessDelta < required) {
					warnings.push({
						check: `lightness separation (${group.name})`,
						token: pair,
						measured: `dL* ${lightnessDelta.toFixed(1)} at L* ${((lightnessA + lightnessB) / 2).toFixed(0)} (${formatRgb(colourA)} / ${formatRgb(colourB)})`,
						threshold: `>= ${required.toFixed(1)} L* (${MIN_SEMANTIC_DELTA_E} dE00 from lightness alone at this L*)`,
						detail: "These lean on hue for part of their separation, and hue is the channel a colour-blind user loses.",
					});
				}
			}
		}
	}
}

function checkHighlightBackgrounds(theme: ColorTheme, errors: Finding[]): void {
	const colors = theme.colors ?? {};
	const editorBackground = resolveOpaque(colors, "editor.background", null);
	for (const entry of HIGHLIGHT_CHECKS) {
		const base = resolveOpaque(colors, entry.over, editorBackground);
		const overlay = parseColor(colors[entry.token]);
		if (!base || !overlay) {
			continue;
		}
		const textColour = resolveOpaque(colors, entry.text, base) ?? resolveOpaque(colors, "editor.foreground", base);
		if (!textColour) {
			continue;
		}
		const composited = composite(overlay, base);
		const ratio = contrastRatio(textColour, composited);
		if (ratio < MIN_HIGHLIGHTED_TEXT_CONTRAST) {
			errors.push({
				check: "highlighted text contrast",
				token: entry.token,
				measured: `${ratio.toFixed(2)}:1 (${entry.text} ${formatRgb(textColour)} on ${formatRgb(composited)}, composited over ${entry.over})`,
				threshold: `>= ${MIN_HIGHLIGHTED_TEXT_CONTRAST.toFixed(1)}:1`,
				detail: "Text under this highlight drops below the WCAG AA floor for normal-size text.",
			});
		}
	}
}

function checkAnsiRamp(theme: ColorTheme, errors: Finding[], warnings: Finding[]): void {
	const colors = theme.colors ?? {};
	const terminalBackground = resolveOpaque(colors, "terminal.background", null);
	if (!terminalBackground) {
		return;
	}
	const slots: [string, Rgb][] = [];
	for (const token of ANSI_SLOTS) {
		const colour = resolveOpaque(colors, token, terminalBackground);
		if (!colour) {
			errors.push({
				check: "ansi ramp completeness",
				token,
				measured: colors[token] === undefined ? "absent" : `"${String(colors[token])}"`,
				threshold: "all 16 ANSI slots defined",
				detail: "An undefined slot falls back to the VS Code default, which is not part of this palette.",
			});
			continue;
		}
		slots.push([token, colour]);
	}

	for (const [token, colour] of slots) {
		const ratio = contrastRatio(colour, terminalBackground);
		if (ratio < MIN_ANSI_CONTRAST) {
			errors.push({
				check: "ansi readability",
				token,
				measured: `${ratio.toFixed(2)}:1 (${formatRgb(colour)} on terminal.background ${formatRgb(terminalBackground)})`,
				threshold: `>= ${MIN_ANSI_CONTRAST.toFixed(1)}:1`,
				detail: "Terminal output printed in this colour is not legible against the terminal background.",
			});
		}
	}

	for (let i = 0; i < slots.length; i++) {
		for (let j = i + 1; j < slots.length; j++) {
			const [tokenA, colourA] = slots[i];
			const [tokenB, colourB] = slots[j];

			// A collision a trichromat sees is a real defect in this theme: two SGR
			// codes paint the same colour for everyone. A collision only a dichromat
			// sees is a property of the 16-colour ANSI palette itself — red and green
			// are mandated to be red and green, and no repalette fixes that without
			// breaking the convention every terminal program relies on. Report the
			// second so a theme author knows, but do not fail the build for it.
			//
			// THE SPLIT IS ON THE TRICHROMAT MEASUREMENT, NOT ON WHICH OBSERVER SCORED
			// LOWEST, and that distinction was worth 52 hidden errors. Simulating a
			// dichromat almost always SHRINKS a distance, so a pair that collides for a
			// trichromat at 5.47 (Tide's ansiGreen #7FC79C / ansiBrightGreen #9CD8B4)
			// scores lower still under protanopia — 4.94 — and a rule that files the
			// finding under whichever observer scored lowest labelled that pair
			// "a dichromat can't escape this" and demoted it to a warning. Every
			// trichromat collision in the tree was reclassified that way, so the check
			// reported zero errors while sixteen slots were painting nine colours.
			// Which observer scored WORST is reporting detail; whether a trichromat can
			// tell the two slots apart is the pass/fail question.
			const normalDistance = perceptualDistance(colourA, colourB, "normal");
			let cvdObserver: CvdType = CVD_TYPES[0];
			let cvdDistance = Number.POSITIVE_INFINITY;
			for (const observer of CVD_TYPES) {
				const distance = perceptualDistance(colourA, colourB, observer);
				if (distance < cvdDistance) {
					cvdDistance = distance;
					cvdObserver = observer;
				}
			}
			const trichromatCollides = normalDistance < MIN_ANSI_DELTA_E;
			if (trichromatCollides || cvdDistance < MIN_ANSI_DELTA_E) {
				const observer: CvdType | "normal" = trichromatCollides ? "normal" : cvdObserver;
				const distance = trichromatCollides ? normalDistance : cvdDistance;
				(trichromatCollides ? errors : warnings).push({
					check: "ansi ramp separation",
					token: `${tokenA} vs ${tokenB}`,
					measured: `dE00 ${distance.toFixed(2)} under ${observer} (${formatRgb(colourA)} / ${formatRgb(colourB)})`,
					threshold: `>= ${MIN_ANSI_DELTA_E} dE00 under every observer`,
					observer,
					detail: trichromatCollides
						? `Two ANSI slots collide for a trichromat as well: SGR codes that should differ paint the same colour (worst observer ${cvdObserver}, dE00 ${cvdDistance.toFixed(2)}).`
						: `Two ANSI slots collide for a ${observer.replace("nopia", "nope")}, so any meaning a program encodes in them is lost.`,
				});
			}
		}
	}
}

/**
 * Run every check over a parsed theme.
 *
 * Pure: it reads the theme and the source tree, and returns findings. It never
 * writes, and it never mutates its argument.
 */
export function validate(theme: ColorTheme): ValidationResult {
	const errors: Finding[] = [];
	const warnings: Finding[] = [];
	checkSelfContained(theme, warnings);
	checkRequiredAndKnownTokens(theme, errors);
	checkReadingContrast(theme, errors, warnings);
	checkSyntaxContrast(theme, errors, warnings);
	checkSemanticSeparation(theme, errors, warnings);
	checkHighlightBackgrounds(theme, errors);
	checkAnsiRamp(theme, errors, warnings);
	return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The CIE's own CIEDE2000 test data (Sharma, Wu & Dalal 2005, "The CIEDE2000
 * color-difference formula: implementation notes, supplementary test data and
 * mathematical observations"), which exists precisely because the formula has
 * several arctangent and hue-wraparound traps that a plausible-looking
 * implementation walks straight into. Lab pairs and the published dE00.
 */
const CIEDE2000_TEST_DATA: ReadonlyArray<readonly [Lab, Lab, number]> = [
	[{ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 }, 2.0425],
	[{ l: 50, a: 3.1571, b: -77.2803 }, { l: 50, a: 0, b: -82.7485 }, 2.8615],
	[{ l: 50, a: 2.8361, b: -74.02 }, { l: 50, a: 0, b: -82.7485 }, 3.4412],
	[{ l: 50, a: 0, b: 0 }, { l: 50, a: -1, b: 2 }, 2.3669],
	[{ l: 50, a: 2.49, b: -0.001 }, { l: 50, a: -2.49, b: 0.0009 }, 7.1792],
	[{ l: 60.2574, a: -34.0099, b: 36.2677 }, { l: 60.4626, a: -34.1751, b: 39.4387 }, 1.2644],
	[{ l: 63.0109, a: -31.0961, b: -5.8663 }, { l: 62.8187, a: -29.7946, b: -4.0864 }, 1.263],
	[{ l: 61.2901, a: 3.7196, b: -5.3901 }, { l: 61.4292, a: 2.248, b: -4.962 }, 1.8731],
];

/** Verify the colour maths this file owns. The CVD maths verifies itself in cvd.ts. */
function selfTest(): number {
	let failures = 0;
	for (const [first, second, expected] of CIEDE2000_TEST_DATA) {
		const actual = deltaE2000(first, second);
		const ok = Math.abs(actual - expected) < 2e-4;
		if (!ok) {
			failures++;
		}
		console.log(`  ${ok ? "ok  " : "FAIL"}  CIEDE2000  got ${actual.toFixed(4)}, published ${expected.toFixed(4)}`);
	}

	// A grey ramp must come out with a*=b*=0 and L* rising monotonically.
	let labOk = true;
	let previousL = -1;
	for (const v of [0, 32, 64, 128, 192, 255]) {
		const lab = toLab({ r: v, g: v, b: v });
		if (Math.abs(lab.a) > 1e-6 || Math.abs(lab.b) > 1e-6 || lab.l <= previousL) {
			labOk = false;
		}
		previousL = lab.l;
	}
	console.log(`  ${labOk ? "ok  " : "FAIL"}  sRGB -> CIELAB neutral axis`);
	if (!labOk) {
		failures++;
	}

	// Black on white is the maximum contrast sRGB can express.
	const extreme = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
	const contrastOk = Math.abs(extreme - 21) < 0.01;
	console.log(`  ${contrastOk ? "ok  " : "FAIL"}  WCAG contrast  black on white = ${extreme.toFixed(3)}:1, expected 21`);
	if (!contrastOk) {
		failures++;
	}

	// Compositing at 50% must land halfway, and at 0% must vanish.
	const half = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 });
	const none = composite({ r: 255, g: 0, b: 0, a: 0 }, { r: 10, g: 20, b: 30 });
	const compositeOk =
		Math.abs(half.r - 127.5) < 1e-9 && none.r === 10 && none.g === 20 && none.b === 30;
	console.log(`  ${compositeOk ? "ok  " : "FAIL"}  alpha compositing`);
	if (!compositeOk) {
		failures++;
	}

	// The JSONC masker must survive the constructs VS Code's own themes use, and must
	// not touch the same constructs inside a string.
	const jsoncCases: readonly (readonly [string, unknown, string])[] = [
		['{"a": 1} // tail', { a: 1 }, "line comment"],
		['{/* lead */ "a": 1}', { a: 1 }, "block comment"],
		['{"a": 1,\n}', { a: 1 }, "trailing comma in an object"],
		['{"a": [1, 2,\n]}', { a: [1, 2] }, "trailing comma in an array"],
		['{"a": 1, // why\n}', { a: 1 }, "trailing comma behind a comment"],
		['{"a": "// not a comment"}', { a: "// not a comment" }, "comment marker inside a string"],
		['{"a": "x, "}', { a: "x, " }, "comma inside a string"],
		['{"a": "b\\"// still a string"}', { a: 'b"// still a string' }, "escaped quote then a comment marker"],
	];
	for (const [text, expected, why] of jsoncCases) {
		let actual: unknown;
		try {
			actual = JSON.parse(stripJsonc(text));
		} catch (error) {
			actual = `threw: ${(error as Error).message}`;
		}
		const ok = JSON.stringify(actual) === JSON.stringify(expected);
		console.log(`  ${ok ? "ok  " : "FAIL"}  JSONC  ${why}`);
		if (!ok) {
			console.log(`        got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
			failures++;
		}
	}

	// requiredLightnessDelta must be exactly the dL* that scores MIN_SEMANTIC_DELTA_E
	// on its own. This is the claim the doc comment makes, so it is measured, not
	// asserted: a neutral pair separated by the required amount must land on 11 dE00.
	for (const lower of [10, 25, 40, 55, 70, 85]) {
		const lBar = lower + requiredLightnessDelta(lower) / 2;
		const delta = requiredLightnessDelta(lBar);
		const scored = deltaE2000({ l: lBar - delta / 2, a: 0, b: 0 }, { l: lBar + delta / 2, a: 0, b: 0 });
		const ok = Math.abs(scored - MIN_SEMANTIC_DELTA_E) < 1e-9;
		console.log(`  ${ok ? "ok  " : "FAIL"}  lightness rule  L* ${lBar.toFixed(1)}: dL* ${delta.toFixed(2)} scores dE00 ${scored.toFixed(4)}`);
		if (!ok) {
			failures++;
		}
	}
	// ...and the old flat 8 L* could not: that is why it stopped explaining anything.
	const flatEight = deltaE2000({ l: 46, a: 0, b: 0 }, { l: 54, a: 0, b: 0 });
	const flatOk = flatEight < MIN_SEMANTIC_DELTA_E;
	console.log(`  ${flatOk ? "ok  " : "FAIL"}  lightness rule  a flat 8 L* is worth only ${flatEight.toFixed(2)} dE00, never ${MIN_SEMANTIC_DELTA_E}`);
	if (!flatOk) {
		failures++;
	}

	// The registry crawl must find the ids we know VS Code registers three ways.
	const known = knownColorIds();
	const probes = ["editor.background", "terminal.ansiBrightWhite", "gitDecoration.addedResourceForeground"];
	for (const probe of probes) {
		const ok = known.has(probe);
		console.log(`  ${ok ? "ok  " : "FAIL"}  registry crawl finds ${probe}`);
		if (!ok) {
			failures++;
		}
	}
	console.log(`  note  ${known.size} colour ids registered across src/vs and bundled extensions`);

	console.log(failures === 0 ? "\nvalidateTheme self-test passed." : `\nvalidateTheme self-test FAILED (${failures}).`);
	return failures === 0 ? 0 : 1;
}

function shippingThemePaths(): readonly string[] {
	return readdirSync(SHIPPING_THEMES_DIR)
		.filter((name) => name.endsWith("-color-theme.json"))
		.sort()
		.map((name) => join(SHIPPING_THEMES_DIR, name));
}

/**
 * JSONC -> JSON: blank out comments and trailing commas, in place.
 *
 * A VS Code colour theme is JSONC, not JSON. The workbench parses one with
 * `Json.parse` from vs/base/common/json (see
 * src/vs/workbench/services/themes/common/colorThemeData.ts, _loadColorTheme), which
 * accepts `//` and comments and a trailing comma before a closing brace or
 * bracket. Eight of the ten upstream theme files in this checkout use them, and a
 * validator that cannot read a hand-edited or upstream theme is a safety net with a
 * hole exactly where the hand edits are.
 *
 * Comment bytes are replaced with spaces rather than removed, and newlines inside a
 * block comment are kept, so a parse error still reports the line and column the
 * author would have to look at.
 *
 * This is not a general JSONC parser: it never interprets the document, only masks
 * the two constructs plain JSON.parse rejects. The only state it has to track is
 * whether it is inside a string literal, because `"// not a comment"` is a value.
 */
function stripJsonc(text: string): string {
	const out = text.split("");
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; ) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			i++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") out[i++] = " ";
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end === -1 ? text.length : end + 2;
			for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
			continue;
		}
		i++;
	}

	// Trailing commas, over the comment-masked text so a comma followed only by a
	// comment and a brace is caught too.
	const masked = out.join("");
	inString = false;
	escaped = false;
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch !== ",") continue;
		let j = i + 1;
		while (j < masked.length && /\s/.test(masked[j])) j++;
		if (masked[j] === "}" || masked[j] === "]") out[i] = " ";
	}
	return out.join("");
}

function readTheme(path: string): ColorTheme {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${path}: ${(error as Error).message}`);
	}
	try {
		return JSON.parse(stripJsonc(raw)) as ColorTheme;
	} catch (error) {
		throw new Error(`cannot parse ${path}: ${(error as Error).message}`);
	}
}

function printFindings(label: string, findings: readonly Finding[]): void {
	if (findings.length === 0) {
		return;
	}
	console.log(`  ${label} (${findings.length}):`);
	for (const finding of findings) {
		console.log(`    [${finding.check}] ${finding.token}`);
		console.log(`      measured  ${finding.measured}`);
		console.log(`      threshold ${finding.threshold}`);
		console.log(`      ${finding.detail}`);
	}
}

function main(argv: readonly string[]): number {
	const asJson = argv.includes("--json");
	const paths = argv.filter((arg) => !arg.startsWith("--"));
	const targets = paths.length > 0 ? paths.map((p) => resolve(p)) : shippingThemePaths();

	const report: {
		theme: string;
		name: string;
		ok: boolean;
		errors: readonly Finding[];
		warnings: readonly Finding[];
	}[] = [];
	let failed = 0;

	for (const path of targets) {
		const theme = readTheme(path);
		const result = validate(theme);
		if (!result.ok) {
			failed++;
		}
		report.push({
			theme: relative(ROOT, path),
			name: theme.name ?? "(unnamed)",
			ok: result.ok,
			errors: result.errors,
			warnings: result.warnings,
		});
	}

	if (asJson) {
		console.log(JSON.stringify(report, null, 2));
		return failed > 0 ? 1 : 0;
	}

	for (const entry of report) {
		const verdict = entry.ok ? "PASS" : "FAIL";
		console.log(
			`${verdict}  ${entry.name}  (${entry.theme})  ${entry.errors.length} error(s), ${entry.warnings.length} warning(s)`
		);
		printFindings("errors", entry.errors);
		printFindings("warnings", entry.warnings);
		console.log("");
	}
	console.log(
		`${report.length} theme(s) checked, ${failed} failed, ` +
			`${report.reduce((n, e) => n + e.errors.length, 0)} error(s), ` +
			`${report.reduce((n, e) => n + e.warnings.length, 0)} warning(s).`
	);
	return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	try {
		process.exit(process.argv.includes("--self-test") ? selfTest() : main(process.argv.slice(2)));
	} catch (error) {
		console.error(`validateTheme: ${(error as Error).message}`);
		process.exit(2);
	}
}
