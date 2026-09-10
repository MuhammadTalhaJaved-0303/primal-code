/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The thresholds and the tables the runtime readability verdict is measured
 * against.
 *
 * Every number here is copied, with its argument, from
 * `primal/theme/validateTheme.ts` — the build-time gate that the generated
 * themes must clear. This file exists so the workbench can ask the same
 * questions of a theme the build never saw: anything installed from Open VSX
 * bypasses that gate entirely, and the person who would otherwise have to spot
 * an unreadable theme by eye is colour blind, so it has to be measured.
 *
 * Data only. The maths is in `src/vs/base/common/primalColorScience.ts` and the
 * checks are in `primalThemeReadability.ts`.
 */

/**
 * WCAG 2.2 SC 1.4.3 (AA) for normal-size text. Editor body text is the surface a
 * user stares at all day; there is no argument for holding it below the
 * published floor for ordinary text.
 */
export const MIN_EDITOR_TEXT_CONTRAST = 4.5;

/**
 * Comments get their own floor, lower than body text and enforced in two tiers:
 * below 3.0 is the classic unreadable-theme failure, between 3.0 and 4.5 is a
 * de-emphasis most themes deliberately buy.
 */
export const MIN_COMMENT_CONTRAST_ERROR = 3.0;
export const MIN_COMMENT_CONTRAST_WARN = 4.5;

/**
 * Perceptual distance (CIEDE2000) at which two colours read as different colours
 * without being compared side by side. ~2.3 is the usual quoted JND for ordinary
 * viewing; a user glancing at a squiggle has nothing to compare it against, so
 * the floor sits roughly an order of magnitude above that.
 */
export const MIN_SEMANTIC_DELTA_E = 11;

/**
 * The 16-colour ANSI ramp is denser than the semantic palette by design — each
 * bright slot is meant to read as a brighter relative of its normal slot — so it
 * gets a slightly lower floor than semantic pairs.
 */
export const MIN_ANSI_DELTA_E = 10;

/**
 * ANSI colours are text on the terminal background. 3.0 is the WCAG large-text
 * and non-text floor; below it, coloured terminal output stops being legible.
 */
export const MIN_ANSI_CONTRAST = 3.0;

/**
 * A group of colours a user has to be able to tell apart at a glance. Every pair
 * within a group is checked, for a normal observer and for each of the three
 * dichromacies.
 *
 * `over` names the colour the group's members are composited onto when they
 * carry alpha — a 20%-alpha green and a 20%-alpha red are not 20% apart, they
 * are as far apart as what survives the background eating most of them.
 */
export interface IPrimalSemanticGroup {
	/** Stable id, used to build the localized group name. */
	readonly id: string;
	readonly tokens: readonly string[];
	readonly over?: string;
}

/**
 * The workbench colour groups whose members must stay distinguishable.
 *
 * This is the subset of `validateTheme.ts`'s table that a *loaded* theme can
 * actually answer for: every entry reads through `IColorTheme.getColor`.
 */
export const PRIMAL_SEMANTIC_GROUPS: readonly IPrimalSemanticGroup[] = [
	{ id: 'diagnostics', tokens: ['editorError.foreground', 'editorWarning.foreground', 'editorInfo.foreground'], over: 'editor.background' },
	{ id: 'problemsPanel', tokens: ['problemsErrorIcon.foreground', 'problemsWarningIcon.foreground', 'problemsInfoIcon.foreground'], over: 'editor.background' },
	{ id: 'notifications', tokens: ['notificationsErrorIcon.foreground', 'notificationsWarningIcon.foreground', 'notificationsInfoIcon.foreground'], over: 'editor.background' },
	{ id: 'debugConsole', tokens: ['debugConsole.errorForeground', 'debugConsole.warningForeground', 'debugConsole.infoForeground'], over: 'panel.background' },
	{ id: 'overviewRulerDiagnostics', tokens: ['editorOverviewRuler.errorForeground', 'editorOverviewRuler.warningForeground', 'editorOverviewRuler.infoForeground'], over: 'editor.background' },
	{ id: 'gutterDiff', tokens: ['editorGutter.addedBackground', 'editorGutter.deletedBackground', 'editorGutter.modifiedBackground'], over: 'editorGutter.background' },
	{ id: 'overviewRulerDiff', tokens: ['editorOverviewRuler.addedForeground', 'editorOverviewRuler.deletedForeground', 'editorOverviewRuler.modifiedForeground'], over: 'editor.background' },
	{ id: 'sourceControl', tokens: ['gitDecoration.addedResourceForeground', 'gitDecoration.deletedResourceForeground', 'gitDecoration.modifiedResourceForeground', 'gitDecoration.untrackedResourceForeground', 'gitDecoration.conflictingResourceForeground'], over: 'sideBar.background' },
	{ id: 'diffText', tokens: ['diffEditor.insertedTextBackground', 'diffEditor.removedTextBackground'], over: 'editor.background' },
	{ id: 'diffLines', tokens: ['diffEditor.insertedLineBackground', 'diffEditor.removedLineBackground'], over: 'editor.background' },
	{ id: 'statusBarSeverities', tokens: ['statusBarItem.errorBackground', 'statusBarItem.warningBackground'], over: 'statusBar.background' },
	{ id: 'listSeverities', tokens: ['list.errorForeground', 'list.warningForeground'], over: 'sideBar.background' },
	{ id: 'inputValidation', tokens: ['inputValidation.errorBorder', 'inputValidation.warningBorder', 'inputValidation.infoBorder'], over: 'editor.background' }
];

/** The sixteen ANSI slots, in SGR order. */
export const PRIMAL_ANSI_SLOTS: readonly string[] = [
	'terminal.ansiBlack',
	'terminal.ansiRed',
	'terminal.ansiGreen',
	'terminal.ansiYellow',
	'terminal.ansiBlue',
	'terminal.ansiMagenta',
	'terminal.ansiCyan',
	'terminal.ansiWhite',
	'terminal.ansiBrightBlack',
	'terminal.ansiBrightRed',
	'terminal.ansiBrightGreen',
	'terminal.ansiBrightYellow',
	'terminal.ansiBrightBlue',
	'terminal.ansiBrightMagenta',
	'terminal.ansiBrightCyan',
	'terminal.ansiBrightWhite'
];

/** Scopes that carry a theme's comment colour, most specific first. */
export const PRIMAL_COMMENT_SCOPES: readonly string[] = ['comment', 'comment.line', 'comment.block'];

/** Colours without which nothing else can be measured. */
export const PRIMAL_REQUIRED_COLORS: readonly string[] = ['editor.background', 'editor.foreground'];
