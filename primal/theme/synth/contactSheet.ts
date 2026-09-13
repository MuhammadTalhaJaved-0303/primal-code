#!/usr/bin/env node --experimental-strip-types
/**
 * `primal/design/contact-sheet.html` - how one human reviews sixty families
 * without opening sixty editors.
 *
 * GENERATED, NEVER HAND-EDITED, in the same discipline as `ATTRIBUTION.md`, and
 * built FROM THE EMITTED THEME JSON rather than from the spec that produced it.
 * That is the whole point: a sheet drawn from the intent would picture what the
 * generator MEANT, and the question a reviewer is being asked is what it DID.
 * Every colour on every card is read out of `theme.colors` and
 * `theme.tokenColors` by name.
 *
 * THREE THINGS MAKE IT A REVIEW RATHER THAN A GALLERY
 *
 *   1. The cards are sorted by ASCENDING nearest-neighbour `D_owner`, so the
 *      first screen is where the duplicates are. A reviewer is not sampling; he
 *      is being shown the worst cases first.
 *   2. A twins strip above the grid shows the closest pairs side by side with
 *      their measured distance and WHAT ADMITTED THEM - a register difference,
 *      an emphasis difference, or, for a pair with neither, the distance the six
 *      non-ground slots keep on their own. The label is three-way because the
 *      rule is; a reviewer told "separated by emphasis" for a pair whose
 *      emphasis is identical goes looking for a bold that is not there.
 *   3. Every card appears twice: once as a trichromat sees it and once as a
 *      deuteranope does, through `cvd.ts`'s own simulation. For this owner the
 *      second grid is the real one, and putting it second rather than instead is
 *      what lets him see what he is missing rather than only what he has.
 *
 * No JavaScript, no network, no fonts but the system stack: the file has to open
 * from disk in ten years and still be the artefact it was signed against.
 */

import { simulateCvd, type CvdType } from "../cvd.ts";
import { parseHex } from "../color.ts";
import type { ColorTheme } from "../generateTheme.ts";
import type { Depth } from "../importPalette.ts";
import { closestPairs, nearestNeighbours, type FamilyIdentity } from "./distinct.ts";

/** One family as the sheet pictures it: the emitted themes, and how it was made. */
export interface SheetEntry {
	readonly key: string;
	readonly label: string;
	readonly identity: FamilyIdentity;
	/** The emitted theme at each depth this family expresses. The medium one is the card. */
	readonly themes: ReadonlyMap<Depth, ColorTheme>;
	/** `"synthesised"`, `"vibe"` or `"corpus"` - a reviewer needs to know what he is looking at. */
	readonly origin: string;
	/** One line under the title: the register, the margins, the approval state. */
	readonly caption: string;
	/** sha256 of the card payload, which is what an approval signs. */
	readonly sheetHash: string;
}

/** How many closest pairs the twins strip shows. */
const TWINS = 20;

/** Fourteen lines of representative code, coloured by the theme's real token rules. */
const CODE: readonly { readonly role: string; readonly text: string; readonly indent: number }[] = [
	{ role: "comment", text: "// the plane, the ink, and everything placed against them", indent: 0 },
	{ role: "keyword", text: "export", indent: 0 },
	{ role: "type", text: "interface Ledger {", indent: 0 },
	{ role: "operator", text: "readonly", indent: 1 },
	{ role: "function", text: "measure(slot: string): number;", indent: 1 },
	{ role: "operator", text: "}", indent: 0 },
	{ role: "keyword", text: "function", indent: 0 },
	{ role: "function", text: "place(frontier: number, air: number) {", indent: 0 },
	{ role: "keyword", text: "const", indent: 1 },
	{ role: "editorFg", text: "step = frontier + air;", indent: 1 },
	{ role: "string", text: "\"never below the contrast floor\"", indent: 1 },
	{ role: "constant", text: "0x1F, 10.05, true", indent: 1 },
	{ role: "comment", text: "// comments sit where the house puts them", indent: 1 },
	{ role: "operator", text: "}", indent: 0 }
];

