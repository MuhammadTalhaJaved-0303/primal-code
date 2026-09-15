/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the first-run guide remembers between launches. Persisted as one JSON
 * record in APPLICATION-scope storage under {@link PRIMAL_FIRST_RUN_STORAGE_KEY},
 * so it is shared by every window and profile on this machine and never synced.
 *
 * Only the user's own progress is stored. Whether a model is connected is
 * detected live every time (see `primalFirstRunService.ts`): a key removed
 * later must not be remembered as still there.
 */
export interface IFirstRunState {
	/** The user changed the vibe or explicitly kept the default. */
	readonly vibeChosen: boolean;
	/** A session was started or a folder / repository was opened. */
	readonly started: boolean;
	/** All three steps were seen done at least once; the strip stays hidden. */
	readonly complete: boolean;
	/** The one-line "You're set" was shown once; it does not return. */
	readonly completeNoticeShown: boolean;
}

export const PRIMAL_FIRST_RUN_STORAGE_KEY = 'primalCode.firstRun.state';

export const INITIAL_FIRST_RUN_STATE: IFirstRunState = Object.freeze({
	vibeChosen: false,
	started: false,
	complete: false,
	completeNoticeShown: false,
});

/** A plain JSON object: the only shape the stored record may take. Arrays and null are not it. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored field counts only when it is an actual boolean; anything else is the default. */
function booleanField(record: Record<string, unknown>, key: keyof IFirstRunState): boolean {
	const value = record[key];
	return typeof value === 'boolean' ? value : INITIAL_FIRST_RUN_STATE[key];
}

/**
 * Parses the stored record. Storage is external data: a missing, empty,
 * malformed or foreign payload parses to the initial state, and each field is
 * validated on its own so one bad field never discards the others.
 */
export function parseFirstRunState(raw: string | undefined): IFirstRunState {
	if (raw === undefined || raw.trim().length === 0) {
		return INITIAL_FIRST_RUN_STATE;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return INITIAL_FIRST_RUN_STATE;
	}

	if (!isRecord(parsed)) {
		return INITIAL_FIRST_RUN_STATE;
	}

	return {
		vibeChosen: booleanField(parsed, 'vibeChosen'),
		started: booleanField(parsed, 'started'),
		complete: booleanField(parsed, 'complete'),
		completeNoticeShown: booleanField(parsed, 'completeNoticeShown'),
	};
}

export function serializeFirstRunState(state: IFirstRunState): string {
	return JSON.stringify(state);
}

/** A copy with the given fields changed; the original is never touched. */
export function withFirstRunState(state: IFirstRunState, patch: Partial<IFirstRunState>): IFirstRunState {
	return { ...state, ...patch };
}
