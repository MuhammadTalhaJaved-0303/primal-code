/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The AppleScript that reads "now playing" from Spotify and Music on macOS.
 *
 * Addressing an application in AppleScript (`tell application "Spotify"`) launches it
 * when it is not running, and merely *compiling* such a statement makes AppleScript
 * locate the application (on a machine where it is not installed that raises a
 * "Where is Spotify?" chooser). This script therefore never mentions a player outside
 * of a string literal:
 *
 * 1. It asks System Events — a faceless background agent that is always running — for
 *    the bundle identifiers of the running processes.
 * 2. Only for a player that is in that list does it `run script` the player's reader.
 *    The reader is compiled and executed at that moment and nowhere else, so a player
 *    that is not running is never addressed and can never be launched.
 *
 * Every line is a constant assembled from the literals in this file. Nothing from the
 * outside is ever spliced in. The module has no imports on purpose, so tooling can load
 * it on its own to exercise the exact script that ships.
 *
 * Output wire format (one line, written by `osascript` to stdout): zero or more records
 * separated by {@link NOW_PLAYING_RECORD_SEPARATOR}; a track record carries
 * {@link NOW_PLAYING_FIELD_COUNT} fields separated by {@link NOW_PLAYING_FIELD_SEPARATOR}
 * in the order `app, state, title, artist, album, position, duration, artworkUrl`; a
 * record whose first field starts with {@link NOW_PLAYING_ERROR_PREFIX} carries
 * `!app, errorNumber, errorMessage` for a player whose reader failed. A player that is
 * stopped contributes an empty record.
 */

/** Separates the fields of one record in the script's output (U+001F). */
export const NOW_PLAYING_FIELD_SEPARATOR = '\u001f';

/** Separates records in the script's output (U+001E). */
export const NOW_PLAYING_RECORD_SEPARATOR = '\u001e';

/** First character of a record that carries a per-player script error instead of a track. */
export const NOW_PLAYING_ERROR_PREFIX = '!';

/** Fields of a track record: app, state, title, artist, album, position, duration, artworkUrl. */
export const NOW_PLAYING_FIELD_COUNT = 8;

/** Absolute path of the interpreter; never resolved through `PATH`. */
export const OSASCRIPT_PATH = '/usr/bin/osascript';

export interface IDarwinPlayer {
	/** Identifier used as `IPrimalNowPlaying.app` and as the first field of a record. */
	readonly id: string;
	/** Human name used as `IPrimalNowPlaying.appLabel`. */
	readonly label: string;
	/** Bundle identifier System Events reports for the running process. */
	readonly bundleId: string;
	/** Unit of the `duration` field this player reports. */
	readonly durationUnit: 'seconds' | 'milliseconds';
	/**
	 * The player's reader, as AppleScript lines. Compiled only by `run script`, i.e.
	 * only once System Events has reported the player running. Optional fields are
	 * read inside `try` so one missing value does not lose the whole reading.
	 */
	readonly readerLines: readonly string[];
}

/**
 * Spotify: `player state` is stopped / playing / paused; `player position` is in
 * seconds; the track's `duration` is in MILLISECONDS; `artwork url` is a real URL.
 */
const SPOTIFY_READER_LINES: readonly string[] = [
	'set fieldSep to character id 31',
	'with timeout of 3 seconds',
	'tell application id "com.spotify.client"',
	'set stateName to ""',
	'try',
	'set stateName to (player state as text)',
	'on error',
	'if player state is playing then set stateName to "playing"',
	'if player state is paused then set stateName to "paused"',
	'end try',
	'if stateName is "" or stateName is "stopped" then return ""',
	'set theTrack to current track',
	'set trackTitle to ""',
	'try',
	'set trackTitle to (name of theTrack) as text',
	'end try',
	'set trackArtist to ""',
	'try',
	'set trackArtist to (artist of theTrack) as text',
	'end try',
	'set trackAlbum to ""',
	'try',
	'set trackAlbum to (album of theTrack) as text',
	'end try',
	'set thePosition to ""',
	'try',
	'set thePosition to ((player position) as integer) as text',
	'end try',
	'set theDuration to ""',
	'try',
	'set theDuration to ((duration of theTrack) as integer) as text',
	'end try',
	'set theArtwork to ""',
	'try',
	'set theArtwork to (artwork url of theTrack) as text',
	'end try',
	'return "spotify" & fieldSep & stateName & fieldSep & trackTitle & fieldSep & trackArtist & fieldSep & trackAlbum & fieldSep & thePosition & fieldSep & theDuration & fieldSep & theArtwork',
	'end tell',
	'end timeout',
];