/** The scope `tokenMap.ts` routes each code role through, so the card reads the real rule. */
const ROLE_SCOPE: Readonly<Record<string, string>> = {
	comment: "comment",
	keyword: "keyword",
	string: "string",
	function: "entity.name.function",
	type: "entity.name.type",
	constant: "constant.numeric",
	operator: "keyword.operator"
};

const ANSI_TOKENS: readonly string[] = [
	"terminal.ansiBlack", "terminal.ansiRed", "terminal.ansiGreen", "terminal.ansiYellow",
	"terminal.ansiBlue", "terminal.ansiMagenta", "terminal.ansiCyan", "terminal.ansiWhite",
	"terminal.ansiBrightBlack", "terminal.ansiBrightRed", "terminal.ansiBrightGreen", "terminal.ansiBrightYellow",
	"terminal.ansiBrightBlue", "terminal.ansiBrightMagenta", "terminal.ansiBrightCyan", "terminal.ansiBrightWhite"
];

const GIT_TOKENS: readonly { readonly token: string; readonly label: string }[] = [
	{ token: "gitDecoration.addedResourceForeground", label: "added" },
	{ token: "gitDecoration.modifiedResourceForeground", label: "modified" },
	{ token: "gitDecoration.deletedResourceForeground", label: "deleted" },
	{ token: "gitDecoration.untrackedResourceForeground", label: "untracked" }
];

const SEVERITY_TOKENS: readonly { readonly token: string; readonly label: string }[] = [
	{ token: "editorError.foreground", label: "error" },
	{ token: "editorWarning.foreground", label: "warning" },
	{ token: "editorInfo.foreground", label: "info" }
];

// ---------------------------------------------------------------------------
// Reading the artefact
// ---------------------------------------------------------------------------

function colour(theme: ColorTheme, token: string, fallback: string): string {
	const value = theme.colors?.[token];
	return typeof value === "string" ? value : fallback;
}

/** The foreground the theme's own `tokenColors` give a scope, most specific rule last wins. */
function scopeColour(theme: ColorTheme, scope: string, fallback: string): string {
	let found = fallback;
	for (const rule of theme.tokenColors ?? []) {
		const scopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === "string" ? rule.scope.split(",").map(s => s.trim()) : [];
		if (scopes.includes(scope) && typeof rule.settings?.foreground === "string") {
			found = rule.settings.foreground;
		}
	}
	return found;
}

/** True when the theme's own rule paints this scope bold. Cards show weight because Ridge proves it is an axis. */
function scopeIsBold(theme: ColorTheme, scope: string): boolean {
	let bold = false;
	for (const rule of theme.tokenColors ?? []) {
		const scopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === "string" ? rule.scope.split(",").map(s => s.trim()) : [];
		if (scopes.includes(scope) && typeof rule.settings?.fontStyle === "string") {
			bold = rule.settings.fontStyle.includes("bold");
		}
	}
	return bold;
}

/**
 * A colour as one observer sees it, or unchanged for a trichromat.
 *
 * A SEMI-TRANSPARENT VALUE IS COMPOSITED FIRST, over `over`, in gamma-encoded
 * sRGB - exactly the way `validateTheme.composite` does it and exactly the way
 * VS Code paints it. Dropping the alpha instead would put a colour on the card
 * that the theme does not ship: Basalt's removed-line wash is `#FAD2CB40`, a
 * near-white at 25%, which flattens to a dim mauve over its own plane and would
 * otherwise be pictured as bright pink. The sheet has one job, which is to show
 * the artefact; a swatch that lies is worse than no swatch.
 *
 * The simulation runs AFTER the composite, because that is the order the eye
 * does it in.
 */
