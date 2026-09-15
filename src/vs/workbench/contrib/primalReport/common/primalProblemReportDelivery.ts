/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub answers "414 URI Too Long" well before browsers do; 8000 characters
 * keeps the prefilled issue link comfortably inside what it accepts.
 */
export const PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH = 8000;

/** The issue body used when the real report had to go to the clipboard instead. */
export const PRIMAL_REPORT_CLIPBOARD_BODY = [
	'The full problem report was too long to fit in this link, so Primal Code copied it to the clipboard.',
	'',
	'Please paste it below this line, then describe what you were doing and what went wrong.',
	'',
	'---',
	''
].join('\n');

export type ProblemReportDelivery =
	| { readonly mode: 'url'; readonly url: string }
	| { readonly mode: 'clipboard'; readonly url: string; readonly clipboardText: string };

/** `reportIssueUrl` plus `title` and `body` query parameters, respecting an existing query. */
export function buildIssueUrl(reportIssueUrl: string, title: string, body: string): string {
	const separator = reportIssueUrl.includes('?') ? '&' : '?';
	return `${reportIssueUrl}${separator}title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * Decides how a report reaches GitHub: inside the link when it fits, otherwise
 * on the clipboard with a short body telling the user to paste it.
 */
export function planProblemReportDelivery(reportIssueUrl: string, title: string, report: string): ProblemReportDelivery {
	const direct = buildIssueUrl(reportIssueUrl, title, report);
	if (direct.length <= PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH) {
		return { mode: 'url', url: direct };
	}
	return {
		mode: 'clipboard',
		url: buildIssueUrl(reportIssueUrl, title, PRIMAL_REPORT_CLIPBOARD_BODY),
		clipboardText: report
	};
}