/**
 * Music: `player state` is stopped / playing / paused / fast forwarding / rewinding;
 * `player position` and the track's `duration` are both in seconds; artwork is only
 * available as image bytes, never as a URL, so the artwork field stays empty.
 */
const MUSIC_READER_LINES: readonly string[] = [
	'set fieldSep to character id 31',
	'with timeout of 3 seconds',
	'tell application id "com.apple.Music"',
	'set stateName to ""',
	'try',
	'set stateName to (player state as text)',
	'on error',
	'if player state is playing then set stateName to "playing"',
	'if player state is paused then set stateName to "paused"',
	'end try',
	'if stateName is "" or stateName is "stopped" then return ""',
	'set theTrack to current track',
	'set trackTitle to ""',
	'try',
	'set trackTitle to (name of theTrack) as text',
	'end try',
	'set trackArtist to ""',
	'try',
	'set trackArtist to (artist of theTrack) as text',
	'end try',
	'set trackAlbum to ""',
	'try',
	'set trackAlbum to (album of theTrack) as text',
	'end try',
	'set thePosition to ""',
	'try',
	'set thePosition to ((player position) as integer) as text',
	'end try',
	'set theDuration to ""',
	'try',
	'set theDuration to ((duration of theTrack) as integer) as text',
	'end try',
	'return "music" & fieldSep & stateName & fieldSep & trackTitle & fieldSep & trackArtist & fieldSep & trackAlbum & fieldSep & thePosition & fieldSep & theDuration & fieldSep & ""',
	'end tell',
	'end timeout',
];

/** The players this platform knows how to read, in order of preference. */
export const DARWIN_PLAYERS: readonly IDarwinPlayer[] = [
	{ id: 'spotify', label: 'Spotify', bundleId: 'com.spotify.client', durationUnit: 'milliseconds', readerLines: SPOTIFY_READER_LINES },
	{ id: 'music', label: 'Music', bundleId: 'com.apple.Music', durationUnit: 'seconds', readerLines: MUSIC_READER_LINES },
];

/** Turns reader lines into one AppleScript string literal for `run script`. */
function toAppleScriptStringLiteral(lines: readonly string[]): string {
	const escaped = lines
		.join('\n')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n');
	return `"${escaped}"`;
}

/**
 * The guarded block for one player: the reader string is only handed to `run script`
 * when System Events lists the player's bundle identifier among the running processes.
 * A reader failure becomes an error record so the other player is still read.
 */
function toGuardedReaderLines(player: IDarwinPlayer): readonly string[] {
	return [
		`if runningIds contains "${player.bundleId}" then`,
		'try',
		`set theOutput to theOutput & (run script ${toAppleScriptStringLiteral(player.readerLines)}) & recordSep`,
		'on error errorMessage number errorNumber',
		`set theOutput to theOutput & "${NOW_PLAYING_ERROR_PREFIX}${player.id}" & fieldSep & errorNumber & fieldSep & errorMessage & recordSep`,
		'end try',
		'end if',
	];
}

/**
 * The complete poll script, one AppleScript line per entry. The only application it
 * addresses directly is System Events.
 */
export const NOW_PLAYING_SCRIPT_LINES: readonly string[] = [
	'set recordSep to character id 30',
	'set fieldSep to character id 31',
	'set theOutput to ""',
	'tell application "System Events"',
	'set runningIds to bundle identifier of processes',
	'end tell',
	...DARWIN_PLAYERS.flatMap(player => toGuardedReaderLines(player)),
	'return theOutput',
];

/** `osascript` arguments for one poll: every script line as its own `-e` argument. */
export const NOW_PLAYING_OSASCRIPT_ARGS: readonly string[] = NOW_PLAYING_SCRIPT_LINES.flatMap(line => ['-e', line]);
