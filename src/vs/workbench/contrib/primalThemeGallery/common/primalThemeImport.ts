/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatHexaColor, tryParseHexColor, type Rgba } from '../../../../base/common/primalColorScience.js';
import { localize } from '../../../../nls.js';
import { ALL_PALETTE_SLOTS, paletteToColors } from './primalPaletteMapping.js';

/**
 * Reading a palette or a colour theme a user pastes in.
 *
 * THREAT MODEL — what this deliberately does NOT do, and why.
 *
 * 1. It never installs an extension and never fetches a VSIX. A VSIX is
 *    executable code that runs with the user's privileges on load; a colour
 *    theme is inert JSON. In this fork the usual brakes are off anyway:
 *    `product.json` sets `controlUrl` to the empty string, which short-circuits
 *    the malicious-extension manifest and makes the `isMalicious` gate
 *    structurally unreachable, and `installVSIX` checks only workspace trust —
 *    no signature, no publisher trust. "Install this theme from a URL" would
 *    therefore be arbitrary code execution behind a colour swatch.
 *
 * 2. It never fetches anything at all. Input is text the user pasted, so there
 *    is no request for an attacker to point at a metadata endpoint, no
 *    redirect to follow to another origin, no credential to leak, and no SSRF
 *    surface. `IRequestService` is not covered by `workbench.trustedDomains`
 *    (that gates `IOpenerService.open` only), so a fetch here would have been
 *    unguarded by anything the user can see or configure.
 *
 * 3. It refuses `include`. A theme JSON may inherit from a sibling file by
 *    relative path; following that turns "paste some colours" into "read a file
 *    of the pasted document's choosing".
 *
 * 4. It refuses a string `tokenColors`. That form is a path to a `.tmTheme`
 *    plist, i.e. another file read, and a second parser besides.
 *
 * 5. It caps the input length, the number of colours and the number of token
 *    rules, so a pasted blob cannot wedge the renderer or bloat settings.json.
 *
 * 6. It validates every hex itself and reports failures as WORDS. It must not
 *    hand values to `Color.fromHex`, which answers anything unparseable with
 *    `Color.red` — a parse error reported by hue, to a colour-blind user.
 *
 * What it produces is a plain colour map. The caller writes that to
 * `workbench.colorCustomizations`, which is inert, persisted, visible in
 * settings.json and reversible with one command.
 */

/** The largest document that will be read. A full 449-colour theme is well under 100 KB. */
export const MAX_IMPORT_BYTES = 256 * 1024;

/** More colour ids than any real theme declares. */
export const MAX_IMPORT_COLORS = 2000;

/** More TextMate rules than any real theme declares. */
export const MAX_IMPORT_TOKEN_RULES = 2000;

/** Workbench colour ids are dotted lowerCamelCase words; nothing else is accepted. */
const COLOR_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

/** What kind of document was recognised. */
export type PrimalImportKind = 'colorTheme' | 'palette';

/** One reason an import was refused, or one value inside it that could not be read. */
export interface IPrimalImportProblem {
	/** The key, colour id or slot at fault, when there is one. */
	readonly at?: string;
	/** Plain English, already localized. */
	readonly message: string;
}

/** A document that was read successfully. */
export interface IPrimalImportedTheme {
	readonly kind: PrimalImportKind;
	/** The name the document gave itself, or a fallback. */
	readonly name: string;
	/**
	 * Colour id -> the CANONICAL hex string, for `workbench.colorCustomizations`.
	 *
	 * Canonical, not the input text: the value that is measured for the readability
	 * verdict and the value that is written to settings have to be the same colour.
	 * `"#00ff00 "` validates once trimmed but is length 8, and `Color.fromHex`
	 * branches on length alone — it would answer `Color.red`, i.e. report a parse
	 * error by hue, for a value this module already told the user was fine.
	 */
	readonly colors: ReadonlyMap<string, string>;
	/** The same colours parsed, for the readability checks. */
	readonly parsedColors: ReadonlyMap<string, Rgba>;
	/** TextMate scope -> parsed foreground, for the comment-contrast check. */
	readonly scopeForegrounds: ReadonlyMap<string, Rgba>;
	/** Values that were skipped: malformed hexes, unusable ids. Never silently dropped. */
	readonly problems: readonly IPrimalImportProblem[];
}

/** The outcome of reading a pasted document. */
export type PrimalImportResult =
	| { readonly ok: true; readonly theme: IPrimalImportedTheme }
	| { readonly ok: false; readonly problems: readonly IPrimalImportProblem[] };

function refuse(message: string, at?: string): PrimalImportResult {
	return { ok: false, problems: [{ at, message }] };
}

