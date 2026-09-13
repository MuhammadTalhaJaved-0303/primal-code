/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PRIMAL_MOTIF_FRAME_BUDGET_MS,
	PRIMAL_MOTIF_LAYOUT_BUDGET_MS,
	PRIMAL_MOTIF_STATIC_ID,
	PrimalMotifRole,
	getMotifDescriptors
} from '../../browser/primalMotif.js';
import '../../browser/motifs/motifs.js';
import { GLOBE_STAGE_REBUILD_COST_MS, PRIMAL_MOTIF_WORLD_ID } from '../../browser/motifs/globe.js';
import { INK_PALETTE, createTestMotifHost, measureFrameCostMs, measureResizeCostMs } from './motifTestHost.js';

/**
 * What a frame of each motif actually costs, against what it says it costs.
 *
 * WHY THE DECLARED FIGURE IS TESTED AND NOT JUST THE BUDGET. The 0.5ms budget is
 * loose enough that a cheap motif could get ten times more expensive and still
 * pass it, and "ten times more expensive" is precisely the change nobody
 * notices in review. So every motif declares the number somebody measured
 * (`IMotifDescriptor.frameCostMs`, and the table in each motif's header), and
 * this re-measures it: a renderer that drifts past twice its own declaration
 * fails here. For the four motifs that declare a tenth of the budget or less
 * that is long before the budget is threatened; for `world`, which declares
 * most of it, the budget assertion below is the binding one and the drift
 * assertion is only there to keep the declaration honest.
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
	 * Headroom for a wall clock on a shared machine, and nothing else. With the
	 * batches sized by wall time (`measureFrameCostMs`) the median of five
	 * batches repeats to within a few percent, so twice the declaration is
	 * already generous; the four times it used to be let a declaration that
	 * was half the truth pass for every motif in the folder, and the guard
	 * existed for exactly that change. It is not a way to declare a number and
	 * then not hold to it - a motif that needs this much headroom to pass has
	 * changed, and the fix is to measure it again and write down what it now
	 * costs.
	 *
	 * There is deliberately no lower bound. A faster machine would trip one
	 * with a correct declaration, and an inflated declaration is caught the
	 * other way round: by the header table that has to explain it.
	 */
	const MEASUREMENT_SLACK = 2;

	/** Batches per role, and the least wall time each may span. See `measureFrameCostMs`. */
	const BATCHES = 5;
	const MIN_BATCH_MS = 20;

	const ROLES: readonly PrimalMotifRole[] = Object.freeze(['ground', 'stage'] as const);

	/**
	 * A maximised window for the ground role and a maximised Start pane for the
	 * stage: the sizes these are actually composed for, so the measurement is
	 * of the shipping picture and not of a degenerate one.
	 */
	const SIZE_OF: Readonly<Record<PrimalMotifRole, readonly [number, number]>> = Object.freeze({
		ground: [1920, 1080] as const,
		stage: [1428, 1025] as const
	});

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
			// Ten batches of at least twenty milliseconds across two roles, plus
			// the warm-up and calibration: generous, because a timeout here would
			// look like a budget failure and it must never be one.
			this.timeout(60_000);

			const measured: { role: PrimalMotifRole; cost: number }[] = [];

			for (const role of ROLES) {
				const host = createTestMotifHost(descriptor.kind, role, INK_PALETTE);
				const renderer = descriptor.create();

				try {
					assert.strictEqual(renderer.create(host), true, `'${descriptor.id}' declined a palette that supplies ink`);
					renderer.resize(SIZE_OF[role][0], SIZE_OF[role][1]);
					measured.push({ role, cost: measureFrameCostMs(renderer, BATCHES, MIN_BATCH_MS) });
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

/**
 * What a resize of each motif costs, against the layout budget.
 *
 * The frame budget's strike counter brackets `render()` and nothing else, so
 * the one expensive thing a renderer does outside a frame - rebuilding its
 * tables from `resize()` - was the one thing nothing measured. `world` at the
 * stage rebuilds seventy thousand pixels of geometry, and it used to cost six
 * milliseconds per three pixels of sash drag: over the layout budget on the
 * very first resize, and invisible to every other test in this folder.
 *
 * THE SIZES ALTERNATE BETWEEN TWO BOXES THAT DIFFER ENOUGH TO REBUILD. Every
 * renderer here compares the new geometry with the old and returns early when
 * nothing moved, and the globe additionally holds its stage radius to ten-pixel
 * steps; a measurement that handed the same size over twice, or moved it by a
 * pixel, would be measuring those early returns.
 */
suite('Primal Motif - layout budget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** The same headroom as the frame suite, for the same reason and no other. */
	const MEASUREMENT_SLACK = 2;

	/** Resizes per role. Each is a real rebuild, so this is not a batch count. */
	const RESIZES = 21;

	/**
	 * A maximised Start pane and one 125px shorter, for the stage; a maximised
	 * window and one 220px narrower, for the ground. Both pairs move the globe's
	 * radius by well over its rebuild epsilon in the axis its role clamps on.
	 */
	const BOXES_OF: Readonly<Record<PrimalMotifRole, readonly [readonly [number, number], readonly [number, number]]>> = Object.freeze({
		ground: [[1920, 1080], [1700, 1080]] as const,
		stage: [[1428, 1025], [1428, 900]] as const
	});

	const ROLES: readonly PrimalMotifRole[] = Object.freeze(['ground', 'stage'] as const);

	for (const descriptor of getMotifDescriptors()) {

		if (descriptor.id === PRIMAL_MOTIF_STATIC_ID) {
			continue; // never given a surface, so never resized
		}

		test(`'${descriptor.id}' rebuilds for a new size inside the ${PRIMAL_MOTIF_LAYOUT_BUDGET_MS}ms layout budget, in both roles`, function () {
			this.timeout(60_000);

			const measured: { role: PrimalMotifRole; cost: number }[] = [];

			for (const role of ROLES) {
				const host = createTestMotifHost(descriptor.kind, role, INK_PALETTE);
				const renderer = descriptor.create();

				try {
					assert.strictEqual(renderer.create(host), true, `'${descriptor.id}' declined a palette that supplies ink`);
					const [from, to] = BOXES_OF[role];
					measured.push({ role, cost: measureResizeCostMs(renderer, RESIZES, from, to) });
				} finally {
					renderer.dispose();
					host.release();
				}
			}

			const worst = measured.reduce((most, entry) => entry.cost > most.cost ? entry : most, measured[0]);
			const report = measured.map(entry => `${entry.role} ${entry.cost.toFixed(2)}ms`).join(', ');

			assert.ok(
				worst.cost <= PRIMAL_MOTIF_LAYOUT_BUDGET_MS,
				`'${descriptor.id}' blew the ${PRIMAL_MOTIF_LAYOUT_BUDGET_MS}ms layout budget: ${report}`
			);

			if (descriptor.id === PRIMAL_MOTIF_WORLD_ID) {
				// The one renderer whose rebuild is a real cost declares it, and
				// the declaration is held the way a frame cost is: measured
				// again, and allowed the clock's headroom and no more.
				assert.ok(
					worst.cost <= GLOBE_STAGE_REBUILD_COST_MS * MEASUREMENT_SLACK,
					`'world' declares a ${GLOBE_STAGE_REBUILD_COST_MS}ms stage rebuild but measured ${report}. Measure it again and write down what it now costs.`
				);
			}
		});
	}
});
