#!/usr/bin/env node --experimental-strip-types
/**
 * The rule that expands a palette seed into a whole Primal colour theme.
 *
 * The six shipping themes under extensions/theme-primal/themes were hand-expanded
 * from the seeds in primal/design/vibe-tokens.json: ~449 workbench colours and 33
 * tokenColors each, written out by hand. That does not scale to a palette corpus,
 * and hand-written hexes cannot be checked for the contrast and colour-blindness
 * separation this product depends on.
 *
 * So the expansion is stated once, here, as data. Reading it back off the shipping
 * themes showed the 449 workbench colours take only 50 distinct values per theme:
 * every token is one palette slot, optionally with a fixed alpha suffix. This file
 * is that mapping, plus the slot vocabulary the generator has to fill in.
 *
 * The layering is:
 *
 *   variant seed + surfaces (vibe-tokens.json)
 *     -> synthesised semantics (generator; lightness-separated, never hue alone)
 *       -> mode slots (MODE_SLOT_RULES, below)
 *         -> WORKBENCH_TOKENS / TOKEN_COLOR_RULES  -> a colour theme JSON
 *
 * Every value here was derived from the real theme files, never guessed. Where no
 * rule reproduces a value, it is recorded as a literal in LITERAL entries with the
 * reason, or pinned per variant in vibe-tokens.json - an approximate rule that
 * "nearly" reproduces a shipping theme would be worse than an honest constant.
 *
 * Applying this map to the palettes in tokenMap.test-fixture.json reproduces all
 * six shipping themes exactly - colour for colour, key order included. Run the
 * check, which also re-verifies the fixture against the shipping themes:
 *
 *   node --experimental-strip-types primal/theme/tokenMap.ts --check
 *
 * This is one file and it is long, deliberately: WORKBENCH_TOKENS is a 449-row
 * table with one row per token, and splitting a table in half only makes the
 * rows harder to find. The logic in here is under a hundred lines.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ThemeMode = "light" | "dark";

/** Per-mode value. Light and dark planes invert, so a few rules must branch. */
export interface ByMode<T> {
	readonly light: T;
	readonly dark: T;
}

/** Slots a palette seed supplies directly (seed key === slot id). */
export type SeedSlotId =
	| "editorBg"
	| "chromeBg"
	| "sideBg"
	| "panelBg"
	| "editorFg"
	| "chromeFg"
	| "accent"
	| "border"
	| "selectionBg"
	| "lineHighlight"
	| "keyword"
	| "string"
	| "function"
	| "comment"
	| "type"
	| "constant"
	| "operator"
	| "ansiBlack"
	| "ansiRed"
	| "ansiGreen"
	| "ansiYellow"
	| "ansiBlue"
	| "ansiMagenta"
	| "ansiCyan"
	| "ansiWhite"
	| "ansiBrightBlack"
	| "ansiBrightRed"
	| "ansiBrightGreen"
	| "ansiBrightYellow"
	| "ansiBrightBlue"
	| "ansiBrightMagenta"
	| "ansiBrightCyan"
	| "ansiBrightWhite";

/** Slots a seed cannot state: chrome surfaces lifted off the planes. */
export type SurfaceSlotId =
	| "elevatedBg"
	| "hoverBg"
	| "inputBg"
	| "tabActiveBg"
	| "tabHoverBg"
	| "controlBorder"
	| "mutedFg"
	| "disabledFg"
	| "subtleFg"
	| "brightAccent"
	| "linkActiveFg";

/**
 * Slots the generator synthesises, so lightness separation is provable.
 *
 * Two independent ladders and one wash family, because those are the three
 * kinds of thing a user has to tell apart and they are never mixed in one
 * widget:
 *
 *   severity  error / warning / info      - squiggles, problem icons, badges
 *   diff      added / untracked / conflict / modified / deleted
 *                                         - gutter bars, ruler marks, SCM
 *   wash      the six semi-transparent diff backgrounds, which are measured
 *             AFTER compositing and so cannot be a rung of the diff ladder
 *
 * `untracked` used to be an alias of `added`, which made two states the
 * explorer shows side by side byte-identical - 0.00 dE00 to a trichromat, let
 * alone a dichromat. It is its own role now, with its own hue.
 */
export type SemanticSlotId =
	| "error"
	| "warning"
	| "info"
	| "added"
	| "deleted"
	| "modified"
	| "conflict"
	| "untracked"
	| "addedLineWash"
	| "deletedLineWash"
	| "addedInlineWash"
	| "deletedInlineWash"
	| "addedTextWash"
	| "deletedTextWash";

/** Slots that are an exact per-mode pick of another slot. */
export type ModeSlotId =
	| "onSemanticFg"
	| "emptyWindowBg"
	| "selectionOverlay"
	| "accentHoverBg"
	| "accentEmphasis";

/** Everything a token rule may name. */
export type SlotId = SeedSlotId | SurfaceSlotId | SemanticSlotId | ModeSlotId;

/** Required keys of a variant `seed` in vibe-tokens.json. */
export const SEED_SLOT_IDS: readonly SeedSlotId[] = [
	"editorBg",
	"chromeBg",
	"sideBg",
	"panelBg",
	"editorFg",
	"chromeFg",
	"accent",
	"border",
	"selectionBg",
	"lineHighlight",
	"keyword",
	"string",
	"function",
	"comment",
	"type",
	"constant",
	"operator",
	"ansiBlack",
	"ansiRed",
	"ansiGreen",
	"ansiYellow",
	"ansiBlue",
	"ansiMagenta",
	"ansiCyan",
	"ansiWhite",
	"ansiBrightBlack",
	"ansiBrightRed",
	"ansiBrightGreen",
	"ansiBrightYellow",
	"ansiBrightBlue",
	"ansiBrightMagenta",
	"ansiBrightCyan",
	"ansiBrightWhite",
];

/** Keys of a variant `surfaces` block; absent ones fall back to SURFACE_FALLBACKS. */
export const SURFACE_SLOT_IDS: readonly SurfaceSlotId[] = [
	"elevatedBg",
	"hoverBg",
	"inputBg",
	"tabActiveBg",
	"tabHoverBg",
	"controlBorder",
	"mutedFg",
	"disabledFg",
	"subtleFg",
	"brightAccent",
	"linkActiveFg",
];

/** Never present in a seed - the generator owns these. See vibe-tokens.json. */
export const SEMANTIC_SLOT_IDS: readonly SemanticSlotId[] = [
	"error",
	"warning",
	"info",
	"added",
	"deleted",
	"modified",
	"conflict",
	"untracked",
	"addedLineWash",
	"deletedLineWash",
	"addedInlineWash",
	"deletedInlineWash",
	"addedTextWash",
	"deletedTextWash",
];

/**
 * The semantic slots whose value already carries its own alpha. A token rule
 * that names one of these must not restate an alpha: the generator chose the
 * alpha as part of proving the composited pair apart, and overriding it would
 * silently undo that proof.
 */
export const SEMANTIC_WASH_SLOT_IDS: readonly SemanticSlotId[] = [
	"addedLineWash",
	"deletedLineWash",
	"addedInlineWash",
	"deletedInlineWash",
	"addedTextWash",
	"deletedTextWash",
];

/** Resolved by MODE_SLOT_RULES, not supplied by anyone. */
export const MODE_SLOT_IDS: readonly ModeSlotId[] = [
	"onSemanticFg",
	"emptyWindowBg",
	"selectionOverlay",
	"accentHoverBg",
	"accentEmphasis",
];