function seenAs(hex: string, observer: CvdType | null, over: string = "#000000"): string {
	const rgb = parseHex(hex);
	let flat = { r: rgb.r, g: rgb.g, b: rgb.b };
	if (rgb.alpha < 1) {
		const plane = parseHex(over);
		flat = {
			r: rgb.r * rgb.alpha + plane.r * (1 - rgb.alpha),
			g: rgb.g * rgb.alpha + plane.g * (1 - rgb.alpha),
			b: rgb.b * rgb.alpha + plane.b * (1 - rgb.alpha)
		};
	}
	const seen = observer === null ? flat : simulateCvd(flat, observer);
	const byte = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).toUpperCase().padStart(2, "0");
	return `#${byte(seen.r)}${byte(seen.g)}${byte(seen.b)}`;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function renderCard(entry: SheetEntry, observer: CvdType | null, nearest: { readonly key: string; readonly distance: number } | null): string {
	const theme = entry.themes.get("medium") ?? [...entry.themes.values()][0];
	if (theme === undefined) {
		return "";
	}
	const editorBg = colour(theme, "editor.background", "#000000");
	// Everything on the card is composited over the plane it is actually painted
	// over, so a semi-transparent token shows the colour the user sees.
	const see = (hex: string, over: string = editorBg): string => seenAs(hex, observer, over);
	const editorFg = colour(theme, "editor.foreground", "#FFFFFF");
	const chromeBg = colour(theme, "titleBar.activeBackground", editorBg);
	const sideBg = colour(theme, "sideBar.background", editorBg);
	const border = colour(theme, "editorGroup.border", editorBg);
	const lineHighlight = colour(theme, "editor.lineHighlightBackground", editorBg);
	const selection = colour(theme, "editor.selectionBackground", editorBg);

	const codeLines = CODE.map(line => {
		const hex = line.role === "editorFg" ? editorFg : scopeColour(theme, ROLE_SCOPE[line.role] ?? "", editorFg);
		const bold = line.role !== "editorFg" && scopeIsBold(theme, ROLE_SCOPE[line.role] ?? "");
		const style = `color:${see(hex)}${bold ? ";font-weight:700" : ""}`;
		return `<div class="ln" style="padding-left:${line.indent * 14}px"><span style="${style}">${escapeHtml(line.text)}</span></div>`;
	}).join("");

	const ansi = ANSI_TOKENS.map(token => {
		const hex = colour(theme, token, editorBg);
		return `<i style="background:${see(hex, colour(theme, "terminal.background", editorBg))}" title="${token} ${hex}"></i>`;
	}).join("");

	const git = GIT_TOKENS.map(entryToken => {
		const hex = colour(theme, entryToken.token, editorFg);
		return `<span style="color:${see(hex, sideBg)}">${entryToken.label}</span>`;
	}).join("");

	const severity = SEVERITY_TOKENS.map(entryToken => {
		const hex = colour(theme, entryToken.token, editorFg);
		return `<span style="color:${see(hex)}">${entryToken.label}</span>`;
	}).join("");

	const added = colour(theme, "diffEditor.insertedLineBackground", editorBg);
	const removed = colour(theme, "diffEditor.removedLineBackground", editorBg);

	const near = nearest === null ? "" : `<div class="near">nearest <b>${escapeHtml(nearest.key)}</b> at D<sub>owner</sub> ${nearest.distance.toFixed(2)}</div>`;

	return `<article class="card" style="--bg:${see(editorBg)};--fg:${see(editorFg)};--chrome:${see(chromeBg)};--side:${see(sideBg)};--border:${see(border)}">
<header><h3>${escapeHtml(entry.label)}</h3><span class="origin">${escapeHtml(entry.origin)}</span></header>
<div class="mock">
<div class="tabs"><span class="tab active">ledger.ts</span><span class="tab">ramp.ts</span></div>
<div class="body">
<div class="side">${git}</div>
<div class="editor">
<div class="line-highlight" style="background:${see(lineHighlight)}"></div>
${codeLines}
<div class="selection" style="background:${see(selection)};color:${see(editorFg)}">selected text on the band</div>
<div class="wash" style="background:${see(added)};color:${see(editorFg)}">+ inserted line</div>
<div class="wash" style="background:${see(removed)};color:${see(editorFg)}">- removed line</div>
<div class="severity">${severity}</div>
</div>
</div>
<div class="ansi">${ansi}</div>
</div>
<div class="caption">${escapeHtml(entry.caption)}</div>
${near}
<div class="hash" title="the sha256 an approval signs">${escapeHtml(entry.sheetHash.slice(0, 16))}</div>
</article>`;
}

