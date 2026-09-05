/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { ILogService } from '../../log/common/log.js';
import { IPrimalNowPlaying, PrimalPlayerState } from '../common/primalMedia.js';
import { DARWIN_PLAYERS, IDarwinPlayer, NOW_PLAYING_ERROR_PREFIX, NOW_PLAYING_FIELD_COUNT, NOW_PLAYING_FIELD_SEPARATOR, NOW_PLAYING_OSASCRIPT_ARGS, NOW_PLAYING_RECORD_SEPARATOR, OSASCRIPT_PATH } from './darwinNowPlayingScript.js';
import { INowPlayingReader } from './primalMediaPoller.js';

/**
 * Upper bound for one poll. A normal poll takes well under a second; the script itself
 * gives each player 3 seconds, so only a stuck process or a pending macOS Automation
 * consent prompt gets this far.
 */
const OSASCRIPT_TIMEOUT_MS = 10_000;

/** The output is one short line; anything larger is a bug, not data. */
const OSASCRIPT_MAX_BUFFER = 64 * 1024;

/** After a failed or timed-out run, polls are skipped for this long instead of retrying every tick. */
const FAILURE_BACKOFF_MS = 60_000;

/** AppleScript's errAEEventNotPermitted: the user has not granted Automation access. */
const ERROR_NOT_PERMITTED = -1743;

const HTTP_URL = /^https?:\/\//i;

const PLAYERS_BY_ID: ReadonlyMap<string, IDarwinPlayer> = new Map(DARWIN_PLAYERS.map(player => [player.id, player]));

/** A per-player failure the script reported instead of a track, or a record that could not be parsed. */
export interface INowPlayingScriptError {
	readonly player: string;
	readonly errorNumber: number | undefined;
	readonly message: string;
}

export interface INowPlayingParseResult {
	readonly nowPlaying: IPrimalNowPlaying | undefined;
	readonly errors: readonly INowPlayingScriptError[];
}

/** Runs `osascript` with the given arguments; resolves stdout, rejects with an {@link OsascriptError}. */
export type OsascriptRunner = (args: readonly string[]) => Promise<string>;

export class OsascriptError extends Error {
	constructor(
		readonly timedOut: boolean,
		readonly detail: string,
	) {
		super(timedOut ? 'osascript timed out' : `osascript failed: ${detail}`);
	}
}

/**
 * Turns the poll script's stdout into a reading. Pure: any record that does not have
 * the expected shape is reported in `errors` and otherwise ignored. When several
 * players report a track, a playing one wins over a paused one; ties keep script order.
 */
export function parseNowPlayingOutput(stdout: string): INowPlayingParseResult {
	const candidates: IPrimalNowPlaying[] = [];
	const errors: INowPlayingScriptError[] = [];
	for (const record of stdout.replace(/\r?\n$/, '').split(NOW_PLAYING_RECORD_SEPARATOR)) {
		if (record.length === 0) {
			continue; // a stopped player, or the empty tail after the last separator
		}
		const fields = record.split(NOW_PLAYING_FIELD_SEPARATOR);
		if (fields[0].startsWith(NOW_PLAYING_ERROR_PREFIX)) {
			errors.push(parseErrorRecord(fields));
			continue;
		}
		const result = parseTrackRecord(fields);
		if (typeof result === 'string') {
			errors.push({ player: fields[0], errorNumber: undefined, message: result });
		} else {
			candidates.push(result);
		}
	}
	const nowPlaying = candidates.find(candidate => candidate.state === 'playing') ?? candidates.find(candidate => candidate.state === 'paused');
	return { nowPlaying, errors };
}

function parseErrorRecord(fields: readonly string[]): INowPlayingScriptError {
	const errorNumber = fields[1] ?? '';
	return {
		player: fields[0].slice(NOW_PLAYING_ERROR_PREFIX.length),
		errorNumber: /^-?\d+$/.test(errorNumber) ? Number(errorNumber) : undefined,
		message: fields.slice(2).join(NOW_PLAYING_FIELD_SEPARATOR),
	};
}

