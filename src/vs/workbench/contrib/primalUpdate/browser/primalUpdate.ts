/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Where the release manifest lives. A stable raw file in the public downloads
 * repository: no server of ours, no query string, no per-user path.
 */
export const PRIMAL_UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/MuhammadTalhaJaved-0303/primal-code-downloads/main/latest.json';

/** Gates the check entirely. See `primalUpdate.contribution.ts` for the schema. */
export const PRIMAL_UPDATE_MODE_SETTING_ID = 'primalCode.update.mode';

/** Command id behind "Primal Code: Check for Updates". */
export const PRIMAL_CHECK_FOR_UPDATES_COMMAND_ID = 'primalCode.checkForUpdates';

/**
 * APPLICATION-scoped key holding the one commit the user asked never to be
 * nagged about again. A single value: skipping a build supersedes the last one.
 */
export const PRIMAL_UPDATE_SKIPPED_COMMIT_STORAGE_KEY = 'primalCode.update.skippedCommit';

/**
 * How long after the workbench has restored the first check waits. The
 * contribution is itself registered at `WorkbenchPhase.Eventually`, so the real
 * distance from a usable window is this plus the 2-5s that phase already adds.
 */
export const PRIMAL_UPDATE_INITIAL_DELAY_MS = 20_000;

/** Re-check cadence while a window stays open. */
export const PRIMAL_UPDATE_INTERVAL_MS = 8 * 60 * 60 * 1000;

/**
 * How stale the last check has to be before a window coming back to focus makes
 * another one.
 *
 * The interval above is a backstop for a window nobody touches. It is not an
 * answer to "a release just went out": an editor left open at ten past nine
 * would not mention it until the evening. Returning to the window is the moment
 * a check is both cheap and wanted - the reader is there, and whatever they
 * were away doing is over - so that is when it looks again.
 *
 * Short enough to feel immediate over a coffee, long enough that alt-tabbing
 * between the editor and a browser does not send a request per switch.
 */
export const PRIMAL_UPDATE_FOCUS_STALENESS_MS = 20 * 60 * 1000;

/**
 * Whether a focus change should send a check.
 *
 * `lastCheckMs` is `undefined` until the first check has run. Focus arrives
 * before the initial delay elapses on almost every launch, and checking then
 * would make that delay meaningless - it exists so that a window opened and
 * closed again never sends a request at all.
 */
export function shouldCheckOnFocus(focused: boolean, lastCheckMs: number | undefined, nowMs: number): boolean {
	if (!focused || lastCheckMs === undefined) {
		return false;
	}

	return nowMs - lastCheckMs >= PRIMAL_UPDATE_FOCUS_STALENESS_MS;
}

/** Hard ceiling on the manifest request; a hung network must not hold a token. */
export const PRIMAL_UPDATE_REQUEST_TIMEOUT_MS = 10_000;

export type PrimalUpdateMode = 'notify' | 'off';

export const PRIMAL_UPDATE_MODES: readonly PrimalUpdateMode[] = ['notify', 'off'];

export const PRIMAL_UPDATE_DEFAULT_MODE: PrimalUpdateMode = 'notify';

/**
 * What asked for a check. The two differ only in how they report: the
 * background timer is silent about every failure, the command never is.
 */
export const enum PrimalUpdateTrigger {

	/** The delayed/periodic timer. Any failure is a silent no-op. */
	Automatic,

	/** The command. Always reports an outcome, success or failure. */
	Explicit
}

export const IPrimalUpdateService = createDecorator<IPrimalUpdateService>('primalUpdateService');

export interface IPrimalUpdateService {

	readonly _serviceBrand: undefined;

	/** `false` when `primalCode.update.mode` is `off`. Read live, never cached. */
	readonly isEnabled: boolean;

	/**
	 * Fetches the manifest and, when a different build exists, notifies.
	 * Never rejects: a background check has nothing to report a failure to.
	 */
	checkForUpdates(trigger: PrimalUpdateTrigger): Promise<void>;
}
