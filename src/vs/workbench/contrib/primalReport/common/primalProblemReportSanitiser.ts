/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { escapeRegExpCharacters } from '../../../../base/common/strings.js';

/** What every credential-looking value is replaced with. */
export const PRIMAL_REPORT_REDACTED = '[redacted]';

/** What the machine's hostname is replaced with. */
export const PRIMAL_REPORT_HOSTNAME_PLACEHOLDER = '[hostname]';

/** Shortest run of hex digits that is treated as a hash or id and hidden. */
const LONG_HEX_MIN_LENGTH = 32;

/** Shortest run of base64-ish characters that is treated as a token and hidden. */
const LONG_BLOB_MIN_LENGTH = 40;

/** Hostnames shorter than this are too common a word to blank out safely. */
const HOSTNAME_MIN_LENGTH = 3;

export interface ISanitiseOptions {
	/** The user's home directory as a file system path; shown as `~`. */
	readonly homeDir: string;
	/** The machine's hostname, if known; shown as `[hostname]`. */
	readonly hostname?: string;
}

/**
 * Well-known credential shapes. Each is replaced whole. `Bearer` keeps the
 * scheme word so the redacted line still reads as an authorization header.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g,                               // OpenAI, Anthropic, DeepSeek, Kimi style keys
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,                    // GitHub tokens
	/\bgithub_pat_[A-Za-z0-9_]{8,}/g,                                // GitHub fine-grained tokens
	/\bxox[abeprs]-[A-Za-z0-9-]{8,}/g,                               // Slack tokens
	/\bAKIA[0-9A-Z]{16}\b/g,                                         // AWS access key ids
	/\bAIza[0-9A-Za-z_-]{20,}/g,                                     // Google API keys
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g   // JSON web tokens
];

/** `Authorization: Bearer <token>` in any casing. */
const BEARER_PATTERN = /\b(Bearer\s+)[^\s"']+/gi;

/** `api_key=…`, `"apiKey": "…"`, `password: …` and friends. */
const KEY_VALUE_PATTERN = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)(\s*["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi;

/** `?key=…`, `&access_token=…` inside URLs. */
const QUERY_PARAM_PATTERN = /([?&](?:api[_-]?key|key|token|access_token|secret|sig|signature)=)([^&\s"']+)/gi;

/** Any long run of hash- or base64-looking characters; filtered by {@link looksLikeSecretBlob}. */
const LONG_BLOB_PATTERN = /[A-Za-z0-9+/=_-]{32,}/g;

const HEX_ONLY = /^[0-9a-fA-F]+$/;

/**
 * A long run is hidden when it is all hex (hashes, machine and session ids) or
 * when it is long and mixes digits with upper and lower case letters the way
 * generated tokens do. Long lower-case identifiers with underscores and
 * dashes, which real file and process names produce, are left readable.
 */
function looksLikeSecretBlob(run: string): boolean {
	if (run.length >= LONG_HEX_MIN_LENGTH && HEX_ONLY.test(run)) {
		return true;
	}
	if (run.length < LONG_BLOB_MIN_LENGTH) {
		return false;
	}
	return /\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run);
}

/** Both slash spellings of a path, so a Windows home also matches its forward-slash form. */
function homeDirPattern(homeDir: string): RegExp | undefined {
	const trimmed = homeDir.replace(/[\\/]+$/, '');
	if (trimmed.length < 2) {
		return undefined;
	}
	const alternatives = new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')]);
	return new RegExp([...alternatives].map(escapeRegExpCharacters).join('|'), 'g');
}

function hostnamePattern(hostname: string | undefined): RegExp | undefined {
	if (!hostname || hostname.length < HOSTNAME_MIN_LENGTH) {
		return undefined;
	}
	return new RegExp(escapeRegExpCharacters(hostname), 'gi');
}

/**
 * Removes what a problem report must never carry: the home directory (shown
 * as `~`), the hostname, and anything shaped like a credential. Pure; the
 * same input always gives the same output.
 */
export function sanitiseReportText(text: string, options: ISanitiseOptions): string {
	const steps: readonly ((value: string) => string)[] = [
		value => {
			const pattern = homeDirPattern(options.homeDir);
			return pattern ? value.replace(pattern, '~') : value;
		},
		value => {
			const pattern = hostnamePattern(options.hostname);
			return pattern ? value.replace(pattern, PRIMAL_REPORT_HOSTNAME_PLACEHOLDER) : value;
		},
		value => value.replace(BEARER_PATTERN, `$1${PRIMAL_REPORT_REDACTED}`),
		value => value.replace(KEY_VALUE_PATTERN, `$1$2${PRIMAL_REPORT_REDACTED}`),
		value => value.replace(QUERY_PARAM_PATTERN, `$1${PRIMAL_REPORT_REDACTED}`),
		value => CREDENTIAL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, PRIMAL_REPORT_REDACTED), value),
		value => value.replace(LONG_BLOB_PATTERN, run => looksLikeSecretBlob(run) ? PRIMAL_REPORT_REDACTED : run)
	];
	return steps.reduce((value, step) => step(value), text);
}