/** True for a record-shaped value; `unknown` in, narrowed out. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one scalar off the right-hand side of a `key: value` line.
 *
 * A quoted scalar ends at its closing quote; an unquoted one ends at the end of
 * the line or at a ` #` comment. Both forms have to drop a trailing comment,
 * because that is how most of the vendored corpus is written
 * (`base00: "#1e1e2e" # base`) — taking the rest of the line verbatim leaves the
 * closing quote and the comment glued to the colour, and every slot is then
 * refused as a malformed hex.
 */
function readFlatScalar(rest: string): string | undefined {
	const quoted = /^"([^"]*)"|^'([^']*)'/.exec(rest);
	if (quoted) {
		const tail = rest.slice(quoted[0].length).trim();
		if (tail.length > 0 && !tail.startsWith('#')) {
			return undefined; // something follows the value that this reader does not model
		}
		return quoted[1] ?? quoted[2];
	}
	if (rest.startsWith('"') || rest.startsWith('\'')) {
		return undefined; // an unterminated quote is not a scalar
	}
	// An unquoted scalar runs to the end of the line or to a ` #` comment. The
	// leading '#' of a bare hex is not a comment: a comment needs whitespace in
	// front of it, which is the rule the corpus is written to.
	return rest.replace(/\s+#.*$/, '').trim();
}

/**
 * Reads the flat `key: value` form a base16 scheme is usually distributed in,
 * optionally with the colours nested one level under `palette:`.
 *
 * This is NOT a YAML parser and does not try to be. It models exactly the shape
 * the corpus uses — scalars, trailing comments and one nested map — and refuses
 * every line it does not model, because a lenient reader that skipped what it
 * did not understand would hand the caller a palette with a plausible missing
 * slot.
 */
function parseFlatPaletteText(text: string): Record<string, string> | undefined {
	const values: Record<string, string> = {};
	let sawColon = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+$/, '');
		if (line.trim().length === 0 || line.trim().startsWith('#')) {
			continue;
		}
		const match = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!match) {
			return undefined; // a construct this reader does not model
		}
		sawColon = true;
		const value = readFlatScalar(match[3].trim());
		if (value === undefined) {
			return undefined;
		}
		if (value.length > 0) {
			values[match[2]] = value;
		}
	}
	return sawColon ? values : undefined;
}

/** Pulls the palette slots out of either palette encoding. */
function readPaletteSlots(source: Record<string, unknown>): ReadonlyMap<string, string> {
	const nested = isRecord(source.palette) ? source.palette : source;
	const slots = new Map<string, string>();
	for (const slot of ALL_PALETTE_SLOTS) {
		const value = nested[slot];
		if (typeof value === 'string') {
			// Corpus schemes write bare hex digits; VS Code wants a leading '#'.
			// Trimmed first: a slot with trailing whitespace would otherwise be
			// prefixed into a string that validates trimmed but is stored raw.
			const text = value.trim();
			slots.set(slot, text.startsWith('#') ? text : `#${text}`);
		}
	}
	return slots;
}

/** Validates a colour map, keeping only well-formed ids with parseable values. */
function readColors(
	raw: Record<string, unknown>,
	problems: IPrimalImportProblem[]
): { readonly colors: Map<string, string>; readonly parsed: Map<string, Rgba> } {
	const colors = new Map<string, string>();
	const parsed = new Map<string, Rgba>();
	for (const [colorId, value] of Object.entries(raw)) {
		if (colors.size >= MAX_IMPORT_COLORS) {
			problems.push({ message: localize('primalImport.tooManyColors', "Stopped after {0} colours; the rest were ignored.", MAX_IMPORT_COLORS) });
			break;
		}
		if (!COLOR_ID_PATTERN.test(colorId)) {
			problems.push({ at: colorId, message: localize('primalImport.badId', "Not a workbench colour id, so it was skipped.") });
			continue;
		}
		if (typeof value !== 'string') {
			problems.push({ at: colorId, message: localize('primalImport.notAString', "The value is not text, so it was skipped.") });
			continue;
		}
		const rgba = value.startsWith('#') ? tryParseHexColor(value) : undefined;
		if (!rgba) {
			problems.push({ at: colorId, message: localize('primalImport.badHex', "\"{0}\" is not a colour. Expected #RGB, #RGBA, #RRGGBB or #RRGGBBAA.", value) });
			continue;
		}
		// The canonical form of what was PARSED, never the input text: the value
		// written to settings has to be the same colour the verdict measured.
		colors.set(colorId, formatHexaColor(rgba));
		parsed.set(colorId, rgba);
	}
	return { colors, parsed };
}

