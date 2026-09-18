/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_MOTIF_DEFAULT_MOTION, defaultMotionFor, resolveMotifMotion } from '../../browser/primalMotif.js';

suite('Primal Motif - motion on a stage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A stage is a pane that shows no code - Primal Start, the Agents window's
	 * landing - and the picture is the whole point of it. Behind the editor the
	 * motif settles so nothing moves next to code; on a stage it keeps moving.
	 * WCAG 2.2.2 is met there by the pause control every stage host carries,
	 * not by the motion stopping on its own.
	 */
	test('the default motion is perpetual on a stage and settles everywhere else', () => {
		assert.deepStrictEqual({
			stage: defaultMotionFor(true),
			ground: defaultMotionFor(false),
			settingDefault: PRIMAL_MOTIF_DEFAULT_MOTION,
		}, {
			stage: 'perpetual',
			ground: 'settle',
			settingDefault: 'settle',
		});
	});

	test('a motion the user chose wins on a stage too, including choosing to settle', () => {
		assert.deepStrictEqual({
			chosenSettleOnStage: resolveMotifMotion('settle', true),
			chosenOffOnStage: resolveMotifMotion('off', true),
			chosenPerpetualOnGround: resolveMotifMotion('perpetual', false),
		}, {
			chosenSettleOnStage: 'settle',
			chosenOffOnStage: 'off',
			chosenPerpetualOnGround: 'perpetual',
		});
	});

	test('no choice means the role decides, and garbage counts as no choice', () => {
		assert.deepStrictEqual({
			unsetOnStage: resolveMotifMotion(undefined, true),
			unsetOnGround: resolveMotifMotion(undefined, false),
			garbageOnStage: resolveMotifMotion('forever', true),
			garbageOnGround: resolveMotifMotion(42, false),
		}, {
			unsetOnStage: 'perpetual',
			unsetOnGround: 'settle',
			garbageOnStage: 'perpetual',
			garbageOnGround: 'settle',
		});
	});
});
