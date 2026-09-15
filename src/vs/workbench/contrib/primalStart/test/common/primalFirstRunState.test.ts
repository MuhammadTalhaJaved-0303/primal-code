/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFirstRunState, INITIAL_FIRST_RUN_STATE, parseFirstRunState, PRIMAL_FIRST_RUN_STORAGE_KEY, serializeFirstRunState, withFirstRunState } from '../../common/primalFirstRunState.js';

suite('PrimalFirstRunState', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the storage key is namespaced under primalCode', () => {
		assert.ok(PRIMAL_FIRST_RUN_STORAGE_KEY.startsWith('primalCode.firstRun.'));
	});

	test('the initial state has nothing done and nothing shown', () => {
		assert.deepStrictEqual(INITIAL_FIRST_RUN_STATE, { vibeChosen: false, started: false, complete: false, completeNoticeShown: false });
	});

	test('missing, empty, malformed and non-object payloads parse to the initial state', () => {
		for (const raw of [undefined, '', '   ', '{', 'null', '42', '"text"', '[]']) {
			assert.deepStrictEqual(parseFirstRunState(raw), INITIAL_FIRST_RUN_STATE, JSON.stringify(raw));
		}
	});

	test('round-trips through serialize and parse', () => {
		const state: IFirstRunState = { vibeChosen: true, started: false, complete: true, completeNoticeShown: true };
		assert.deepStrictEqual(parseFirstRunState(serializeFirstRunState(state)), state);
	});

	test('each field is validated on its own; a non-boolean falls back to its default', () => {
		const parsed = parseFirstRunState(JSON.stringify({ vibeChosen: 'yes', started: true, complete: 1, completeNoticeShown: null }));
		assert.deepStrictEqual(parsed, { vibeChosen: false, started: true, complete: false, completeNoticeShown: false });
	});

	test('unknown fields are ignored', () => {
		const parsed = parseFirstRunState(JSON.stringify({ started: true, somethingElse: true }));
		assert.deepStrictEqual(parsed, { ...INITIAL_FIRST_RUN_STATE, started: true });
	});

	test('withFirstRunState returns a new object and leaves the original alone', () => {
		const original = INITIAL_FIRST_RUN_STATE;
		const updated = withFirstRunState(original, { vibeChosen: true });
		assert.notStrictEqual(updated, original);
		assert.deepStrictEqual(original, { vibeChosen: false, started: false, complete: false, completeNoticeShown: false });
		assert.deepStrictEqual(updated, { vibeChosen: true, started: false, complete: false, completeNoticeShown: false });
	});
});
