/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeIntl } from '../../../../base/common/date.js';
import { Lazy } from '../../../../base/common/lazy.js';
import { localize } from '../../../../nls.js';

const BYTES_PER_GIB = 1024 ** 3;
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_MINUTE = 60;

/**
 * Pure formatters for the Deck's readouts. Every function only rounds for
 * display; none of them changes the number it was given.
 */

export function clampFraction(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** `0.623` becomes "62%". */
export function formatPercent(fraction: number): string {
	return localize('primalDeck.percent', "{0}%", Math.round(clampFraction(fraction) * 100));
}

export function formatMemory(usedBytes: number, totalBytes: number): string {
	return localize('primalDeck.memory', "{0} / {1} GB", (usedBytes / BYTES_PER_GIB).toFixed(1), (totalBytes / BYTES_PER_GIB).toFixed(1));
}

export function formatLoadAverage(load: readonly [number, number, number]): string {
	return load.map(value => value.toFixed(2)).join(' ');
}

export function formatUptime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(seconds / SECONDS_PER_DAY);
	const hours = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
	const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	if (days > 0) {
		return localize('primalDeck.uptime.days', "{0}d {1}h {2}m", days, hours, minutes);
	}
	if (hours > 0) {
		return localize('primalDeck.uptime.hours', "{0}h {1}m", hours, minutes);
	}
	return localize('primalDeck.uptime.minutes', "{0}m", minutes);
}

/** A generation duration: "12.3 s", or "3 m 4 s" past a minute. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < SECONDS_PER_MINUTE) {
		return localize('primalDeck.elapsed.seconds', "{0} s", seconds.toFixed(1));
	}
	return localize('primalDeck.elapsed.minutes', "{0} m {1} s", Math.floor(seconds / SECONDS_PER_MINUTE), Math.floor(seconds % SECONDS_PER_MINUTE));
}

/** A playback position or length: `72` becomes "1:12". */
export function formatPlaybackTime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`;
}

/**
 * A wall-clock `HH:MM:SS` formatter in the user's locale. Lazy, so the
 * (comparatively expensive) `Intl` construction is paid on first use rather
 * than at import, and safe against an invalid locale.
 */
export function createClockFormatter(): Lazy<Intl.DateTimeFormat> {
	return safeIntl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

/** The last `max` characters of `text`, whitespace collapsed to one line; a leading ellipsis marks the trim. */
export function tailOf(text: string, max: number): string {
	const window = text.length > max * 2 ? text.slice(-(max * 2)) : text;
	const flat = window.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

/** The first line of `text`, at most `max` characters; a trailing ellipsis marks the trim. */
export function firstLineOf(text: string, max: number): string {
	const newline = text.indexOf('\n');
	const line = (newline >= 0 ? text.slice(0, newline) : text).trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}
