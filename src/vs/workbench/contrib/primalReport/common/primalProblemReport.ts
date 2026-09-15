/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { PRIMAL_REPORT_REDACTED, sanitiseReportText } from './primalProblemReportSanitiser.js';

export { PRIMAL_REPORT_REDACTED, sanitiseReportText };

/** How many lines of each log end up in the report. */
export const PRIMAL_REPORT_LOG_TAIL_LINES = 200;

/** Longer log lines are cut; a single JSON dump must not swallow the report. */
export const PRIMAL_REPORT_MAX_LINE_LENGTH = 400;

/** Marker appended to a line that was cut at {@link PRIMAL_REPORT_MAX_LINE_LENGTH}. */
export const PRIMAL_REPORT_LINE_CUT_MARKER = ' [line cut]';

/** Commits are shown this short; anything longer would be hidden as a hash by the sanitiser. */
export const PRIMAL_REPORT_SHORT_COMMIT_LENGTH = 12;

/** A log file's contents, or the reason it could not be read. */
export type ProblemReportLogSource =
	| { readonly text: string }
	| { readonly error: string };

/** The newest crash report belonging to this app, if the platform was checked at all. */
export type ProblemReportCrashInfo =
	| { readonly kind: 'found'; readonly fileName: string }
	| { readonly kind: 'none' }
	| { readonly kind: 'skipped'; readonly reason: string };

export interface IProblemReportProduct {
	readonly name: string;
	readonly version: string;
	readonly commit?: string;
	readonly date?: string;
}

export interface IProblemReportOs {
	readonly name: string;
	readonly release: string;
	readonly arch: string;
	readonly hostname?: string;
}

export interface IProblemReportMotif {
	readonly id: string;
	readonly motion: string;
}

/** Everything the report is built from. Nothing here may be a key, token or secret value. */
export interface IProblemReportInput {
	readonly product: IProblemReportProduct;
	readonly os: IProblemReportOs;
	readonly colorTheme: string;
	readonly vibe: string;
	readonly motif: IProblemReportMotif;
	readonly wallpaperMode: string;
	/** Ids of providers that have a saved key. Ids only, never the keys. */
	readonly providerIds: readonly string[];
	readonly harnessProviderId?: string;
	readonly mainLog: ProblemReportLogSource;
	readonly rendererLog: ProblemReportLogSource;
	readonly crashReport: ProblemReportCrashInfo;
	readonly homeDir: string;
}

export interface ITailResult {
	readonly lines: readonly string[];
	readonly total: number;
}

export interface ICrashReportEntry {
	readonly name: string;
	readonly mtime: number;
}

/** The last `maxLines` lines of `text`, and how many lines it had in all. */
export function tailLines(text: string, maxLines: number): ITailResult {
	if (text.length === 0) {
		return { lines: [], total: 0 };
	}
	const all = text.split(/\r?\n/);
	const withoutTrailingBlank = all[all.length - 1] === '' ? all.slice(0, -1) : all;
	return {
		lines: withoutTrailingBlank.slice(Math.max(0, withoutTrailingBlank.length - maxLines)),
		total: withoutTrailingBlank.length
	};
}

/**
 * The newest file under the crash report folder whose name starts with the
 * product name (case-insensitive), so helper processes such as
 * `Primal Code Helper (Renderer)` count too. Name only; contents are never read.
 */
export function newestCrashReportName(entries: readonly ICrashReportEntry[], productName: string): string | undefined {
	const prefix = productName.toLowerCase();
	const ours = entries.filter(entry => entry.name.toLowerCase().startsWith(prefix));
	if (ours.length === 0) {
		return undefined;
	}
	return ours.reduce((newest, entry) => entry.mtime > newest.mtime ? entry : newest).name;
}

function cutLine(line: string): string {
	return line.length > PRIMAL_REPORT_MAX_LINE_LENGTH
		? line.substring(0, PRIMAL_REPORT_MAX_LINE_LENGTH) + PRIMAL_REPORT_LINE_CUT_MARKER
		: line;
}

function logSection(label: string, source: ProblemReportLogSource): readonly string[] {
	if (hasKey(source, { error: true })) {
		return [`### ${label}`, '', `Could not read ${label}: ${source.error}`, ''];
	}
	const tail = tailLines(source.text, PRIMAL_REPORT_LOG_TAIL_LINES);
	const scope = tail.total > tail.lines.length
		? `last ${tail.lines.length} of ${tail.total} lines`
		: `all ${tail.total} lines`;
	return [
		`### ${label} (${scope})`,
		'',
		'<details>',
		'',
		'````text',
		...tail.lines.map(cutLine),
		'````',
		'',
		'</details>',
		''
	];
}

function crashLine(info: ProblemReportCrashInfo): string {
	switch (info.kind) {
		case 'found': return `- Newest crash report: ${info.fileName} (file name only)`;
		case 'none': return '- No crash report for this app was found';
		case 'skipped': return `- Crash reports not checked: ${info.reason}`;
	}
}

function shortCommit(commit: string | undefined): string {
	return commit ? commit.substring(0, PRIMAL_REPORT_SHORT_COMMIT_LENGTH) : 'unknown';
}

function buildDate(date: string | undefined): string {
	return date ? date.substring(0, 'YYYY-MM-DD'.length) : 'unknown';
}

function assembleUnsanitised(input: IProblemReportInput): string {
	const providers = input.providerIds.length > 0 ? input.providerIds.join(', ') : 'none';
	return [
		`## ${input.product.name} problem report`,
		'',
		'### What happened',
		'',
		'<!-- Describe what you were doing and what went wrong. Steps to repeat it help most. -->',
		'',
		'### Environment',
		'',
		`- Product: ${input.product.name} ${input.product.version} (commit ${shortCommit(input.product.commit)}, build date ${buildDate(input.product.date)})`,
		`- OS: ${input.os.name} ${input.os.release} ${input.os.arch}`,
		`- Colour theme: ${input.colorTheme}`,
		`- Vibe: ${input.vibe}`,
		`- Motif: ${input.motif.id}, motion ${input.motif.motion}`,
		`- Wallpaper: ${input.wallpaperMode}`,
		`- Providers with a saved key: ${providers} (ids only; no key, token or secret is ever included)`,
		`- Agent provider: ${input.harnessProviderId ?? 'not set'}`,
		crashLine(input.crashReport),
		'',
		'Home directory paths are shown as `~`; anything shaped like a credential is shown as `' + PRIMAL_REPORT_REDACTED + '`.',
		'',
		...logSection('main.log', input.mainLog),
		...logSection('renderer.log', input.rendererLog)
	].join('\n');
}

/**
 * Builds the whole report as Markdown. Pure: the same input always gives the
 * same text, and every part of it, headers included, passes through the
 * sanitiser so a secret that reached any input still cannot reach the report.
 */
export function buildProblemReport(input: IProblemReportInput): string {
	return sanitiseReportText(assembleUnsanitised(input), { homeDir: input.homeDir, hostname: input.os.hostname });
}

/** The issue title, sanitised the same way as the body. */
export function buildProblemReportTitle(input: IProblemReportInput): string {
	const title = `Problem report: ${input.product.name} ${input.product.version} on ${input.os.name} ${input.os.arch}`;
	return sanitiseReportText(title, { homeDir: input.homeDir, hostname: input.os.hostname });
}
