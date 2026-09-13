/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PRIMAL_MOTIF_BATTERY_FPS,
	PRIMAL_MOTIF_INPUT_QUIET_MS,
	PRIMAL_MOTIF_MAX_FPS,
	PRIMAL_MOTIF_STATIC_ID
} from '../../browser/primalMotif.js';
import { IMotifLadderInputs, SPEED_LIMIT_NOMINAL, motifBudgetKey, resolveMotifPlan } from '../../browser/primalMotifLadder.js';

/**
 * The degradation ladder is the whole power guarantee of the motif layer, it is
 * a pure function of an explicit set of readings, and every rung of it is a
 * promise the product makes about somebody's battery, their fan or their typing
 * latency. It is therefore the one part of this contrib where a regression
 * would be both invisible on screen and expensive in the field.
 *
 * Each rung gets a test that reaches it from the fully permissive baseline by
 * changing exactly one reading, plus a test that it still wins when a less
 * restrictive rung below it also matches - because "most restrictive first" is
 * an ordering claim, and an ordering claim is only tested by a conflict.
 */
suite('Primal Motif - degradation ladder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Everything permissive: this is the one set of readings that runs. */
	const running: IMotifLadderInputs = Object.freeze({
		motifId: 'world',
		motifAllowsPerpetual: true,
		motifMissing: false,
		motifRefused: false,
		unavailable: false,
		highContrast: false,
		motion: 'settle',
		reducedMotion: false,
		paused: false,
		focused: true,
		thermal: 'nominal',
		speedLimit: SPEED_LIMIT_NOMINAL,
		power: 'mains',
		perpetualOnBattery: false,
		quietForMs: 10_000,
		overBudget: false
	});

	const plan = (overrides: Partial<IMotifLadderInputs>) => resolveMotifPlan({ ...running, ...overrides });

	test('the permissive baseline runs at the full ceiling', () => {
		const result = plan({});
		assert.strictEqual(result.mode, 'run');
		assert.strictEqual(result.state, 'moving');
		assert.strictEqual(result.fps, PRIMAL_MOTIF_MAX_FPS);
		assert.strictEqual(result.reason, undefined);
		assert.strictEqual(result.perpetual, false);
	});

	// --- rung 1: a lost graphics context, terminal ---------------------------

	test('unavailable is off, and reports itself', () => {
		const result = plan({ unavailable: true });
		assert.strictEqual(result.mode, 'off');
		assert.strictEqual(result.state, 'unavailable');
		assert.strictEqual(result.fps, 0);
		assert.ok(result.reason);
	});

	test('unavailable outranks every other rung', () => {
		// Reachable in practice: a context is lost in a window that is also
		// blurred, on battery and in high contrast. The terminal answer wins.
		const result = plan({ unavailable: true, highContrast: true, focused: false, power: 'battery', paused: true });
		assert.strictEqual(result.state, 'unavailable');
	});

	// --- rung 2: nothing to paint --------------------------------------------

	test('the static motif is off, with nothing to explain', () => {
		const result = plan({ motifId: PRIMAL_MOTIF_STATIC_ID });
		assert.strictEqual(result.mode, 'off');
		assert.strictEqual(result.state, 'static');
		assert.strictEqual(result.reason, undefined, 'the default configuration must not put a sentence in the status bar');
	});

	test('a motif nobody registered is off', () => {
		const result = plan({ motifMissing: true, motifId: 'no-such-motif' });
		assert.strictEqual(result.mode, 'off');
		assert.strictEqual(result.state, 'static');
		assert.strictEqual(result.reason, undefined);
	});

	// --- rung 3: this motif declined under this palette ----------------------

	test('a refused motif is off, and names itself in the reason', () => {
		const result = plan({ motifRefused: true });
		assert.strictEqual(result.mode, 'off');
		assert.strictEqual(result.state, 'static');
		assert.ok(result.reason?.includes('world'), 'the recovery is to change the motif or the theme, so the reason has to say which motif');
	});

	// --- rung 4: high contrast ------------------------------------------------

	test('high contrast opts out entirely', () => {
		const result = plan({ highContrast: true });
		assert.strictEqual(result.mode, 'off');
		assert.strictEqual(result.state, 'static');
		assert.ok(result.reason);
	});

	test('high contrast outranks reduced motion, which would only rest', () => {
		const result = plan({ highContrast: true, reducedMotion: true });
		assert.strictEqual(result.mode, 'off', 'off tears the surface down; rest would keep a canvas alive in a window that opted out');
	});

	// --- rung 5: motion off ---------------------------------------------------

	test('motion off is off, with nothing to explain', () => {
		const result = plan({ motion: 'off' });
		assert.strictEqual(result.mode, 'off');
		assert.strictEqual(result.state, 'static');
		assert.strictEqual(result.reason, undefined, 'the user asked for this; it is not a degradation to report');
	});

	// --- rung 6: reduced motion ----------------------------------------------

	test('reduced motion rests on one painted frame rather than going dark', () => {
		const result = plan({ reducedMotion: true });
		assert.strictEqual(result.mode, 'rest', 'the art is still there; only the loop is gone');
		assert.strictEqual(result.state, 'static');
		assert.strictEqual(result.fps, 0);
		assert.strictEqual(result.perpetual, false, 'there is nothing to resume, so nothing may report itself as perpetual');
		assert.ok(result.reason);
	});

	test('reduced motion outranks the pause', () => {
		const result = plan({ reducedMotion: true, paused: true });
		assert.strictEqual(result.state, 'static', 'a permanently static ladder has no pause to be in');
	});

	// --- rung 7: the pause ----------------------------------------------------

	test('paused rests, in every motion mode', () => {
		for (const motion of ['settle', 'perpetual'] as const) {
			const result = plan({ paused: true, motion });
			assert.strictEqual(result.mode, 'rest', `paused must actually pause in '${motion}'`);
			assert.strictEqual(result.state, 'paused');
			assert.strictEqual(result.fps, 0);
			assert.ok(result.reason);
		}
	});

	test('paused still reports honestly what resuming would give back', () => {
		assert.strictEqual(plan({ paused: true, motion: 'perpetual' }).perpetual, true);
		assert.strictEqual(plan({ paused: true, motion: 'settle' }).perpetual, false);
		assert.strictEqual(
			plan({ paused: true, motion: 'perpetual', motifAllowsPerpetual: false }).perpetual, false,
			'a motif that declines perpetual motion cannot be resumed into it'
		);
	});

	test('paused outranks blur, heat, battery and typing', () => {
		const result = plan({ paused: true, focused: false, thermal: 'critical', power: 'battery', quietForMs: 0 });
		assert.strictEqual(result.state, 'paused', 'the state the user chose is the one the status bar has to show');
	});

	// --- rung 8: blur ---------------------------------------------------------

	test('an unfocused window parks', () => {
		const result = plan({ focused: false });
		assert.strictEqual(result.mode, 'rest');
		assert.strictEqual(result.state, 'parked');
		assert.strictEqual(result.fps, 0);
		assert.ok(result.reason);
	});

	// --- rung 9: heat ---------------------------------------------------------

	test('serious and critical heat park; nominal, fair and unknown do not', () => {
		for (const thermal of ['serious', 'critical'] as const) {
			assert.strictEqual(plan({ thermal }).state, 'parked', `'${thermal}' must park`);
		}
		for (const thermal of ['nominal', 'fair', 'unknown'] as const) {
			assert.strictEqual(plan({ thermal }).mode, 'run', `'${thermal}' is not a reason to stop`);
		}
	});

	// --- rung 10: the speed limit --------------------------------------------

	test('any reported throttling parks, and the nominal limit does not', () => {
		assert.strictEqual(plan({ speedLimit: SPEED_LIMIT_NOMINAL - 1 }).state, 'parked');
		assert.strictEqual(plan({ speedLimit: 0 }).state, 'parked');
		assert.strictEqual(plan({ speedLimit: SPEED_LIMIT_NOMINAL }).mode, 'run');
	});

	// --- rung 11: battery -----------------------------------------------------

	test('battery parks unless it was explicitly opted into', () => {
		const parked = plan({ power: 'battery' });
		assert.strictEqual(parked.mode, 'rest');
		assert.strictEqual(parked.state, 'parked');
		assert.ok(parked.reason?.includes(String(PRIMAL_MOTIF_BATTERY_FPS)), 'the reason has to name the rate the opt-in would give');

		const allowed = plan({ power: 'battery', perpetualOnBattery: true });
		assert.strictEqual(allowed.mode, 'run');
		assert.strictEqual(allowed.fps, PRIMAL_MOTIF_BATTERY_FPS, 'the opt-in buys the battery ceiling, never the mains one');
	});

	test('an unknown power source counts as battery, and says so differently', () => {
		const unknown = plan({ power: 'unknown' });
		assert.strictEqual(unknown.state, 'parked', 'no signal is never read as good news');
		assert.notStrictEqual(unknown.reason, plan({ power: 'battery' }).reason, 'the two are different facts and must not be reported as the same one');

		assert.strictEqual(plan({ power: 'unknown', perpetualOnBattery: true }).fps, PRIMAL_MOTIF_BATTERY_FPS);
	});

	// --- rung 12: typing ------------------------------------------------------

	test('typing suppresses motion until the quiet window has passed', () => {
		assert.strictEqual(plan({ quietForMs: 0 }).state, 'parked');
		assert.strictEqual(plan({ quietForMs: PRIMAL_MOTIF_INPUT_QUIET_MS - 1 }).state, 'parked');
		assert.strictEqual(plan({ quietForMs: PRIMAL_MOTIF_INPUT_QUIET_MS }).mode, 'run', 'the gate is exclusive: at the boundary, motion is allowed again');
	});

	// --- the self-imposed rung: the budget guard -----------------------------

	test('a renderer that blew the budget gets half the frames, never the benefit of the doubt', () => {
		assert.strictEqual(plan({ overBudget: true }).fps, PRIMAL_MOTIF_BATTERY_FPS);
		assert.strictEqual(
			plan({ overBudget: true, power: 'battery', perpetualOnBattery: true }).fps, PRIMAL_MOTIF_BATTERY_FPS,
			'the guard is a minimum against the ceiling, so it can only ever lower the rate'
		);
	});

	test('the budget guard is the one running rung that still explains itself', () => {
		// The status bar shows a frame rate, and 15 rather than 30 with nothing
		// behind it is a number the reader cannot act on. Every other running
		// answer has no reason because there is nothing to explain.
		const throttled = plan({ overBudget: true });
		assert.strictEqual(throttled.mode, 'run');
		assert.ok(throttled.reason, 'a halved rate owes the status bar a sentence');
		assert.ok(throttled.reason.includes(running.motifId), 'and the sentence names the motif that earned it');
		assert.strictEqual(plan({}).reason, undefined);
	});

	test('a budget strike is keyed to the motif and the role that earned it', () => {
		// The scheduler records strikes under this key and consults it against
		// the motif and roles mounted now, so a strike by `world` on a stage is
		// not paid by `horizon`, nor by `world` back in the strip. Two motifs, two
		// roles, four keys.
		const keys = new Set([
			motifBudgetKey('world', 'stage'),
			motifBudgetKey('world', 'ground'),
			motifBudgetKey('horizon', 'stage'),
			motifBudgetKey('horizon', 'ground')
		]);
		assert.strictEqual(keys.size, 4, 'a key that collapsed either axis would throttle the wrong thing');
		assert.strictEqual(motifBudgetKey('world', 'stage'), motifBudgetKey('world', 'stage'), 'and the same pair is the same key');
	});

	// --- perpetual is a per-motif opt-in, not a global switch ----------------

	test('perpetual motion needs both the setting and the motif to agree', () => {
		assert.strictEqual(plan({ motion: 'perpetual' }).perpetual, true);
		assert.strictEqual(plan({ motion: 'perpetual', motifAllowsPerpetual: false }).perpetual, false);
		assert.strictEqual(plan({ motion: 'settle', motifAllowsPerpetual: true }).perpetual, false);
	});

	test('a parked burst still reports whether it was a perpetual one', () => {
		// The status bar has to be able to say what resuming would give back, and
		// the parking rungs are the ones a user watches it from.
		assert.strictEqual(plan({ motion: 'perpetual', focused: false }).perpetual, true);
		assert.strictEqual(plan({ motion: 'perpetual', thermal: 'critical' }).perpetual, true);
		assert.strictEqual(plan({ motion: 'perpetual', power: 'battery' }).perpetual, true);
		assert.strictEqual(plan({ motion: 'perpetual', quietForMs: 0 }).perpetual, true);
	});

	// --- the shape of the whole answer ---------------------------------------

	test('every rung that is not run schedules nothing at all', () => {
		const stopped: readonly Partial<IMotifLadderInputs>[] = [
			{ unavailable: true },
			{ motifId: PRIMAL_MOTIF_STATIC_ID },
			{ motifMissing: true },
			{ motifRefused: true },
			{ highContrast: true },
			{ motion: 'off' },
			{ reducedMotion: true },
			{ paused: true },
			{ focused: false },
			{ thermal: 'serious' },
			{ thermal: 'critical' },
			{ speedLimit: 1 },
			{ power: 'battery' },
			{ power: 'unknown' },
			{ quietForMs: 0 }
		];

		for (const overrides of stopped) {
			const result = plan(overrides);
			assert.notStrictEqual(result.mode, 'run', `${JSON.stringify(overrides)} must not run`);
			assert.strictEqual(result.fps, 0, `${JSON.stringify(overrides)} must schedule nothing`);
		}
	});
});
