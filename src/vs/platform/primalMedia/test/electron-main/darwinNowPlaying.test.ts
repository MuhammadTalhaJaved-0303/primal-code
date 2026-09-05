/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { DarwinNowPlayingReader, OsascriptError, parseNowPlayingOutput } from '../../electron-main/darwinNowPlaying.js';
import { DARWIN_PLAYERS, NOW_PLAYING_FIELD_SEPARATOR, NOW_PLAYING_OSASCRIPT_ARGS, NOW_PLAYING_RECORD_SEPARATOR, NOW_PLAYING_SCRIPT_LINES } from '../../electron-main/darwinNowPlayingScript.js';

/** One record the way the script builds it: fields joined by U+001F. */
function record(...fields: string[]): string {
	return fields.join(NOW_PLAYING_FIELD_SEPARATOR);
}

/** stdout the way osascript prints it: every record followed by U+001E, then a newline. */
function stdout(...records: string[]): string {
	return records.map(entry => entry + NOW_PLAYING_RECORD_SEPARATOR).join('') + '\n';
}

class CapturingLogService extends NullLogService {
	readonly warnings: string[] = [];
	override warn(message: string): void {
		this.warnings.push(message);
	}
}

suite('Primal Media - darwin now playing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseNowPlayingOutput', () => {

		test('no player running: only the newline osascript appends', () => {
			assert.deepStrictEqual(parseNowPlayingOutput('\n'), { nowPlaying: undefined, errors: [] });
			assert.deepStrictEqual(parseNowPlayingOutput(''), { nowPlaying: undefined, errors: [] });
		});

		test('a running but stopped player contributes an empty record', () => {
			// captured from Music.app launched with nothing playing
			assert.deepStrictEqual(parseNowPlayingOutput('\u001e\n'), { nowPlaying: undefined, errors: [] });
		});

		test('Music playing: seconds pass through and there is no artwork', () => {
			const output = stdout(record('music', 'playing', 'Blue in Green', 'Miles Davis', 'Kind of Blue', '72', '337', ''));
			assert.deepStrictEqual(parseNowPlayingOutput(output), {
				nowPlaying: { app: 'music', appLabel: 'Music', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', state: 'playing', position: 72, duration: 337 },
				errors: [],
			});
		});

		test('Spotify paused: duration converts from milliseconds and the artwork URL is kept', () => {
			const output = stdout(record('spotify', 'paused', 'So What', 'Miles Davis', 'Kind of Blue', '12', '562500', 'https://i.scdn.co/image/abc'));
			assert.deepStrictEqual(parseNowPlayingOutput(output), {
				nowPlaying: { app: 'spotify', appLabel: 'Spotify', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', state: 'paused', position: 12, duration: 563, artworkUrl: 'https://i.scdn.co/image/abc' },
				errors: [],
			});
		});

		test('a playing player wins over a paused one regardless of order', () => {
			const output = stdout(
				record('spotify', 'paused', 'S', 'A', '', '1', '1000', ''),
				record('music', 'playing', 'M', 'B', '', '2', '3', ''),
			);
			assert.strictEqual(parseNowPlayingOutput(output).nowPlaying?.app, 'music');
		});

		test('two paused players: script order wins', () => {
			const output = stdout(
				record('spotify', 'paused', 'S', 'A', '', '1', '1000', ''),
				record('music', 'paused', 'M', 'B', '', '2', '3', ''),
			);
			assert.strictEqual(parseNowPlayingOutput(output).nowPlaying?.app, 'spotify');
		});

		test('fast forwarding and rewinding count as playing', () => {
			assert.strictEqual(parseNowPlayingOutput(stdout(record('music', 'fast forwarding', 'M', 'B', '', '', '', ''))).nowPlaying?.state, 'playing');
			assert.strictEqual(parseNowPlayingOutput(stdout(record('music', 'rewinding', 'M', 'B', '', '', '', ''))).nowPlaying?.state, 'playing');
		});

		test('optional fields are omitted when empty, not numeric or not a URL', () => {
			const output = stdout(record('spotify', 'playing', 'Title', 'Artist', '', '', 'n/a', 'not a url'));
			assert.deepStrictEqual(parseNowPlayingOutput(output).nowPlaying, { app: 'spotify', appLabel: 'Spotify', title: 'Title', artist: 'Artist', state: 'playing' });
		});

		test('titles keep commas, quotes and newlines', () => {
			const title = 'Hello, "World"\nAgain';
			const output = stdout(record('music', 'playing', title, 'A, B', '', '', '', ''));
			assert.strictEqual(parseNowPlayingOutput(output).nowPlaying?.title, title);
		});

		test('a per-player error is reported and does not hide the other player', () => {
			const output = stdout(
				record('!spotify', '-1743', 'Not authorized to send Apple events to Spotify.'),
				record('music', 'paused', 'M', 'B', '', '2', '3', ''),
			);
			assert.deepStrictEqual(parseNowPlayingOutput(output), {
				nowPlaying: { app: 'music', appLabel: 'Music', title: 'M', artist: 'B', state: 'paused', position: 2, duration: 3 },
				errors: [{ player: 'spotify', errorNumber: -1743, message: 'Not authorized to send Apple events to Spotify.' }],
			});
		});

		test('records that do not have the expected shape are reported and dropped', () => {
			const output = stdout(
				record('music', 'playing', 'only three'),
				record('winamp', 'playing', 'T', 'A', '', '', '', ''),
				record('music', 'stopped', 'T', 'A', '', '', '', ''),
			);
			assert.deepStrictEqual(parseNowPlayingOutput(output), {
				nowPlaying: undefined,
				errors: [
					{ player: 'music', errorNumber: undefined, message: 'expected 8 fields, got 3' },
					{ player: 'winamp', errorNumber: undefined, message: 'unknown player "winamp"' },
					{ player: 'music', errorNumber: undefined, message: 'unknown player state "stopped"' },
				],
			});
		});
	});

	suite('DarwinNowPlayingReader', () => {

		test('runs the constant script and returns the parsed reading', async () => {
			const calls: (readonly string[])[] = [];
			const reader = new DarwinNowPlayingReader(new NullLogService(), async args => {
				calls.push(args);
				return stdout(record('spotify', 'playing', 'T', 'A', 'B', '1', '2000', 'https://x/y'));
			}, () => 0);

			assert.deepStrictEqual(await reader.read(), { app: 'spotify', appLabel: 'Spotify', title: 'T', artist: 'A', album: 'B', state: 'playing', position: 1, duration: 2, artworkUrl: 'https://x/y' });
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0], NOW_PLAYING_OSASCRIPT_ARGS);
			assert.deepStrictEqual(reader.players, DARWIN_PLAYERS.map(player => player.id));
		});

		test('a failed run yields nothing, warns once and backs off before running again', async () => {
			let now = 0;
			let runs = 0;
			const logService = new CapturingLogService();
			const reader = new DarwinNowPlayingReader(logService, async () => {
				runs++;
				throw new OsascriptError(false, 'execution error: Not authorized to send Apple events to System Events. (-1743)');
			}, () => now);

			assert.strictEqual(await reader.read(), undefined);
			assert.strictEqual(await reader.read(), undefined);
			assert.strictEqual(runs, 1, 'the second read must be skipped while backing off');
			assert.strictEqual(logService.warnings.length, 1);

			now = 60_000;
			assert.strictEqual(await reader.read(), undefined);
			assert.strictEqual(runs, 2);
			assert.strictEqual(logService.warnings.length, 1, 'a repeated failure is not warned about again');
		});

		test('a timed-out run is no data and backs off without a warning', async () => {
			let now = 0;
			let runs = 0;
			const logService = new CapturingLogService();
			const reader = new DarwinNowPlayingReader(logService, async () => {
				runs++;
				throw new OsascriptError(true, '');
			}, () => now);

			assert.strictEqual(await reader.read(), undefined);
			now = 59_999;
			assert.strictEqual(await reader.read(), undefined);
			assert.deepStrictEqual({ runs, warnings: logService.warnings }, { runs: 1, warnings: [] });
		});

		test('a denied player is warned about once and does not hide the other player', async () => {
			const logService = new CapturingLogService();
			const reader = new DarwinNowPlayingReader(logService, async () => stdout(
				record('!spotify', '-1743', 'Not authorized to send Apple events to Spotify.'),
				record('music', 'playing', 'M', 'B', '', '2', '3', ''),
			), () => 0);

			assert.strictEqual((await reader.read())?.app, 'music');
			assert.strictEqual((await reader.read())?.app, 'music');
			assert.strictEqual(logService.warnings.length, 1);
		});
	});

	suite('script constants', () => {

		test('the only application addressed outside a string literal is System Events', () => {
			for (const line of NOW_PLAYING_SCRIPT_LINES) {
				if (line.startsWith('tell application')) {
					assert.strictEqual(line, 'tell application "System Events"');
				}
				if (line.includes('tell application id')) {
					assert.ok(line.startsWith('set theOutput to theOutput & (run script "'), `player tell must live inside a run script literal: ${line}`);
				}
			}
		});

		test('every player reader sits behind its own running-guard', () => {
			for (const player of DARWIN_PLAYERS) {
				const guardIndex = NOW_PLAYING_SCRIPT_LINES.indexOf(`if runningIds contains "${player.bundleId}" then`);
				assert.ok(guardIndex >= 0, `missing guard for ${player.id}`);
				assert.strictEqual(NOW_PLAYING_SCRIPT_LINES[guardIndex + 1], 'try');
				assert.ok(NOW_PLAYING_SCRIPT_LINES[guardIndex + 2].includes(`tell application id \\"${player.bundleId}\\"`));
			}
		});

		test('osascript receives one -e argument per script line', () => {
			assert.deepStrictEqual(NOW_PLAYING_OSASCRIPT_ARGS, NOW_PLAYING_SCRIPT_LINES.flatMap(line => ['-e', line]));
		});
	});
});