/** Reads the TextMate rules, keeping only the scope foregrounds the checks need. */
function readScopeForegrounds(rules: readonly unknown[], problems: IPrimalImportProblem[]): Map<string, Rgba> {
	const foregrounds = new Map<string, Rgba>();
	for (const rule of rules.slice(0, MAX_IMPORT_TOKEN_RULES)) {
		if (!isRecord(rule) || !isRecord(rule.settings)) {
			continue;
		}
		const foreground = rule.settings.foreground;
		if (typeof foreground !== 'string') {
			continue;
		}
		const rgba = foreground.startsWith('#') ? tryParseHexColor(foreground) : undefined;
		if (!rgba) {
			problems.push({ at: String(rule.scope ?? ''), message: localize('primalImport.badScopeHex', "\"{0}\" is not a colour, so this syntax rule was skipped.", foreground) });
			continue;
		}
		const scope = rule.scope;
		const scopes = typeof scope === 'string'
			? scope.split(',').map(entry => entry.trim())
			: Array.isArray(scope) ? scope.filter((entry): entry is string => typeof entry === 'string') : [];
		for (const entry of scopes) {
			if (!foregrounds.has(entry)) {
				foregrounds.set(entry, rgba);
			}
		}
	}
	if (rules.length > MAX_IMPORT_TOKEN_RULES) {
		problems.push({ message: localize('primalImport.tooManyRules', "Stopped after {0} syntax rules; the rest were ignored.", MAX_IMPORT_TOKEN_RULES) });
	}
	return foregrounds;
}

/**
 * Reads a pasted colour theme or base16/base24 palette.
 *
 * Never throws and never fetches. Everything it refuses, it names.
 */
export function readImportedTheme(text: string): PrimalImportResult {
	if (text.trim().length === 0) {
		return refuse(localize('primalImport.empty', "Nothing was pasted."));
	}
	if (text.length > MAX_IMPORT_BYTES) {
		return refuse(localize('primalImport.tooLarge', "That is larger than the {0} KB limit for a pasted theme.", Math.floor(MAX_IMPORT_BYTES / 1024)));
	}

	let document: Record<string, unknown> | undefined;
	const trimmed = text.trim();
	if (trimmed.startsWith('{')) {
		try {
			const value: unknown = JSON.parse(trimmed);
			if (!isRecord(value)) {
				return refuse(localize('primalImport.notAnObject', "A theme or palette has to be a JSON object."));
			}
			document = value;
		} catch (error) {
			return refuse(localize('primalImport.badJson', "That is not valid JSON: {0}", error instanceof Error ? error.message : String(error)));
		}
	} else {
		const flat = parseFlatPaletteText(trimmed);
		if (!flat) {
			return refuse(localize('primalImport.unrecognised', "Expected a colour theme in JSON, or a base16/base24 palette as JSON or as plain 'slot: #hex' lines."));
		}
		document = flat;
	}

	if (typeof document.include === 'string') {
		return refuse(localize('primalImport.include', "This theme inherits from another file. Only self-contained themes can be imported."), 'include');
	}
	if (typeof document.tokenColors === 'string') {
		return refuse(localize('primalImport.tmTheme', "This theme points its syntax colours at a separate TextMate file. Only self-contained themes can be imported."), 'tokenColors');
	}

	const problems: IPrimalImportProblem[] = [];
	const name = typeof document.name === 'string' && document.name.trim().length > 0
		? document.name.trim().slice(0, 120)
		: localize('primalImport.untitled', "Imported colours");

	if (isRecord(document.colors)) {
		const { colors, parsed } = readColors(document.colors, problems);
		if (colors.size === 0) {
			return { ok: false, problems: problems.length > 0 ? problems : [{ message: localize('primalImport.noColors', "The theme declares no colours this build could read.") }] };
		}
		const scopeForegrounds = Array.isArray(document.tokenColors)
			? readScopeForegrounds(document.tokenColors, problems)
			: new Map<string, Rgba>();
		return { ok: true, theme: { kind: 'colorTheme', name, colors, parsedColors: parsed, scopeForegrounds, problems } };
	}

	const slots = readPaletteSlots(document);
	if (slots.size === 0) {
		return refuse(localize('primalImport.noSlots', "No base16 or base24 slots and no 'colors' object were found."));
	}
	const mapped = paletteToColors(slots);
	const { colors, parsed } = readColors(Object.fromEntries(mapped), problems);
	if (colors.size === 0) {
		return { ok: false, problems: problems.length > 0 ? problems : [{ message: localize('primalImport.noUsableSlots', "None of the palette's slots held a colour this build could read.") }] };
	}
	return { ok: true, theme: { kind: 'palette', name, colors, parsedColors: parsed, scopeForegrounds: new Map<string, Rgba>(), problems } };
}