function renderTwins(entries: readonly SheetEntry[], observer: CvdType | null): string {
	const byKey = new Map(entries.map(entry => [entry.key, entry]));
	const pairs = closestPairs(entries.map(entry => entry.identity)).slice(0, TWINS);
	const rows = pairs.map(pair => {
		const a = byKey.get(pair.a);
		const b = byKey.get(pair.b);
		if (a === undefined || b === undefined) {
			return "";
		}
		const swatch = (entry: SheetEntry): string => {
			const theme = entry.themes.get("medium") ?? [...entry.themes.values()][0];
			if (theme === undefined) {
				return "";
			}
			const bits = ["editor.background", "editor.foreground"].map(token => seenAs(colour(theme, token, "#000000"), observer));
			const keyword = seenAs(scopeColour(theme, "keyword", "#FFFFFF"), observer);
			const str = seenAs(scopeColour(theme, "string", "#FFFFFF"), observer);
			return `<span class="twin" style="background:${bits[0]}"><i style="background:${bits[1]}"></i><i style="background:${keyword}"></i><i style="background:${str}"></i></span>`;
		};
		return `<tr><td class="d">${pair.distance.toFixed(2)}</td><td>${swatch(a)} ${escapeHtml(a.label)}</td><td>${swatch(b)} ${escapeHtml(b.label)}</td><td class="why">${escapeHtml(pair.admitted)}</td></tr>`;
	}).join("");
	return `<table class="twins"><thead><tr><th>D<sub>owner</sub></th><th>this family</th><th>and this one</th><th>what admitted the pair</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f5f3; color: #1c1a18; }
@media (prefers-color-scheme: dark) { body { background: #131211; color: #e8e4de; } }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 32px 0 8px; }
p.lede { margin: 0 0 16px; max-width: 78ch; opacity: 0.8; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.card { border: 1px solid rgba(128,128,128,0.35); border-radius: 6px; overflow: hidden; background: var(--chrome); }
.card header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 6px 10px; background: var(--chrome); color: var(--fg); border-bottom: 1px solid var(--border); }
.card h3 { font-size: 13px; margin: 0; font-weight: 600; }
.origin { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.65; }
.mock { background: var(--bg); color: var(--fg); }
.tabs { display: flex; background: var(--chrome); border-bottom: 1px solid var(--border); }
.tab { padding: 4px 10px; font-size: 11px; opacity: 0.6; }
.tab.active { background: var(--bg); opacity: 1; }
.body { display: flex; }
.side { width: 88px; padding: 8px 6px; background: var(--side); display: flex; flex-direction: column; gap: 3px; font-size: 10px; border-right: 1px solid var(--border); }
.editor { position: relative; flex: 1; padding: 8px 10px; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow: hidden; }
.line-highlight { position: absolute; left: 0; right: 0; top: 8px; height: 16px; }
.ln { position: relative; white-space: pre; }
.selection, .wash { margin-top: 4px; padding: 1px 4px; white-space: pre; }
.severity { margin-top: 6px; display: flex; gap: 10px; font-size: 10px; }
.ansi { display: grid; grid-template-columns: repeat(8, 1fr); }
.ansi i { display: block; height: 14px; }
.caption { padding: 6px 10px; font-size: 10.5px; background: var(--chrome); color: var(--fg); opacity: 0.85; border-top: 1px solid var(--border); }
.near { padding: 0 10px 6px; font-size: 10.5px; background: var(--chrome); color: var(--fg); opacity: 0.7; }
.hash { padding: 0 10px 6px; font: 10px ui-monospace, monospace; background: var(--chrome); color: var(--fg); opacity: 0.45; }
table.twins { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 8px; }
table.twins th, table.twins td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(128,128,128,0.25); vertical-align: middle; }
td.d { font: 12px ui-monospace, monospace; }
td.why { opacity: 0.75; }
.twin { display: inline-flex; gap: 2px; padding: 2px; border-radius: 3px; vertical-align: middle; }
.twin i { display: block; width: 9px; height: 12px; border-radius: 1px; }
.note { max-width: 78ch; opacity: 0.75; }
`;

/**
 * Renders the whole sheet: twins strip, trichromat grid, deuteranope grid.
 *
 * Sorted by ascending nearest-neighbour distance in BOTH grids, using the same
 * order, so a card sits in the same position in each and the two can be compared
 * by scrolling rather than by hunting.
 */
export function renderContactSheet(entries: readonly SheetEntry[], generatedBy: string): string {
	const identities = entries.map(entry => entry.identity);
	const neighbours = new Map(nearestNeighbours(identities).map(row => [row.key, row]));
	const ordered = [...entries].sort((a, b) => {
		const da = neighbours.get(a.key)?.distance ?? Number.POSITIVE_INFINITY;
		const db = neighbours.get(b.key)?.distance ?? Number.POSITIVE_INFINITY;
		return da - db || a.key.localeCompare(b.key);
	});
	const grid = (observer: CvdType | null): string =>
		`<div class="grid">${ordered.map(entry => {
			const row = neighbours.get(entry.key);
			return renderCard(entry, observer, row === undefined ? null : { key: row.nearest, distance: row.distance });
		}).join("")}</div>`;

	const worst = ordered[0];
	const worstDistance = worst === undefined ? 0 : neighbours.get(worst.key)?.distance ?? 0;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Primal theme contact sheet</title>
<!-- GENERATED by ${escapeHtml(generatedBy)}. Do not edit; your changes will be
     overwritten on the next build. Every colour on this page is read out of the
     emitted theme JSON, so it pictures the artefact and not the intent. -->
<style>${STYLE}</style>
</head>
<body>
<h1>Primal theme contact sheet</h1>
<p class="lede">${entries.length} ${entries.length === 1 ? "family" : "families"}, each drawn from its own emitted theme file.
Cards are sorted by ASCENDING nearest-neighbour distance, so the worst cases are on the first screen - the closest pair in the
whole catalogue is <b>${worst === undefined ? "-" : escapeHtml(worst.label)}</b> at D<sub>owner</sub> ${worstDistance.toFixed(2)}.
Every card appears twice. The second grid is how a deuteranope sees it, and for this owner that grid is the real one.</p>

<h2>Twins - the ${TWINS} closest pairs, and what admitted each</h2>
<p class="note">A pair in the same syntax register and the same emphasis is admitted only when the six non-ground slots clear the
threshold on their own - whatever the two grounds do, so a ground alone can never buy a family. A pair in a different register
or emphasis is told apart by that. The last column reports which of the three it was, with the off-ground distance where that
is the whole case; the ground distance is printed for every pair so a shared ground is visible either way.</p>
${renderTwins(ordered, null)}

<h2>Trichromat</h2>
${grid(null)}

<h2>Deuteranope - the grid that decides</h2>
${grid("deuteranopia")}
</body>
</html>
`;
}

/** The nearest-neighbour table, for the build's own report. */
export function sheetOrder(entries: readonly SheetEntry[]): readonly { readonly key: string; readonly nearest: string; readonly distance: number }[] {
	return nearestNeighbours(entries.map(entry => entry.identity));
}
