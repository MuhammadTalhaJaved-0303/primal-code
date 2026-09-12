/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PRIMAL_MOTIF_FRAME_BUDGET_MS,
	PRIMAL_MOTIF_STATIC_ID,
	PrimalMotifRole,
	getMotifDescriptors
} from '../../browser/primalMotif.js';
import '../../browser/motifs/motifs.js';
import { INK_PALETTE, createTestMotifHost, measureFrameCostMs } from './motifTestHost.js';

/**
 * What a frame of each motif actually costs, against what it says it costs.
 *
 * WHY THE DECLARED FIGURE IS TESTED AND NOT JUST THE BUDGET. The 0.5ms budget is
 * loose enough that a motif could get ten times more expensive and still pass it,
 * and "ten times more expensive" is precisely the change nobody notices in
 * review. So every motif declares the number somebody measured
 * (`IMotifDescriptor.frameCostMs`, and the table in each motif's header), and
 * this re-measures it: a renderer that drifts away from its own declaration
 * fails here long before it threatens the budget.
 *
 * THE BUDGET ITSELF IS ASSERTED WITHOUT SLACK. {@link MEASUREMENT_SLACK} exists
 * only because a wall clock on a busy machine is noisy, and it is applied only to
 * the comparison against the motif's own declaration - never to
 * {@link PRIMAL_MOTIF_FRAME_BUDGET_MS}, which is the promise the layer makes
 * about somebody's frame time and is not negotiable from here.
 *
 * BOTH ROLES ARE MEASURED, and the worse of the two is the one that has to hold:
 * a motif that composes to the frame draws more of it on a stage than in a 35px
 * strip, so the stage is usually - but not always - the expensive role, and
 * guessing which would have been a way to measure the cheap one by accident.
 */
suite('Primal Motif - frame budget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * How far over its declared cost a motif is allowed to measure before this
	 * fails.
	 *
	 * Headroom for a wall clock on a shared machine, and nothing else: the
	 * renderers here are between one and two orders of magnitude under the
	 * budget, so even four times a declaration is still a small fraction of it.
	 * It is not a way to declare a number and then not hold to it - a motif that
	 * needs this much headroom to pass has changed, and the fix is to measure it
	 * again and write down what it now costs.
	 */
	const MEASUREMENT_SLACK = 4;

	/** Timed frames per batch, and batches per role. See `measureFrameCostMs`. */
	const FRAMES_PER_BATCH = 150;
	const BATCHES = 5;

	const ROLES: readonly PrimalMotifRole[] = Object.freeze(['ground', 'stage'] as const);

	const descriptors = getMotifDescriptors();

	for (const descriptor of descriptors) {

		if (descriptor.id === PRIMAL_MOTIF_STATIC_ID) {
			test(`'static' costs nothing per frame because it has no frames`, () => {
				// Not a measurement, because there is nothing to measure: the
				// scheduler recognises `static`, keeps the surface torn down and
				// never starts a loop. Zero is the honest declaration, and this
				// is what stops it being quietly given a non-zero one.
				assert.strictEqual(descriptor.frameCostMs, 0);
			});
			continue;
		}

		test(`'${descriptor.id}' holds the ${descriptor.frameCostMs}ms it declares, in both roles`, function () {
			// Ten batches of a hundred and fifty frames across two roles, plus
			// the warm-up: generous, because a timeout here would look like a
			// budget failure and it must never be one.
			this.timeout(60_000);

			const measured: { role: PrimalMotifRole; cost: number }[] = [];

			for (const role of ROLES) {
				const host = createTestMotifHost(descriptor.kind, role, INK_PALETTE);
				const renderer = descriptor.create();

				try {
					assert.strictEqual(renderer.create(host), true, `'${descriptor.id}' declined a palette that supplies ink`);

					// A maximised window for the ground role and a maximised
					// Start pane for the stage: the sizes these are actually
					// composed for, so the measurement is of the shipping
					// picture and not of a degenerate one.
					renderer.resize(role === 'stage' ? 1428 : 1920, role === 'stage' ? 1025 : 1080);

					measured.push({ role, cost: measureFrameCostMs(renderer, BATCHES, FRAMES_PER_BATCH) });
				} finally {
					renderer.dispose();
					host.release();
				}
			}

			const worst = measured.reduce((most, entry) => entry.cost > most.cost ? entry : most, measured[0]);
			const report = measured.map(entry => `${entry.role} ${entry.cost.toFixed(4)}ms`).join(', ');

			assert.ok(
				worst.cost <= PRIMAL_MOTIF_FRAME_BUDGET_MS,
				`'${descriptor.id}' blew the ${PRIMAL_MOTIF_FRAME_BUDGET_MS}ms frame budget: ${report}`
			);

			assert.ok(
				worst.cost <= descriptor.frameCostMs * MEASUREMENT_SLACK,
				`'${descriptor.id}' declares ${descriptor.frameCostMs}ms but measured ${report}. Measure it again and write down what it now costs.`
			);

			assert.ok(
				descriptor.frameCostMs > 0,
				`'${descriptor.id}' paints every frame, so its declared cost cannot be zero`
			);
		});
	}
});
