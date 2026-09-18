/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_UPDATE_FOCUS_STALENESS_MS, PRIMAL_UPDATE_INTERVAL_MS, shouldCheckOnFocus } from '../../browser/primalUpdate.js';

suite('Primal Update - when to look', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A window that is left open all day only looked every eight hours, so a
	 * release published at ten past nine could go unmentioned until the evening.
	 * Coming back to the editor is the moment a check is both cheap and wanted:
	 * the reader is there, and whatever they were away doing is over.
	 */
	test('a window coming back to focus looks again once its last look is stale', () => {
		const now = 10 * PRIMAL_UPDATE_INTERVAL_MS;

		assert.deepStrictEqual({
			stale: shouldCheckOnFocus(true, now - PRIMAL_UPDATE_FOCUS_STALENESS_MS - 1, now),
			exactlyStale: shouldCheckOnFocus(true, now - PRIMAL_UPDATE_FOCUS_STALENESS_MS, now),
			fresh: shouldCheckOnFocus(true, now - 1000, now),
		}, {
			stale: true,
			exactlyStale: true,
			fresh: false,
		});
	});

	test('losing focus never triggers a check, however long ago the last one was', () => {
		assert.strictEqual(shouldCheckOnFocus(false, 0, 10 * PRIMAL_UPDATE_INTERVAL_MS), false);
	});

	test('a window that has never checked leaves the first check to the startup timer', () => {
		// Focus arrives before the initial delay elapses on almost every launch.
		// Checking here would make that delay meaningless, and the delay exists so
		// that a window opened and closed again never sends a request at all.
		assert.strictEqual(shouldCheckOnFocus(true, undefined, 10 * PRIMAL_UPDATE_INTERVAL_MS), false);
	});

	test('the staleness window is shorter than the background interval, or it would never apply', () => {
		assert.ok(
			PRIMAL_UPDATE_FOCUS_STALENESS_MS < PRIMAL_UPDATE_INTERVAL_MS,
			`focus staleness ${PRIMAL_UPDATE_FOCUS_STALENESS_MS}ms must be under the ${PRIMAL_UPDATE_INTERVAL_MS}ms interval`
		);
	});
});