/** A reference a mode rule can resolve to. */
export type SlotRef = { readonly slot: SlotId } | { readonly literal: string };

export interface ModeSlotRule {
	readonly slot: ModeSlotId;
	readonly light: SlotRef;
	readonly dark: SlotRef;
	/** Evidence: the token this rule was read off, and why the branch exists. */
	readonly why: string;
}

/**
 * Five slots are an exact per-mode pick of another slot in all six shipping
 * themes - verified, not assumed. They exist because a light theme lifts these
 * roles off paper while a dark theme drops them into the plane.
 */
export const MODE_SLOT_RULES: readonly ModeSlotRule[] = [
	{
		slot: "onSemanticFg",
		light: { literal: "#FFFFFF" },
		dark: { slot: "editorBg" },
		why: "Text on an error/warning badge. Read off activityWarningBadge.foreground."
	},
	{
		slot: "emptyWindowBg",
		light: { slot: "chromeBg" },
		dark: { slot: "editorBg" },
		why: "Status bar with no folder open. Read off statusBar.noFolderBackground."
	},
	{
		slot: "selectionOverlay",
		light: { slot: "selectionBg" },
		dark: { slot: "accent" },
		why: "Host selection wash; dark themes tint it with the accent at 40 alpha. Read off selection.background."
	},
	{
		slot: "accentHoverBg",
		light: { slot: "chromeFg" },
		dark: { slot: "brightAccent" },
		why: "Primary button hover: light darkens toward chrome ink, dark brightens. Read off button.hoverBackground."
	},
	{
		slot: "accentEmphasis",
		light: { slot: "accent" },
		dark: { slot: "brightAccent" },
		why: "Accent text that must stay legible on the elevated plane. Read off chat.slashCommandForeground."
	}
];

/**
 * Fallbacks for a palette that does not pin a surface slot - a corpus palette
 * supplies planes, syntax and an ANSI ramp, never `hoverBg`.
 *
 * These are APPROXIMATE and no shipping vibe uses them: all six pin every
 * surface slot in vibe-tokens.json, because no mix reproduces the hand-authored
 * values exactly. `maxChannelError` is the largest 0-255 channel deviation the
 * fit shows against the shipping themes of that mode, measured, not estimated.
 * Treat anything above ~8 as "this slot really wants pinning".
 */
export interface SurfaceFallback {
	readonly from: SlotId;
	readonly light: { readonly toward: SlotId | "white" | "black"; readonly amount: number; readonly maxChannelError: number };
	readonly dark: { readonly toward: SlotId | "white" | "black"; readonly amount: number; readonly maxChannelError: number };
}

export const SURFACE_FALLBACKS: Readonly<Record<SurfaceSlotId, SurfaceFallback>> = {
	elevatedBg: {
		from: "editorBg",
		light: { toward: "border", amount: 0.23, maxChannelError: 2 },
		dark: { toward: "border", amount: 0.53, maxChannelError: 2 }
	},
	hoverBg: {
		from: "editorBg",
		light: { toward: "border", amount: 0.67, maxChannelError: 3 },
		dark: { toward: "border", amount: 0.79, maxChannelError: 3 }
	},
	inputBg: {
		from: "editorBg",
		light: { toward: "white", amount: 0.38, maxChannelError: 1 },
		dark: { toward: "border", amount: 0.21, maxChannelError: 3 }
	},
	tabActiveBg: {
		from: "editorBg",
		light: { toward: "white", amount: 0.98, maxChannelError: 0 },
		dark: { toward: "border", amount: 0.63, maxChannelError: 9 }
	},
	tabHoverBg: {
		from: "editorBg",
		light: { toward: "white", amount: 0.55, maxChannelError: 0 },
		dark: { toward: "border", amount: 0.33, maxChannelError: 5 }
	},
	controlBorder: {
		from: "border",
		light: { toward: "chromeFg", amount: 0.11, maxChannelError: 7 },
		dark: { toward: "chromeFg", amount: 0.09, maxChannelError: 3 }
	},
	mutedFg: {
		from: "comment",
		light: { toward: "editorFg", amount: 0.00, maxChannelError: 0 },
		dark: { toward: "editorFg", amount: 0.14, maxChannelError: 15 }
	},
	disabledFg: {
		from: "comment",
		light: { toward: "editorBg", amount: 0.31, maxChannelError: 6 },
		dark: { toward: "editorBg", amount: 0.24, maxChannelError: 10 }
	},
	subtleFg: {
		from: "comment",
		light: { toward: "editorBg", amount: 0.21, maxChannelError: 4 },
		dark: { toward: "editorBg", amount: 0.04, maxChannelError: 14 }
	},
	brightAccent: {
		from: "accent",
		light: { toward: "black", amount: 0.52, maxChannelError: 13 },
		dark: { toward: "white", amount: 0.34, maxChannelError: 5 }
	},
	linkActiveFg: {
		from: "accent",
		light: { toward: "black", amount: 0.52, maxChannelError: 13 },
		dark: { toward: "white", amount: 0.44, maxChannelError: 18 }
	},
};

/** Alpha suffix appended to the slot's hex, e.g. "B3". Null means opaque. */
export type Alpha = string | ByMode<string | null>;

/** A token whose value is a palette slot, optionally at a fixed alpha. */
export interface SlotToken {
	readonly token: string;
	readonly from: SlotId;
	readonly alpha?: Alpha;
}

/** A token no rule reproduces. Kept explicit rather than fitted to a fake rule. */
export interface LiteralToken {
	readonly token: string;
	readonly literal: string | ByMode<string>;
	readonly why: string;
}

export type WorkbenchToken = SlotToken | LiteralToken;

export function isLiteralToken(entry: WorkbenchToken): entry is LiteralToken {
	return "literal" in entry;
}

/**
 * All 449 workbench colours, in the key order the shipping themes use so a
 * generated file diffs cleanly against them. 442 are slot rules; 7 are literals.
 */