/** Returns the reading, or the reason the record could not be turned into one. */
function parseTrackRecord(fields: readonly string[]): IPrimalNowPlaying | string {
	if (fields.length !== NOW_PLAYING_FIELD_COUNT) {
		return `expected ${NOW_PLAYING_FIELD_COUNT} fields, got ${fields.length}`;
	}
	const [app, stateName, title, artist, album, positionText, durationText, artworkUrl] = fields;
	const player = PLAYERS_BY_ID.get(app);
	if (!player) {
		return `unknown player "${app}"`;
	}
	const state = toPlayerState(stateName);
	if (!state) {
		return `unknown player state "${stateName}"`;
	}
	const position = parseWholeNumber(positionText);
	const duration = toDurationSeconds(parseWholeNumber(durationText), player);
	return {
		app: player.id,
		appLabel: player.label,
		title,
		artist,
		...(album.length > 0 ? { album } : {}),
		state,
		...(position !== undefined ? { position } : {}),
		...(duration !== undefined ? { duration } : {}),
		...(HTTP_URL.test(artworkUrl) ? { artworkUrl } : {}),
	};
}

function toPlayerState(stateName: string): PrimalPlayerState | undefined {
	switch (stateName.toLowerCase()) {
		case 'playing':
		case 'fast forwarding':
		case 'rewinding':
			return 'playing';
		case 'paused':
			return 'paused';
		default:
			return undefined; // stopped, or something we do not know how to read
	}
}

function toDurationSeconds(duration: number | undefined, player: IDarwinPlayer): number | undefined {
	if (duration === undefined) {
		return undefined;
	}
	return player.durationUnit === 'milliseconds' ? Math.round(duration / 1000) : duration;
}

/** The script emits whole numbers as text (`as integer`), so no locale-specific decimal separator can appear. */
function parseWholeNumber(text: string): number | undefined {
	if (!/^\d+$/.test(text)) {
		return undefined;
	}
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : undefined;
}

function runOsascriptProcess(args: readonly string[]): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile(OSASCRIPT_PATH, [...args], { timeout: OSASCRIPT_TIMEOUT_MS, maxBuffer: OSASCRIPT_MAX_BUFFER, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				reject(new OsascriptError(error.killed === true, String(stderr).trim() || error.message));
				return;
			}
			resolve(String(stdout));
		});
	});
}

/**
 * Reads Spotify and Music on macOS with one `osascript` run per poll. The script is a
 * constant (see darwinNowPlayingScript.ts); the process is bounded by a timeout and an
 * output cap; a failed run is logged once and followed by a back-off so a denied
 * Automation permission does not spam the log every poll.
 */
export class DarwinNowPlayingReader implements INowPlayingReader {

	readonly players: readonly string[] = DARWIN_PLAYERS.map(player => player.id);

	private backoffUntil = 0;
	private didWarnRunFailure = false;
	private readonly warnedPlayers = new Set<string>();

	constructor(
		private readonly logService: ILogService,
		private readonly runOsascript: OsascriptRunner = runOsascriptProcess,
		private readonly now: () => number = () => Date.now(),
	) { }

	async read(): Promise<IPrimalNowPlaying | undefined> {
		if (this.now() < this.backoffUntil) {
			return undefined;
		}
		let stdout: string;
		try {
			stdout = await this.runOsascript(NOW_PLAYING_OSASCRIPT_ARGS);
		} catch (error) {
			return this.onRunFailed(error);
		}
		this.didWarnRunFailure = false;
		const { nowPlaying, errors } = parseNowPlayingOutput(stdout);
		for (const error of errors) {
			this.onPlayerError(error);
		}
		return nowPlaying;
	}

	private onRunFailed(error: unknown): undefined {
		this.backoffUntil = this.now() + FAILURE_BACKOFF_MS;
		if (error instanceof OsascriptError && error.timedOut) {
			this.logService.trace(`[PrimalMedia] osascript timed out; pausing polls for ${FAILURE_BACKOFF_MS} ms`);
			return undefined;
		}
		const detail = error instanceof OsascriptError ? error.detail : String(error);
		if (this.didWarnRunFailure) {
			this.logService.trace(`[PrimalMedia] osascript failed again: ${detail}`);
			return undefined;
		}
		this.didWarnRunFailure = true;
		this.logService.warn(`[PrimalMedia] osascript failed; pausing polls for ${FAILURE_BACKOFF_MS} ms: ${detail}`);
		return undefined;
	}

	private onPlayerError(error: INowPlayingScriptError): void {
		const message = `[PrimalMedia] ${error.player} could not be read (${error.errorNumber ?? 'no error number'}): ${error.message}`;
		if (error.errorNumber === ERROR_NOT_PERMITTED && !this.warnedPlayers.has(error.player)) {
			this.warnedPlayers.add(error.player);
			this.logService.warn(`${message} — Automation access has not been granted in System Settings > Privacy & Security`);
			return;
		}
		this.logService.trace(message);
	}
}
