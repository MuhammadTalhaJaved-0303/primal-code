/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_MOTIF_BUFFER_HEIGHT, PRIMAL_MOTIF_BUFFER_WIDTH, PrimalMotifRole, getMotifDescriptor } from '../../browser/primalMotif.js';
import { PRIMAL_MOTIF_WORLD_ID } from '../../browser/motifs/globe.js';
import { INK_PALETTE, createTestFrame, createTestMotifHost } from './motifTestHost.js';

// The shipping set, imported the way the workbench imports it.
import '../../browser/motifs/motifs.js';

/** A window, and the pane a stage actually gets on the Start page. */
const SIZE_OF: Record<PrimalMotifRole, readonly [number, number]> = {
	ground: [1440, 900],
	stage: [900, 708],
};

/**
 * The strongest corner of the ambient wash. `globeGround.ts` pools it at 18%/6%
 * of the buffer, and both roles put the globe itself in the opposite corner, so
 * whatever is here is ground and not planet.
 */
const SAMPLE_X = Math.round(PRIMAL_MOTIF_BUFFER_WIDTH * 0.18);
const SAMPLE_Y = Math.round(PRIMAL_MOTIF_BUFFER_HEIGHT * 0.06);
const SAMPLE_SIZE = 24;

function peakAlphaAwayFromTheGlobe(role: PrimalMotifRole): number {
	const host = createTestMotifHost('canvas2d', role, INK_PALETTE);
	const renderer = getMotifDescriptor(PRIMAL_MOTIF_WORLD_ID)!.create();

	try {
		assert.strictEqual(renderer.create(host), true, 'the globe declined a palette that supplies ink');
		renderer.resize(SIZE_OF[role][0], SIZE_OF[role][1]);
		renderer.render(createTestFrame(0, 16));

		const canvas = host.element as HTMLCanvasElement;
		const data = canvas.getContext('2d')!.getImageData(SAMPLE_X, SAMPLE_Y, SAMPLE_SIZE, SAMPLE_SIZE).data;
		let peak = 0;
		for (let i = 3; i < data.length; i += 4) {
			peak = Math.max(peak, data[i]);
		}
		return peak;
	} finally {
		renderer.dispose();
		host.release();
	}
}

suite('Primal Motif - globe ground', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * The globe reproduces the wallpaper's ambient wash as alpha bytes, because
	 * in the GROUND role the stylesheet drops the wallpaper's own gradient and
	 * the motif owes the ground what that wash was giving it.
	 *
	 * On a STAGE it owes nothing. `primalMotif.css` keeps the wallpaper's wash
	 * under a staged surface on purpose - its own comment says dropping it there
	 * "would not avoid a double gradient" - so a stage that paints the wash again
	 * lays a second copy of the same pools inside the pane. That is what the
	 * owner saw as a shadow behind the cards on Primal Start: a large soft grey
	 * cloud with opaque cards sitting on it.
	 */
	test('paints the ambient wash as ground, and never a second copy on a stage', () => {
		assert.deepStrictEqual({
			ground: peakAlphaAwayFromTheGlobe('ground') > 0,
			stage: peakAlphaAwayFromTheGlobe('stage') > 0,
		}, {
			ground: true,
			stage: false,
		});
	});
});