export const WORKBENCH_TOKENS: readonly WorkbenchToken[] = [
	{ token: "foreground", from: "editorFg" },
	{ token: "descriptionForeground", from: "mutedFg" },
	{ token: "disabledForeground", from: "disabledFg" },
	{ token: "errorForeground", from: "error" },
	{ token: "icon.foreground", from: "chromeFg" },
	{ token: "focusBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "selection.background", from: "selectionOverlay", alpha: { light: null, dark: "40" } },
	{
		token: "widget.shadow",
		literal: { light: "#00000022", dark: "#00000066" },
		why: "Drop shadow is cast by the window, not the palette; only its strength tracks the mode."
	},
	{ token: "widget.border", from: "border" },
	{ token: "sash.hoverBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "textBlockQuote.background", from: "elevatedBg" },
	{ token: "textBlockQuote.border", from: "border" },
	{ token: "textCodeBlock.background", from: "elevatedBg" },
	{ token: "textLink.foreground", from: "accent" },
	{ token: "textLink.activeForeground", from: "linkActiveFg" },
	{ token: "textPreformat.foreground", from: "chromeFg" },
	{ token: "textPreformat.background", from: "hoverBg" },
	{ token: "textSeparator.foreground", from: "border" },
	{ token: "button.background", from: "accent" },
	{ token: "button.foreground", from: "editorBg" },
	{ token: "button.hoverBackground", from: "accentHoverBg" },
	{ token: "button.border", from: "accent" },
	{ token: "button.secondaryBackground", from: "hoverBg" },
	{ token: "button.secondaryForeground", from: "editorFg" },
	{ token: "button.secondaryHoverBackground", from: "selectionBg" },
	{ token: "button.secondaryBorder", from: "controlBorder" },
	{ token: "checkbox.background", from: "inputBg" },
	{ token: "checkbox.foreground", from: "editorFg" },
	{ token: "checkbox.border", from: "controlBorder" },
	{ token: "dropdown.background", from: "inputBg" },
	{ token: "dropdown.listBackground", from: "elevatedBg" },
	{ token: "dropdown.border", from: "controlBorder" },
	{ token: "dropdown.foreground", from: "editorFg" },
	{ token: "input.background", from: "inputBg" },
	{ token: "input.border", from: "controlBorder" },
	{ token: "input.foreground", from: "editorFg" },
	{ token: "input.placeholderForeground", from: "mutedFg" },
	{ token: "inputOption.activeBackground", from: "accent", alpha: "33" },
	{ token: "inputOption.activeBorder", from: "accent" },
	{ token: "inputOption.activeForeground", from: "editorFg" },
	{ token: "inputValidation.errorBackground", from: "elevatedBg" },
	{ token: "inputValidation.errorBorder", from: "error" },
	{ token: "inputValidation.errorForeground", from: "editorFg" },
	{ token: "inputValidation.warningBackground", from: "elevatedBg" },
	{ token: "inputValidation.warningBorder", from: "warning" },
	{ token: "inputValidation.warningForeground", from: "editorFg" },
	{ token: "inputValidation.infoBackground", from: "elevatedBg" },
	{ token: "inputValidation.infoBorder", from: "info" },
	{ token: "inputValidation.infoForeground", from: "editorFg" },
	{
		token: "scrollbar.shadow",
		literal: { light: "#00000022", dark: "#00000066" },
		why: "Drop shadow is cast by the window, not the palette; only its strength tracks the mode."
	},
	{ token: "scrollbarSlider.background", from: "chromeFg", alpha: "33" },
	{ token: "scrollbarSlider.hoverBackground", from: "chromeFg", alpha: "4D" },
	{ token: "scrollbarSlider.activeBackground", from: "chromeFg", alpha: "66" },
	{ token: "minimapSlider.background", from: "chromeFg", alpha: "33" },
	{ token: "minimapSlider.hoverBackground", from: "chromeFg", alpha: "4D" },
	{ token: "minimapSlider.activeBackground", from: "chromeFg", alpha: "66" },
	{ token: "badge.background", from: "accent" },
	{ token: "badge.foreground", from: "editorBg" },
	{ token: "progressBar.background", from: "accent" },
	{ token: "list.activeSelectionBackground", from: "selectionBg" },
	{ token: "list.activeSelectionForeground", from: "editorFg" },
	{ token: "list.activeSelectionIconForeground", from: "editorFg" },
	{ token: "list.inactiveSelectionBackground", from: "hoverBg" },
	{ token: "list.inactiveSelectionForeground", from: "editorFg" },
	{ token: "list.hoverBackground", from: "hoverBg" },
	{ token: "list.hoverForeground", from: "editorFg" },
	{ token: "list.focusBackground", from: "selectionBg" },
	{ token: "list.focusForeground", from: "editorFg" },
	{ token: "list.focusOutline", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "list.focusAndSelectionOutline", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "list.highlightForeground", from: "brightAccent" },
	{ token: "list.dropBackground", from: "accent", alpha: "1A" },
	{ token: "list.deemphasizedForeground", from: "mutedFg" },
	{ token: "list.errorForeground", from: "error" },
	{ token: "list.warningForeground", from: "warning" },
	{ token: "list.invalidItemForeground", from: "disabledFg" },
	{ token: "tree.indentGuidesStroke", from: "border" },
	{ token: "toolbar.hoverBackground", from: "hoverBg" },
	{ token: "toolbar.activeBackground", from: "selectionBg" },
	{ token: "actionBar.toggledBackground", from: "selectionBg" },
	{ token: "activityBar.background", from: "sideBg" },
	{ token: "activityBar.foreground", from: "editorFg" },
	{ token: "activityBar.inactiveForeground", from: "mutedFg" },
	{ token: "activityBar.border", from: "border" },
	{ token: "activityBar.activeBorder", from: "accent" },
	{ token: "activityBar.activeBackground", from: "hoverBg" },
	{ token: "activityBar.activeFocusBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "activityBarBadge.background", from: "accent" },
	{ token: "activityBarBadge.foreground", from: "editorBg" },
	{ token: "activityBarTop.activeBorder", from: "accent" },
	{ token: "activityBarTop.foreground", from: "editorFg" },
	{ token: "activityBarTop.inactiveForeground", from: "mutedFg" },
	{ token: "activityWarningBadge.background", from: "warning" },
	{ token: "activityWarningBadge.foreground", from: "onSemanticFg" },
	{ token: "activityErrorBadge.background", from: "error" },
	{ token: "activityErrorBadge.foreground", from: "onSemanticFg" },
	{ token: "sideBar.background", from: "sideBg" },
	{ token: "sideBar.foreground", from: "editorFg" },
	{ token: "sideBar.border", from: "border" },
	{ token: "sideBarTitle.foreground", from: "editorFg" },
	{ token: "sideBarSectionHeader.background", from: "sideBg" },
	{ token: "sideBarSectionHeader.foreground", from: "chromeFg" },
	{ token: "sideBarSectionHeader.border", from: "border" },
	{ token: "titleBar.activeBackground", from: "chromeBg" },
	{ token: "titleBar.activeForeground", from: "chromeFg" },
	{ token: "titleBar.inactiveBackground", from: "chromeBg" },
	{ token: "titleBar.inactiveForeground", from: "mutedFg" },
	{ token: "titleBar.border", from: "border" },
	{ token: "menubar.selectionBackground", from: "hoverBg" },
	{ token: "menubar.selectionForeground", from: "editorFg" },
	{ token: "menu.background", from: "elevatedBg" },
	{ token: "menu.foreground", from: "editorFg" },
	{ token: "menu.selectionBackground", from: "selectionBg" },
	{ token: "menu.selectionForeground", from: "editorFg" },
	{ token: "menu.separatorBackground", from: "border" },
	{ token: "menu.border", from: "border" },
	{ token: "commandCenter.foreground", from: "chromeFg" },
	{ token: "commandCenter.activeForeground", from: "editorFg" },
	{ token: "commandCenter.background", from: "chromeBg" },
	{ token: "commandCenter.activeBackground", from: "hoverBg" },
	{ token: "commandCenter.border", from: "border" },
	{ token: "commandCenter.activeBorder", from: "controlBorder" },
	{ token: "editor.background", from: "editorBg" },
	{ token: "editor.foreground", from: "editorFg" },
	{ token: "editorLineNumber.foreground", from: "mutedFg" },
	{ token: "editorLineNumber.activeForeground", from: "editorFg" },
	{ token: "editorCursor.foreground", from: "accent" },
	{ token: "editorCursor.background", from: "editorBg" },
	{ token: "editor.selectionBackground", from: "selectionBg" },
	{ token: "editor.inactiveSelectionBackground", from: "selectionBg", alpha: "99" },
	{ token: "editor.selectionHighlightBackground", from: "selectionBg", alpha: "66" },
	{ token: "editor.wordHighlightBackground", from: "selectionBg", alpha: "55" },
	{ token: "editor.wordHighlightStrongBackground", from: "selectionBg", alpha: "88" },
	{ token: "editor.findMatchBackground", from: "warning", alpha: "55" },
	{ token: "editor.findMatchBorder", from: "warning" },
	{ token: "editor.findMatchHighlightBackground", from: "warning", alpha: "33" },
	{ token: "editor.findRangeHighlightBackground", from: "lineHighlight" },
	{ token: "editor.hoverHighlightBackground", from: "hoverBg" },
	{ token: "editor.lineHighlightBackground", from: "lineHighlight" },
	{
		token: "editor.lineHighlightBorder",
		literal: "#00000000",
		why: "Fully transparent - the element is deliberately not drawn; no palette slot can express that."
	},
	{ token: "editor.rangeHighlightBackground", from: "lineHighlight" },
	{ token: "editorLink.activeForeground", from: "accent" },
	{ token: "editorWhitespace.foreground", from: "mutedFg", alpha: "4D" },
	{ token: "editorIndentGuide.background1", from: "border" },
	{ token: "editorIndentGuide.activeBackground1", from: "mutedFg" },
	{ token: "editorRuler.foreground", from: "border" },
	{ token: "editorCodeLens.foreground", from: "mutedFg" },
	{ token: "editorBracketMatch.background", from: "accent", alpha: "26" },
	{ token: "editorBracketMatch.border", from: "controlBorder" },
	{ token: "editorWidget.background", from: "elevatedBg" },
	{ token: "editorWidget.foreground", from: "editorFg" },
	{ token: "editorWidget.border", from: "border" },
	{ token: "editorSuggestWidget.background", from: "elevatedBg" },
	{ token: "editorSuggestWidget.border", from: "border" },
	{ token: "editorSuggestWidget.foreground", from: "editorFg" },
	{ token: "editorSuggestWidget.highlightForeground", from: "brightAccent" },
	{ token: "editorSuggestWidget.focusHighlightForeground", from: "brightAccent" },
	{ token: "editorSuggestWidget.selectedBackground", from: "selectionBg" },
	{ token: "editorSuggestWidget.selectedForeground", from: "editorFg" },
	{ token: "editorHoverWidget.background", from: "elevatedBg" },
	{ token: "editorHoverWidget.foreground", from: "editorFg" },
	{ token: "editorHoverWidget.border", from: "border" },
	{ token: "editorStickyScroll.background", from: "editorBg" },
	{ token: "editorStickyScroll.border", from: "border" },
	{ token: "editorStickyScrollHover.background", from: "hoverBg" },
	{ token: "editorInlayHint.background", from: "hoverBg", alpha: "AA" },
	{ token: "editorInlayHint.foreground", from: "mutedFg" },
	{ token: "editorGhostText.foreground", from: "disabledFg" },
	{ token: "editorError.foreground", from: "error" },
	{ token: "editorWarning.foreground", from: "warning" },
	{ token: "editorInfo.foreground", from: "info" },
	{ token: "editorHint.foreground", from: "mutedFg" },
	{ token: "problemsErrorIcon.foreground", from: "error" },
	{ token: "problemsWarningIcon.foreground", from: "warning" },
	{ token: "problemsInfoIcon.foreground", from: "info" },
	{ token: "editorGutter.background", from: "editorBg" },
	{ token: "editorGutter.addedBackground", from: "added" },
	{ token: "editorGutter.deletedBackground", from: "deleted" },
	{ token: "editorGutter.modifiedBackground", from: "modified" },
	{ token: "diffEditor.insertedTextBackground", from: "addedTextWash" },
	{ token: "diffEditor.insertedLineBackground", from: "addedLineWash" },
	{ token: "diffEditor.removedTextBackground", from: "deletedTextWash" },
	{ token: "diffEditor.removedLineBackground", from: "deletedLineWash" },
	{ token: "diffEditor.unchangedRegionBackground", from: "sideBg" },
	{ token: "diffEditor.diagonalFill", from: "border", alpha: "99" },
	{
		token: "editorOverviewRuler.border",
		literal: "#00000000",
		why: "Fully transparent - the element is deliberately not drawn; no palette slot can express that."
	},
	{ token: "editorOverviewRuler.findMatchForeground", from: "warning", alpha: "66" },
	{ token: "editorOverviewRuler.addedForeground", from: "added" },
	{ token: "editorOverviewRuler.modifiedForeground", from: "modified" },
	{ token: "editorOverviewRuler.deletedForeground", from: "deleted" },
	{ token: "editorOverviewRuler.errorForeground", from: "error" },
	{ token: "editorOverviewRuler.warningForeground", from: "warning" },
	{ token: "editorOverviewRuler.infoForeground", from: "info" },
	{ token: "editorGroup.border", from: "border" },
	{ token: "editorGroup.dropBackground", from: "accent", alpha: "1A" },
	{ token: "editorGroupHeader.tabsBackground", from: "chromeBg" },
	{ token: "editorGroupHeader.tabsBorder", from: "border" },
	{ token: "editorGroupHeader.noTabsBackground", from: "editorBg" },
	{ token: "tab.activeBackground", from: "tabActiveBg" },
	{ token: "tab.activeForeground", from: "editorFg" },
	{ token: "tab.activeBorder", from: "editorBg" },
	{ token: "tab.activeBorderTop", from: "accent" },
	{ token: "tab.border", from: "border" },
	{ token: "tab.inactiveBackground", from: "editorBg" },
	{ token: "tab.inactiveForeground", from: "mutedFg" },
	{ token: "tab.hoverBackground", from: "tabHoverBg" },
	{ token: "tab.hoverForeground", from: "editorFg" },
	{ token: "tab.lastPinnedBorder", from: "border" },
	{ token: "tab.selectedBackground", from: "selectionBg" },
	{ token: "tab.selectedForeground", from: "editorFg" },
	{ token: "tab.selectedBorderTop", from: "comment" },
	{ token: "tab.unfocusedActiveBackground", from: "tabActiveBg" },
	{ token: "tab.unfocusedActiveForeground", from: "chromeFg" },
	{ token: "tab.unfocusedActiveBorder", from: "editorBg" },
	{ token: "tab.unfocusedActiveBorderTop", from: "border" },
	{ token: "tab.unfocusedInactiveBackground", from: "editorBg" },
	{ token: "tab.unfocusedInactiveForeground", from: "disabledFg" },
	{ token: "tab.unfocusedHoverBackground", from: "tabHoverBg" },
	{ token: "breadcrumb.foreground", from: "mutedFg" },
	{ token: "breadcrumb.background", from: "editorBg" },
	{ token: "breadcrumb.focusForeground", from: "editorFg" },
	{ token: "breadcrumb.activeSelectionForeground", from: "editorFg" },
	{ token: "breadcrumbPicker.background", from: "elevatedBg" },
	{ token: "peekView.border", from: "comment" },
	{ token: "peekViewEditor.background", from: "panelBg" },
	{ token: "peekViewEditor.matchHighlightBackground", from: "warning", alpha: "40" },
	{ token: "peekViewResult.background", from: "panelBg" },
	{ token: "peekViewResult.fileForeground", from: "editorFg" },
	{ token: "peekViewResult.lineForeground", from: "mutedFg" },
	{ token: "peekViewResult.matchHighlightBackground", from: "warning", alpha: "40" },
	{ token: "peekViewResult.selectionBackground", from: "selectionBg" },
	{ token: "peekViewResult.selectionForeground", from: "editorFg" },
	{ token: "peekViewTitle.background", from: "elevatedBg" },
	{ token: "peekViewTitleLabel.foreground", from: "editorFg" },
	{ token: "peekViewTitleDescription.foreground", from: "mutedFg" },
	{ token: "panel.background", from: "panelBg" },
	{ token: "panel.border", from: "border" },
	{ token: "panelTitle.activeBorder", from: "accent" },
	{ token: "panelTitle.activeForeground", from: "editorFg" },
	{ token: "panelTitle.inactiveForeground", from: "mutedFg" },
	{ token: "panelInput.border", from: "controlBorder" },
	{ token: "panelSectionHeader.background", from: "panelBg" },
	{ token: "panelSection.border", from: "border" },
	{ token: "statusBar.background", from: "chromeBg" },
	{ token: "statusBar.foreground", from: "chromeFg" },
	{ token: "statusBar.border", from: "border" },
	{ token: "statusBar.focusBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "statusBar.debuggingBackground", from: "accent" },
	{ token: "statusBar.debuggingForeground", from: "editorBg" },
	{ token: "statusBar.debuggingBorder", from: "border" },
	{ token: "statusBar.noFolderBackground", from: "emptyWindowBg" },
	{ token: "statusBar.noFolderForeground", from: "chromeFg" },
	{ token: "statusBar.noFolderBorder", from: "border" },
	{ token: "statusBarItem.activeBackground", from: "selectionBg" },
	{ token: "statusBarItem.hoverBackground", from: "hoverBg" },
	{ token: "statusBarItem.hoverForeground", from: "editorFg" },
	{ token: "statusBarItem.compactHoverBackground", from: "hoverBg" },
	{ token: "statusBarItem.focusBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "statusBarItem.prominentBackground", from: "selectionBg" },
	{ token: "statusBarItem.prominentForeground", from: "editorFg" },
	{ token: "statusBarItem.prominentHoverBackground", from: "hoverBg" },
	{ token: "statusBarItem.remoteBackground", from: "accent" },
	{ token: "statusBarItem.remoteForeground", from: "editorBg" },
	{ token: "statusBarItem.errorBackground", from: "error" },
	{ token: "statusBarItem.errorForeground", from: "onSemanticFg" },
	{ token: "statusBarItem.warningBackground", from: "warning" },
	{ token: "statusBarItem.warningForeground", from: "onSemanticFg" },
	{ token: "terminal.background", from: "panelBg" },
	{ token: "terminal.foreground", from: "editorFg" },
	{ token: "terminal.border", from: "border" },
	{ token: "terminal.selectionBackground", from: "selectionBg", alpha: "99" },
	{ token: "terminal.inactiveSelectionBackground", from: "selectionBg", alpha: "55" },
	{ token: "terminal.findMatchBackground", from: "warning", alpha: "55" },
	{ token: "terminal.findMatchHighlightBackground", from: "warning", alpha: "33" },
	{ token: "terminal.tab.activeBorder", from: "accent" },
	{ token: "terminalCursor.foreground", from: "accent" },
	{ token: "terminalCursor.background", from: "editorBg" },
	{ token: "terminal.ansiBlack", from: "ansiBlack" },
	{ token: "terminal.ansiRed", from: "ansiRed" },
	{ token: "terminal.ansiGreen", from: "ansiGreen" },
	{ token: "terminal.ansiYellow", from: "ansiYellow" },
	{ token: "terminal.ansiBlue", from: "ansiBlue" },
	{ token: "terminal.ansiMagenta", from: "ansiMagenta" },
	{ token: "terminal.ansiCyan", from: "ansiCyan" },
	{ token: "terminal.ansiWhite", from: "ansiWhite" },
	{ token: "terminal.ansiBrightBlack", from: "ansiBrightBlack" },
	{ token: "terminal.ansiBrightRed", from: "ansiBrightRed" },
	{ token: "terminal.ansiBrightGreen", from: "ansiBrightGreen" },
	{ token: "terminal.ansiBrightYellow", from: "ansiBrightYellow" },
	{ token: "terminal.ansiBrightBlue", from: "ansiBrightBlue" },
	{ token: "terminal.ansiBrightMagenta", from: "ansiBrightMagenta" },
	{ token: "terminal.ansiBrightCyan", from: "ansiBrightCyan" },
	{ token: "terminal.ansiBrightWhite", from: "ansiBrightWhite" },
	{ token: "gitDecoration.addedResourceForeground", from: "added" },
	{ token: "gitDecoration.modifiedResourceForeground", from: "modified" },
	{ token: "gitDecoration.deletedResourceForeground", from: "deleted" },
	{ token: "gitDecoration.renamedResourceForeground", from: "added" },
	{ token: "gitDecoration.untrackedResourceForeground", from: "untracked" },
	{ token: "gitDecoration.ignoredResourceForeground", from: "subtleFg" },
	{ token: "gitDecoration.conflictingResourceForeground", from: "conflict" },
	{ token: "gitDecoration.stageModifiedResourceForeground", from: "modified" },
	{ token: "gitDecoration.stageDeletedResourceForeground", from: "deleted" },
	{ token: "gitDecoration.submoduleResourceForeground", from: "info" },
	{ token: "notificationCenter.border", from: "border" },
	{ token: "notificationCenterHeader.background", from: "elevatedBg" },
	{ token: "notificationCenterHeader.foreground", from: "editorFg" },
	{ token: "notificationToast.border", from: "border" },
	{ token: "notifications.background", from: "elevatedBg" },
	{ token: "notifications.foreground", from: "editorFg" },
	{ token: "notifications.border", from: "border" },
	{ token: "notificationLink.foreground", from: "accent" },
	{ token: "notificationsErrorIcon.foreground", from: "error" },
	{ token: "notificationsWarningIcon.foreground", from: "warning" },
	{ token: "notificationsInfoIcon.foreground", from: "info" },
	{ token: "extensionButton.prominentBackground", from: "accent" },
	{ token: "extensionButton.prominentForeground", from: "editorBg" },
	{ token: "extensionButton.prominentHoverBackground", from: "accentHoverBg" },
	{ token: "extensionBadge.remoteBackground", from: "accent" },
	{ token: "extensionBadge.remoteForeground", from: "editorBg" },
	{ token: "extensionIcon.starForeground", from: "warning" },
	{ token: "pickerGroup.border", from: "border" },
	{ token: "pickerGroup.foreground", from: "mutedFg" },
	{ token: "quickInput.background", from: "elevatedBg" },
	{ token: "quickInput.foreground", from: "editorFg" },
	{ token: "quickInputTitle.background", from: "elevatedBg" },
	{ token: "quickInputList.focusBackground", from: "selectionBg" },
	{ token: "quickInputList.focusForeground", from: "editorFg" },
	{ token: "quickInputList.focusIconForeground", from: "editorFg" },
	{ token: "quickInputList.focusHighlightForeground", from: "brightAccent" },
	{ token: "keybindingLabel.background", from: "hoverBg" },
	{ token: "keybindingLabel.foreground", from: "editorFg" },
	{ token: "keybindingLabel.border", from: "controlBorder" },
	{ token: "keybindingLabel.bottomBorder", from: "controlBorder" },
	{ token: "settings.headerForeground", from: "editorFg" },
	{ token: "settings.modifiedItemIndicator", from: "modified" },
	{ token: "settings.dropdownBackground", from: "inputBg" },
	{ token: "settings.dropdownBorder", from: "controlBorder" },
	{ token: "settings.dropdownListBorder", from: "border" },
	{ token: "settings.textInputBackground", from: "inputBg" },
	{ token: "settings.textInputBorder", from: "controlBorder" },
	{ token: "settings.numberInputBackground", from: "inputBg" },
	{ token: "settings.numberInputBorder", from: "controlBorder" },
	{ token: "settings.checkboxBackground", from: "inputBg" },
	{ token: "settings.checkboxBorder", from: "controlBorder" },
	{ token: "settings.focusedRowBackground", from: "lineHighlight" },
	{ token: "settings.rowHoverBackground", from: "hoverBg", alpha: "80" },
	{ token: "settings.focusedRowBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "notebook.cellBorderColor", from: "border" },
	{ token: "notebook.selectedCellBackground", from: "lineHighlight" },
	{ token: "notebook.selectedCellBorder", from: "border" },
	{ token: "notebook.focusedCellBorder", from: "comment" },
	{ token: "notebook.cellEditorBackground", from: "sideBg" },
	{ token: "notebook.editorBackground", from: "editorBg" },
	{ token: "debugToolBar.background", from: "elevatedBg" },
	{ token: "debugToolBar.border", from: "border" },
	{ token: "debugIcon.breakpointForeground", from: "error" },
	{ token: "debugIcon.startForeground", from: "added" },
	{ token: "debugIcon.stopForeground", from: "deleted" },
	{ token: "debugIcon.restartForeground", from: "added" },
	{ token: "debugIcon.pauseForeground", from: "info" },
	{ token: "debugConsole.errorForeground", from: "error" },
	{ token: "debugConsole.warningForeground", from: "warning" },
	{ token: "debugConsole.infoForeground", from: "info" },
	{ token: "debugConsole.sourceForeground", from: "mutedFg" },
	{ token: "testing.iconPassed", from: "added" },
	{ token: "testing.iconFailed", from: "error" },
	{ token: "testing.iconErrored", from: "error" },
	{ token: "testing.iconQueued", from: "warning" },
	{ token: "testing.iconUnset", from: "mutedFg" },
	{ token: "testing.iconSkipped", from: "mutedFg" },
	{ token: "welcomePage.tileBackground", from: "sideBg" },
	{ token: "welcomePage.tileHoverBackground", from: "hoverBg" },
	{ token: "welcomePage.tileBorder", from: "border" },
	{ token: "welcomePage.progress.background", from: "border" },
	{ token: "welcomePage.progress.foreground", from: "accent" },
	{ token: "walkThrough.embeddedEditorBackground", from: "sideBg" },
	{ token: "ports.iconRunningProcessForeground", from: "added" },
	{ token: "banner.background", from: "selectionBg" },
	{ token: "banner.foreground", from: "editorFg" },
	{ token: "banner.iconForeground", from: "info" },
	{ token: "searchEditor.findMatchBackground", from: "warning", alpha: "33" },
	{ token: "searchEditor.textInputBorder", from: "controlBorder" },
	{ token: "charts.foreground", from: "editorFg" },
	{ token: "charts.lines", from: "chromeFg", alpha: "80" },
	{ token: "charts.red", from: "ansiRed" },
	{ token: "charts.blue", from: "ansiBlue" },
	{ token: "charts.yellow", from: "ansiYellow" },
	{ token: "charts.orange", from: "conflict" },
	{ token: "charts.green", from: "ansiGreen" },
	{ token: "charts.purple", from: "ansiMagenta" },
	{ token: "editorCommentsWidget.rangeBackground", from: "accent", alpha: "1A" },
	{ token: "editorCommentsWidget.rangeActiveBackground", from: "accent", alpha: "2E" },
	{ token: "chat.requestBubbleBackground", from: "accent", alpha: "14" },
	{ token: "chat.requestBubbleHoverBackground", from: "accent", alpha: "22" },
	{ token: "chat.requestCodeBorder", from: "border" },
	{ token: "chat.checkpointSeparator", from: "comment" },
	{ token: "chat.slashCommandBackground", from: "accent", alpha: "26" },
	{ token: "chat.slashCommandForeground", from: "accentEmphasis" },
	{ token: "chat.avatarBackground", from: "selectionBg" },
	{ token: "chat.avatarForeground", from: "editorFg" },
	{ token: "chat.editedFileForeground", from: "warning" },
	{ token: "chat.linesAddedForeground", from: "added" },
	{ token: "chat.linesRemovedForeground", from: "deleted" },
	{ token: "chat.inputWorkingBorderColor1", from: "accent" },
	{ token: "chat.inputWorkingBorderColor2", from: "comment" },
	{ token: "chat.inputWorkingBorderColor3", from: "accentHoverBg" },
	{ token: "inlineChat.background", from: "elevatedBg" },
	{ token: "inlineChat.foreground", from: "editorFg" },
	{ token: "inlineChat.border", from: "border" },
	{
		token: "inlineChat.shadow",
		literal: { light: "#00000022", dark: "#00000066" },
		why: "Drop shadow is cast by the window, not the palette; only its strength tracks the mode."
	},
	{ token: "inlineChatInput.background", from: "inputBg" },
	{ token: "inlineChatInput.border", from: "controlBorder" },
	{ token: "inlineChatInput.focusBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "inlineChatInput.placeholderForeground", from: "mutedFg" },
	{ token: "inlineChatDiff.inserted", from: "addedInlineWash" },
	{ token: "inlineChatDiff.removed", from: "deletedInlineWash" },
	{ token: "interactive.activeCodeBorder", from: "comment" },
	{ token: "interactive.inactiveCodeBorder", from: "border" },
	{ token: "agents.background", from: "editorBg" },
	{ token: "agentsPanel.background", from: "sideBg" },
	{ token: "agentsPanel.foreground", from: "editorFg" },
	{ token: "agentsPanel.border", from: "border" },
	{ token: "surface.background", from: "sideBg" },
	{ token: "surface.foreground", from: "editorFg" },
	{ token: "surface.border", from: "border" },
	{ token: "agentsGradient.tintColor", from: "accent" },
	{ token: "agentsChatInput.background", from: "elevatedBg" },
	{ token: "agentsChatInput.foreground", from: "editorFg" },
	{ token: "agentsChatInput.border", from: "controlBorder" },
	{ token: "agentsChatInput.focusBorder", from: "accent", alpha: { light: null, dark: "B3" } },
	{ token: "agentsChatInput.placeholderForeground", from: "mutedFg" },
	{
		token: "agentsNewSessionButton.background",
		literal: "#00000000",
		why: "Fully transparent - the element is deliberately not drawn; no palette slot can express that."
	},
	{ token: "agentsNewSessionButton.foreground", from: "editorFg" },
	{ token: "agentsNewSessionButton.border", from: "controlBorder" },
	{ token: "agentsNewSessionButton.hoverBackground", from: "hoverBg" },
	{ token: "agentsBadge.background", from: "accent" },
	{ token: "agentsBadge.foreground", from: "editorBg" },
	{ token: "agentsUnreadBadge.background", from: "accent" },
	{ token: "agentsUnreadBadge.foreground", from: "editorBg" },
	{
		token: "agentsBottomPanel.border",
		literal: "#00000000",
		why: "Fully transparent - the element is deliberately not drawn; no palette slot can express that."
	},
];

/**
 * How a family emphasises syntax. The Primal family is monochrome by design, so
 * keywords, types, tags and function names carry weight instead of hue; the
 * chromatic families carry it in hue and stay at normal weight. Read off the
 * fontStyle split between {ink, basalt} and the rest.
 */
export type SyntaxEmphasis = "weight" | "plain";

export interface TokenColorRule {
	readonly scope: readonly string[];
	/** Omitted where the rule only sets a fontStyle (underline, strikethrough). */
	readonly from?: SlotId;
	readonly fontStyle?: string | Readonly<Record<SyntaxEmphasis, string | undefined>>;
}

/** All 33 tokenColors rules. Every foreground is slot-derived; none is a literal. */
export const TOKEN_COLOR_RULES: readonly TokenColorRule[] = [
	{
		scope: ["comment", "punctuation.definition.comment", "string.comment"],
		from: "comment",
		fontStyle: "italic"
	},
	{
		scope: ["string", "string punctuation.section.embedded source", "markup.inline.raw.string"],
		from: "string"
	},
	{
		scope: ["constant.numeric", "constant.language", "constant.character", "constant.other.placeholder", "variable.other.enummember", "keyword.other.unit"],
		from: "constant"
	},
	{
		scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control"],
		from: "keyword",
		fontStyle: { weight: "bold", plain: undefined }
	},
	{
		scope: ["keyword.operator", "punctuation.separator", "punctuation.terminator"],
		from: "operator"
	},
	{
		scope: ["punctuation.definition.tag", "punctuation.section"],
		from: "mutedFg"
	},
	{
		scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function", "meta.require"],
		from: "function",
		fontStyle: { weight: "bold", plain: undefined }
	},
	{
		scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "entity.other.inherited-class", "support.class", "support.type"],
		from: "type",
		fontStyle: { weight: "bold", plain: undefined }
	},
	{
		scope: ["entity.name.tag", "support.class.component"],
		from: "keyword",
		fontStyle: { weight: "bold", plain: undefined }
	},
	{
		scope: ["entity.other.attribute-name", "meta.attribute"],
		from: "string"
	},
	{
		scope: ["variable", "meta.definition.variable", "variable.other"],
		from: "editorFg"
	},
	{
		scope: ["variable.parameter"],
		from: "editorFg",
		fontStyle: "italic"
	},
	{
		scope: ["variable.language"],
		from: "keyword",
		fontStyle: "italic"
	},
	{
		scope: ["support.type.property-name", "meta.property-name", "support.variable.property"],
		from: "function"
	},
	{
		scope: ["constant", "entity.name.constant", "variable.other.constant"],
		from: "constant"
	},
	{
		scope: ["string.regexp", "source.regexp", "constant.character.escape"],
		from: "constant"
	},
	{
		scope: ["markup.heading", "markup.heading entity.name"],
		from: "editorFg",
		fontStyle: "bold"
	},
	{
		scope: ["markup.bold"],
		from: "editorFg",
		fontStyle: "bold"
	},
	{
		scope: ["markup.italic"],
		from: "editorFg",
		fontStyle: "italic"
	},
	{
		scope: ["markup.underline"],
		fontStyle: "underline"
	},
	{
		scope: ["markup.strikethrough"],
		fontStyle: "strikethrough"
	},
	{
		scope: ["markup.quote"],
		from: "comment",
		fontStyle: "italic"
	},
	{
		scope: ["markup.inline.raw"],
		from: "string"
	},
	{
		scope: ["markup.underline.link", "string.other.link", "constant.other.reference.link"],
		from: "accent",
		fontStyle: "underline"
	},
	{
		scope: ["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"],
		from: "added"
	},
	{
		scope: ["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"],
		from: "deleted"
	},
	{
		scope: ["markup.changed", "punctuation.definition.changed"],
		from: "modified"
	},
	{
		scope: ["meta.diff.range", "meta.diff.header", "meta.separator"],
		from: "info",
		fontStyle: "bold"
	},
	{
		scope: ["invalid.broken", "invalid.deprecated", "invalid.illegal", "invalid.unimplemented", "message.error"],
		from: "error",
		fontStyle: "italic"
	},
	{
		scope: ["token.info-token"],
		from: "info"
	},
	{
		scope: ["token.warn-token"],
		from: "warning"
	},
	{
		scope: ["token.error-token"],
		from: "error"
	},
	{
		scope: ["token.debug-token"],
		from: "ansiMagenta"
	},
];

/**
 * Tokens whose SLOT changed when the semantic ladders landed, so the map no
 * longer reproduces the six hand-authored themes at them even with the old
 * semantics pinned.
 *
 * There are three, and all three are the same defect: a diff role was painted
 * with a severity colour. `gitDecoration.modifiedResourceForeground` and its
 * staged twin read `warning`, so a modified file in the explorer was amber
 * while the same file's `editorGutter.modifiedBackground` was blue - two
 * answers to one question - and, worse, it put a severity colour inside
 * validateTheme's "source control decorations" group, which is what made that
 * group impossible to separate: the severity and diff ladders would have had to
 * be mutually separated as well, and no plane has that much room.
 * `markup.changed` read `conflict` for the same reason, in the syntax path.
 *
 * They are declared rather than absorbed because both self-checks assert
 * byte-identity against the fixture, and a change of this kind has to be
 * visible in the diff of this file rather than hidden in a regenerated blob.
 */
export const REROUTED_TOKENS: readonly { readonly token: string; readonly wasFrom: SlotId; readonly why: string }[] = [
	{ token: "gitDecoration.modifiedResourceForeground", wasFrom: "warning", why: "a modified file is a diff state, not a warning; it now matches editorGutter.modifiedBackground" },
	{ token: "gitDecoration.stageModifiedResourceForeground", wasFrom: "warning", why: "same role, staged" },
	{ token: "markup.changed", wasFrom: "conflict", why: "a changed line in a diff is `modified`; `conflict` is the merge state" }
];

/** A fully resolved palette: every slot the token map can name. */
export type Palette = Readonly<Record<SlotId, string>>;

function withAlpha(hex: string, alpha: Alpha | undefined, mode: ThemeMode): string {
	if (alpha === undefined) return hex;
	const suffix = typeof alpha === "string" ? alpha : alpha[mode];
	return suffix === null ? hex : hex + suffix;
}

const WASH_SLOT_SET: ReadonlySet<string> = new Set(SEMANTIC_WASH_SLOT_IDS);

/** Applies WORKBENCH_TOKENS to a resolved palette. Key order is preserved. */
export function buildColors(palette: Palette, mode: ThemeMode): Record<string, string> {
	const colors: Record<string, string> = {};
	for (const entry of WORKBENCH_TOKENS) {
		if (isLiteralToken(entry)) {
			colors[entry.token] = typeof entry.literal === "string" ? entry.literal : entry.literal[mode];
			continue;
		}
		const hex = palette[entry.from];
		if (hex === undefined) throw new Error(`tokenMap: palette has no slot "${entry.from}" (for ${entry.token})`);
		// A wash slot carries the alpha the generator proved the pair apart at.
		// Restating one here would replace a measured value with a guess.
		if (WASH_SLOT_SET.has(entry.from) && entry.alpha !== undefined) {
			throw new Error(`tokenMap: ${entry.token} names wash slot "${entry.from}" and also states an alpha; the wash slot owns its alpha`);
		}
		colors[entry.token] = withAlpha(hex, entry.alpha, mode);
	}
	return colors;
}

export interface TokenColorEntry {
	readonly scope: readonly string[];
	readonly settings: { foreground?: string; fontStyle?: string };
}

/** Applies TOKEN_COLOR_RULES to a resolved palette. */
export function buildTokenColors(palette: Palette, emphasis: SyntaxEmphasis): TokenColorEntry[] {
	return TOKEN_COLOR_RULES.map(rule => {
		const settings: { foreground?: string; fontStyle?: string } = {};
		if (rule.from !== undefined) {
			const hex = palette[rule.from];
			if (hex === undefined) throw new Error(`tokenMap: palette has no slot "${rule.from}"`);
			settings.foreground = hex;
		}
		const fontStyle = typeof rule.fontStyle === "string" ? rule.fontStyle : rule.fontStyle?.[emphasis];
		if (fontStyle !== undefined) settings.fontStyle = fontStyle;
		return { scope: rule.scope, settings };
	});
}

/** Slots resolved by MODE_SLOT_RULES, given the rest of the palette. */
export function resolveModeSlots(base: Readonly<Record<string, string>>, mode: ThemeMode): Record<ModeSlotId, string> {
	const out = {} as Record<ModeSlotId, string>;
	for (const rule of MODE_SLOT_RULES) {
		const ref = mode === "light" ? rule.light : rule.dark;
		out[rule.slot] = "literal" in ref ? ref.literal : base[ref.slot];
	}
	return out;
}

// ---------------------------------------------------------------------------
// --check: the acceptance test for this file.
// ---------------------------------------------------------------------------

interface Fixture {
	readonly vibes: readonly {
		readonly id: string;
		readonly themeFile: string;
		readonly mode: ThemeMode;
		readonly syntaxEmphasis: SyntaxEmphasis;
		readonly palette: Palette;
		readonly colors: Record<string, string>;
		readonly tokenColors: readonly TokenColorEntry[];
	}[];
}

/** Which slot a workbench token hangs off, for partitioning a diff. */
function slotOfToken(token: string): string {
	const entry = WORKBENCH_TOKENS.find(t => t.token === token);
	if (entry === undefined) return "?";
	return "literal" in entry ? "literal" : entry.from;
}

const SEMANTIC_SLOT_SET: ReadonlySet<string> = new Set<string>(SEMANTIC_SLOT_IDS);
const REROUTED_TOKEN_SET: ReadonlySet<string> = new Set(REROUTED_TOKENS.map(entry => entry.token));

/** Tokens the shipping themes are ALLOWED to differ from the fixture at. */
function isExpectedToMove(token: string): boolean {
	return REROUTED_TOKEN_SET.has(token) || SEMANTIC_SLOT_SET.has(slotOfToken(token));
}

function selfCheck(): number {
	const here = dirname(fileURLToPath(import.meta.url));
	const fixture = JSON.parse(readFileSync(join(here, "tokenMap.test-fixture.json"), "utf8")) as Fixture;
	let failures = 0;

	for (const vibe of fixture.vibes) {
		// 1. The map applied to the fixture palette must equal the fixture output,
		//    except at the tokens REROUTED_TOKENS declares. The fixture records the
		//    six hand-authored themes; the exceptions are printed, never absorbed.
		const colors = buildColors(vibe.palette, vibe.mode);
		const tokenColors = buildTokenColors(vibe.palette, vibe.syntaxEmphasis);
		failures += diff(`${vibe.id}: map -> fixture colors`, colors, vibe.colors, false, REROUTED_TOKEN_SET);
		failures += diffJson(`${vibe.id}: map -> fixture tokenColors`, tokenColors, vibe.tokenColors, false, REROUTED_TOKEN_SET);

		// 2. The fixture must still equal the shipping theme at every token that is
		//    NOT semantic-derived. The semantic-derived ones deliberately moved when
		//    the ladders landed - the fixture is the before, the theme file is the
		//    after - and buildThemes.ts --check is what proves the after is generated
		//    rather than hand-edited. This half is what still catches a hand-edit of
		//    any of the ~400 colours the ladders do not touch.
		const shipped = JSON.parse(readFileSync(join(here, "..", "..", vibe.themeFile), "utf8")) as {
			colors: Record<string, string>;
			tokenColors: readonly TokenColorEntry[];
		};
		const structural: Record<string, string> = {};
		const shippedStructural: Record<string, string> = {};
		let moved = 0;
		for (const key of Object.keys(vibe.colors)) {
			if (isExpectedToMove(key)) { if (vibe.colors[key].toUpperCase() !== (shipped.colors[key] ?? "").toUpperCase()) moved++; continue; }
			structural[key] = vibe.colors[key];
			shippedStructural[key] = shipped.colors[key];
		}
		failures += diff(`${vibe.id}: fixture -> ${vibe.themeFile} (non-semantic)`, structural, shippedStructural, true);
		console.log(`  ${vibe.id.padEnd(7)} ${Object.keys(structural).length} non-semantic colours identical, ${moved} semantic-derived colours re-lit by the ladder`);
	}

	if (failures > 0) {
		console.error(`\ntokenMap: ${failures} mismatch(es)`);
		return 1;
	}
	console.log(`tokenMap: ${fixture.vibes.length} vibes reproduce their hand-authored fixture exactly ` +
		`(${WORKBENCH_TOKENS.length} workbench colours, ${TOKEN_COLOR_RULES.length} tokenColors each), ` +
		`with ${REROUTED_TOKENS.length} declared re-routes`);
	return 0;
}

/**
 * Compares two colour maps key by key.
 *
 * `declared` names keys that are ALLOWED to differ - the re-routes above. A
 * declared difference is printed as an expectation, not counted as a failure;
 * anything else is a failure. A declared key that turns out to MATCH is also a
 * failure, because a declaration nobody needs any more is a stale claim in a
 * file whose whole job is to be true.
 */
function diff(
	what: string,
	got: Record<string, string>,
	want: Record<string, string>,
	caseInsensitive = false,
	declared: ReadonlySet<string> = new Set()
): number {
	const norm = (v: string): string => (caseInsensitive ? v.toUpperCase() : v);
	const gotKeys = Object.keys(got);
	const wantKeys = Object.keys(want);
	let bad = 0;
	if (gotKeys.length !== wantKeys.length || gotKeys.some((k, i) => k !== wantKeys[i])) {
		console.error(`  ${what}: key set or order differs (${gotKeys.length} vs ${wantKeys.length})`);
		bad++;
	}
	for (const key of wantKeys) {
		const same = norm(got[key] ?? "") === norm(want[key]);
		if (declared.has(key)) {
			if (same) {
				console.error(`  ${what}: ${key} is declared in REROUTED_TOKENS but no longer differs; remove the declaration`);
				bad++;
			} else {
				console.log(`  ${what}: ${key} ${want[key]} -> ${got[key]} (declared re-route)`);
			}
			continue;
		}
		if (!same) {
			console.error(`  ${what}: ${key} = ${got[key]}, expected ${want[key]}`);
			bad++;
		}
	}
	return bad;
}

/**
 * Compares two tokenColors arrays rule by rule. `declared` names scopes whose
 * rule is allowed to differ, with the same both-ways strictness as `diff`.
 */
function diffJson(
	what: string,
	got: readonly TokenColorEntry[],
	want: readonly TokenColorEntry[],
	caseInsensitive = false,
	declared: ReadonlySet<string> = new Set()
): number {
	const norm = (v: unknown): string => {
		const text = JSON.stringify(v);
		return caseInsensitive ? text.toUpperCase() : text;
	};
	if (got.length !== want.length) {
		console.error(`  ${what}: ${got.length} rules, expected ${want.length}`);
		return 1;
	}
	let bad = 0;
	for (let i = 0; i < want.length; i++) {
		const same = norm(got[i]) === norm(want[i]);
		const isDeclared = want[i].scope.some(scope => declared.has(scope));
		if (isDeclared) {
			if (same) {
				console.error(`  ${what}: rule ${i} (${want[i].scope[0]}) is declared in REROUTED_TOKENS but no longer differs; remove the declaration`);
				bad++;
			} else {
				console.log(`  ${what}: ${want[i].scope[0]} ${want[i].settings.foreground} -> ${got[i].settings.foreground} (declared re-route)`);
			}
			continue;
		}
		if (!same) {
			console.error(`  ${what}: rule ${i} (${want[i].scope[0]}) differs`);
			bad++;
		}
	}
	return bad;
}

const entry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
	process.exit(selfCheck());
}
