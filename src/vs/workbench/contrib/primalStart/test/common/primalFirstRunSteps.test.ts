/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeFirstRunGuide, FIRST_RUN_STEP_ORDER, FirstRunStepId, FirstRunStepStatus, IFirstRunInputs } from '../../common/primalFirstRunSteps.js';

/** The all-false baseline: a fresh install with nothing detected. */
const NOTHING: IFirstRunInputs = {
	vibeChosen: false,
	claudeLoginDetected: false,
	configuredProviderIds: [],
	started: false,
	detectionSettled: true,
};

function statuses(inputs: IFirstRunInputs): Record<FirstRunStepId, FirstRunStepStatus> {
	const guide = computeFirstRunGuide(inputs);
	const result = {} as Record<FirstRunStepId, FirstRunStepStatus>;
	for (const step of guide.steps) {
		result[step.id] = step.status;
	}
	return result;
}

suite('PrimalFirstRunSteps', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('steps come out in the fixed order vibe, model, start', () => {
		const guide = computeFirstRunGuide(NOTHING);
		assert.deepStrictEqual(guide.steps.map(step => step.id), [FirstRunStepId.Vibe, FirstRunStepId.Model, FirstRunStepId.Start]);
		assert.deepStrictEqual(FIRST_RUN_STEP_ORDER, [FirstRunStepId.Vibe, FirstRunStepId.Model, FirstRunStepId.Start]);
	});

	test('nothing: the vibe step is current, the rest are next, not complete', () => {
		assert.deepStrictEqual(statuses(NOTHING), { vibe: FirstRunStepStatus.Current, model: FirstRunStepStatus.Next, start: FirstRunStepStatus.Next });
		assert.strictEqual(computeFirstRunGuide(NOTHING).complete, false);
	});

	test('a chosen vibe advances the current marker to the model step', () => {
		assert.deepStrictEqual(statuses({ ...NOTHING, vibeChosen: true }), { vibe: FirstRunStepStatus.Done, model: FirstRunStepStatus.Current, start: FirstRunStepStatus.Next });
	});

	test('a done step later in the order does not pull the current marker forward', () => {
		// Keys before a vibe was picked: vibe still current, model already done.
		assert.deepStrictEqual(statuses({ ...NOTHING, configuredProviderIds: ['anthropic'] }), { vibe: FirstRunStepStatus.Current, model: FirstRunStepStatus.Done, start: FirstRunStepStatus.Next });
		// Started before anything else: the first two keep their own states.
		assert.deepStrictEqual(statuses({ ...NOTHING, started: true }), { vibe: FirstRunStepStatus.Current, model: FirstRunStepStatus.Next, start: FirstRunStepStatus.Done });
	});

	test('exactly one step is current until everything is done', () => {
		const flags = [false, true];
		for (const vibeChosen of flags) {
			for (const claudeLoginDetected of flags) {
				for (const hasKeys of flags) {
					for (const started of flags) {
						for (const detectionSettled of flags) {
							const inputs: IFirstRunInputs = { vibeChosen, claudeLoginDetected, configuredProviderIds: hasKeys ? ['openai'] : [], started, detectionSettled };
							const guide = computeFirstRunGuide(inputs);
							const current = guide.steps.filter(step => step.status === FirstRunStepStatus.Current);
							const allDone = guide.steps.every(step => step.status === FirstRunStepStatus.Done);
							assert.strictEqual(current.length, allDone ? 0 : 1, JSON.stringify(inputs));
							assert.strictEqual(guide.complete, allDone, JSON.stringify(inputs));
						}
					}
				}
			}
		}
	});

	test('all three done: complete, no current step', () => {
		const guide = computeFirstRunGuide({ vibeChosen: true, claudeLoginDetected: true, configuredProviderIds: [], started: true, detectionSettled: true });
		assert.strictEqual(guide.complete, true);
		assert.ok(guide.steps.every(step => step.status === FirstRunStepStatus.Done));
	});

	suite('model step', () => {

		test('Claude login detected but no keys: done, source is the login', () => {
			const guide = computeFirstRunGuide({ ...NOTHING, claudeLoginDetected: true });
			assert.strictEqual(statuses({ ...NOTHING, claudeLoginDetected: true }).model, FirstRunStepStatus.Done);
			assert.deepStrictEqual(guide.modelSource, { kind: 'claudeLogin' });
		});

		test('keys but no login: done, source lists the provider ids', () => {
			const guide = computeFirstRunGuide({ ...NOTHING, configuredProviderIds: ['anthropic', 'deepseek'] });
			assert.strictEqual(guide.steps[1].status, FirstRunStepStatus.Done);
			assert.deepStrictEqual(guide.modelSource, { kind: 'keys', providerIds: ['anthropic', 'deepseek'], claudeLogin: false });
		});

		test('keys and a login: done, source lists the keys and remembers the login', () => {
			const guide = computeFirstRunGuide({ ...NOTHING, claudeLoginDetected: true, configuredProviderIds: ['openai'] });
			assert.strictEqual(guide.steps[1].status, FirstRunStepStatus.Done);
			assert.deepStrictEqual(guide.modelSource, { kind: 'keys', providerIds: ['openai'], claudeLogin: true });
		});

		test('nothing detected: not done, source is none', () => {
			const guide = computeFirstRunGuide(NOTHING);
			assert.notStrictEqual(guide.steps[1].status, FirstRunStepStatus.Done);
			assert.deepStrictEqual(guide.modelSource, { kind: 'none' });
		});

		test('provider ids are deduplicated and blanks dropped, order kept', () => {
			const guide = computeFirstRunGuide({ ...NOTHING, configuredProviderIds: ['openai', '', 'anthropic', 'openai', '  '] });
			assert.deepStrictEqual(guide.modelSource, { kind: 'keys', providerIds: ['openai', 'anthropic'], claudeLogin: false });
		});

		test('while detection has not settled and nothing was found, the source is checking and the step is not done', () => {
			const guide = computeFirstRunGuide({ ...NOTHING, detectionSettled: false });
			assert.deepStrictEqual(guide.modelSource, { kind: 'checking' });
			assert.strictEqual(guide.steps[1].status, FirstRunStepStatus.Next);
			assert.strictEqual(computeFirstRunGuide({ ...NOTHING, vibeChosen: true, detectionSettled: false }).steps[1].status, FirstRunStepStatus.Current);
		});

		test('a login or keys found before detection settles count at once', () => {
			assert.deepStrictEqual(computeFirstRunGuide({ ...NOTHING, claudeLoginDetected: true, detectionSettled: false }).modelSource, { kind: 'claudeLogin' });
			assert.deepStrictEqual(computeFirstRunGuide({ ...NOTHING, configuredProviderIds: ['openai'], detectionSettled: false }).modelSource, { kind: 'keys', providerIds: ['openai'], claudeLogin: false });
		});

		test('once settled with nothing found, the source is none, never checking', () => {
			assert.deepStrictEqual(computeFirstRunGuide({ ...NOTHING, detectionSettled: true }).modelSource, { kind: 'none' });
		});

		test('only blank provider ids count as no keys', () => {
			const guide = computeFirstRunGuide({ ...NOTHING, configuredProviderIds: ['', '  '] });
			assert.deepStrictEqual(guide.modelSource, { kind: 'none' });
			assert.strictEqual(guide.steps[1].status, FirstRunStepStatus.Next);
		});
	});

	test('inputs are not mutated', () => {
		const ids = ['openai', 'openai'];
		const inputs: IFirstRunInputs = { ...NOTHING, configuredProviderIds: ids };
		computeFirstRunGuide(inputs);
		assert.deepStrictEqual(ids, ['openai', 'openai']);
		assert.deepStrictEqual(inputs, { ...NOTHING, configuredProviderIds: ['openai', 'openai'] });
	});
});
