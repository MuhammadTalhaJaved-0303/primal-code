/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * A release manifest that has already been proven well-formed. Nothing outside
 * this module may construct one, so anything holding an
 * {@link IPrimalUpdateManifest} is holding validated data: the URLs are parsed
 * `https:` URIs rather than strings off the network, which is what lets the
 * caller hand them straight to `IOpenerService`.
 */
export interface IPrimalUpdateManifest {

	/** Marketing version, e.g. `1.135.0`. Display only. */
	readonly version: string;

	/** The build identity we compare against `IProductService.commit`. */
	readonly commit: string;

	/** Optional release nickname shown next to the version. */
	readonly name?: string;

	/** Optional release-notes page. */
	readonly notesUrl?: URI;

	/** Installer per `<platform>-<arch>` key. May be empty. */
	readonly downloads: ReadonlyMap<string, URI>;
}

/**
 * A git object name: 7 characters when abbreviated, 40 for sha-1, 64 for sha-256.
 */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

/** Semver plus the usual pre-release/build punctuation, and nothing else. */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/**
 * Characters that would let a manifest turn a notification into something it is
 * not. Notification messages are run through `parseLinkedText`
 * (`workbench/common/notifications.ts`), so square brackets and parentheses can
 * fabricate a clickable link; angle brackets, backticks and control characters
 * are excluded on the same principle.
 */
const UNSAFE_DISPLAY_PATTERN = /[[\]()<>`\\\u0000-\u001f\u007f]/;

const isSafeDisplayText = (value: string): boolean => !UNSAFE_DISPLAY_PATTERN.test(value);

const MAX_COMMIT_LENGTH = 64;
const MAX_VERSION_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_DOWNLOAD_KEY_LENGTH = 64;
const MAX_DOWNLOAD_ENTRIES = 32;

const isBoundedString = (value: unknown, maxLength: number): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= maxLength;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses a string into an `https:` URI, or `undefined` for anything else --
 * including the schemes that would be dangerous to hand to an opener
 * (`command:`, `javascript:`, `file:`). `URI.parse` is non-strict here, which
 * never throws but does default a scheme-less value to `file`, so the explicit
 * scheme check is what does the work.
 */
const toHttpsUri = (value: unknown): URI | undefined => {
	if (!isBoundedString(value, MAX_URL_LENGTH)) {
		return undefined;
	}

	try {
		const uri = URI.parse(value);
		if (uri.scheme.toLowerCase() !== 'https' || uri.authority.length === 0) {
			return undefined;
		}
		return uri;
	} catch {
		return undefined;
	}
};

const parseDownloads = (value: unknown): ReadonlyMap<string, URI> | undefined => {
	if (!isPlainObject(value)) {
		return undefined;
	}

	const entries = Object.entries(value);
	if (entries.length > MAX_DOWNLOAD_ENTRIES) {
		return undefined;
	}

	const downloads = new Map<string, URI>();
	for (const [key, rawUrl] of entries) {
		if (!isBoundedString(key, MAX_DOWNLOAD_KEY_LENGTH)) {
			return undefined;
		}

		const url = toHttpsUri(rawUrl);
		if (!url) {
			return undefined; // one bad entry discredits the whole manifest
		}

		downloads.set(key, url);
	}

	return downloads;
};

/**
 * Validates a value parsed from the manifest response. This is untrusted network
 * input: every field is checked, and a single failure rejects the whole document
 * rather than yielding a partially trusted one.
 *
 * @returns the validated manifest, or `undefined` if it is not usable.
 */
export const parsePrimalUpdateManifest = (raw: unknown): IPrimalUpdateManifest | undefined => {
	if (!isPlainObject(raw)) {
		return undefined;
	}

	const commit = raw['commit'];
	if (!isBoundedString(commit, MAX_COMMIT_LENGTH) || !COMMIT_PATTERN.test(commit)) {
		return undefined;
	}

	const version = raw['version'];
	if (!isBoundedString(version, MAX_VERSION_LENGTH) || !VERSION_PATTERN.test(version)) {
		return undefined;
	}

	const downloads = parseDownloads(raw['downloads']);
	if (!downloads) {
		return undefined;
	}

	const rawNotesUrl = raw['notesUrl'];
	let notesUrl: URI | undefined;
	if (rawNotesUrl !== undefined) {
		notesUrl = toHttpsUri(rawNotesUrl);
		if (!notesUrl) {
			return undefined;
		}
	}

	// A cosmetic field: a name we cannot render safely is dropped rather than
	// used to reject an otherwise valid manifest.
	const rawName = raw['name'];
	const name = isBoundedString(rawName, MAX_NAME_LENGTH) && isSafeDisplayText(rawName) ? rawName : undefined;

	return { version, commit, name, notesUrl, downloads };
};
