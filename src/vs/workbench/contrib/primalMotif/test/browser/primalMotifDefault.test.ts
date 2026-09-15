/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PRIMAL_MOTIF_BURST_MS,
	PRIMAL_MOTIF_DEFAULT_ID,
	PRIMAL_MOTIF_DEFAULT_MOTION,
	PRIMAL_MOTIF_HOLD_MS,
	PRIMAL_MOTIF_STATIC_ID,
	getMotifDescriptor,
	settleIntensity,
	toMotifMotion
} from '../../browser/primalMotif.js';
import { PRIMAL_MOTIF_WORLD_ID } from '../../browser/motifs/globe.js';
import '../../browser/motifs/motifs.js';

/**
 * WCAG 2.2.2 (Level A) applies to moving content that starts automatically and
 * lasts more than five seconds. The product ships a motif ON by default, so
 * the criterion is met by the shape of the default - a burst that stops on its
 * own inside that window - rather than by a control the user has to find.
 * Every number that shape rests on is pinned here.
 */
const WCAG_2_2_2_THRESHOLD_MS = 5000;

suite('Primal Motif - default', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the default motif is the world, and it is registered', () => {
		assert.strictEqual(PRIMAL_MOTIF_DEFAULT_ID, PRIMAL_MOTIF_WORLD_ID);
		assert.notStrictEqual(PRIMAL_MOTIF_DEFAULT_ID, PRIMAL_MOTIF_STATIC_ID);
		assert.ok(getMotifDescriptor(PRIMAL_MOTIF_DEFAULT_ID), 'a default nobody registered would resolve to static and never be seen');
	});

	test('the default motion settles, and garbage in the setting settles too', () => {
		assert.strictEqual(PRIMAL_MOTIF_DEFAULT_MOTION, 'settle');
		assert.strictEqual(toMotifMotion(undefined), 'settle');
		assert.strictEqual(toMotifMotion('forever'), 'settle');
	});

	test('a settle burst ends inside the five seconds WCAG 2.2.2 counts from', () => {
		assert.ok(PRIMAL_MOTIF_BURST_MS <= WCAG_2_2_2_THRESHOLD_MS, `the burst is ${PRIMAL_MOTIF_BURST_MS}ms, over the ${WCAG_2_2_2_THRESHOLD_MS}ms threshold`);
		assert.ok(PRIMAL_MOTIF_HOLD_MS < PRIMAL_MOTIF_BURST_MS, 'the hold has to leave room for the ease that ends it');
	});

	test('the settle curve is at rest by the end of the burst, and stays there', () => {
		assert.strictEqual(settleIntensity(PRIMAL_MOTIF_BURST_MS), 0);
		assert.strictEqual(settleIntensity(WCAG_2_2_2_THRESHOLD_MS), 0);
		assert.strictEqual(settleIntensity(Number.MAX_SAFE_INTEGER), 0);
		assert.strictEqual(settleIntensity(PRIMAL_MOTIF_HOLD_MS), 1, 'and it is still moving at the end of the hold');
	});
});
