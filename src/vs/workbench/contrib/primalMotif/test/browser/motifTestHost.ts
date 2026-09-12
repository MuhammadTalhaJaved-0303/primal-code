/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import {
	IMotifFrame,
	IMotifHost,
	IMotifPalette,
	IMotifRenderer,
	PRIMAL_MOTIF_BUFFER_HEIGHT,
	PRIMAL_MOTIF_BUFFER_WIDTH,
	PRIMAL_MOTIF_MAX_FPS,
	PrimalMotifKind,
	PrimalMotifRole,
	isMotifCanvas
} from '../../browser/primalMotif.js';

/**
 * Primal Code - what a motif has to be handed before it can be tested at all.
 *
 * Not a `.test.ts` file, so the runner's `**\/test\/**\/*.test.js` glob does not
 * pick it up as a suite of its own; it is imported by the suites that need it.
 *
 * There is no mock renderer here and no fake canvas. Every motif in this contrib
 * paints into a real 2D context and reads a real palette, so the only honest way
 * to ask one whether it can paint - or what a frame of it costs - is to hand it
 * the same things the scheduler does. `MotifSurface` builds a `<canvas>` at a
 * fixed 640x360 and a `<div>` for the `css` kind; so does this.
 */

/** A palette that supplies ink, in the shape `readPalette` in the scheduler produces. */
export const INK_PALETTE: IMotifPalette = Object.freeze({
	ground: '#101010',
	ink: '#e8e4de',
	dim: '#8a8a8a',
	accent: '#7fb4e8',
	dark: true
});

/** The same, for a light theme, so `palette.dark` is exercised in both positions. */
export const LIGHT_INK_PALETTE: IMotifPalette = Object.freeze({
	ground: '#fbfaf8',
	ink: '#20201d',
	dim: '#6a6a6a',
	accent: '#1f6fb2',
	dark: false
});

/**
 * The regression palette: `focusBorder` is the ONLY token that parses.
 *
 * Every motif that paints has to decline this one. See `motifs/motifPaint.ts`
 * for why the accent is not an ink, and `motifRegistry.test.ts` for the test
 * that holds every registered motif to it.
 */
export const ACCENT_ONLY_PALETTE: IMotifPalette = Object.freeze({
	ground: '',
	ink: '',
	dim: '',
	accent: '#7fb4e8',
	dark: true
});

/** Ink tokens that are present but malformed, which is not the same as absent. */
export const UNPARSEABLE_INK_PALETTE: IMotifPalette = Object.freeze({
	ground: 'not-a-colour',
	ink: 'not-a-colour',
	dim: 'also-not-a-colour',
	accent: '#ff0000',
	dark: true
});

/** What a motif was told, so a test can assert that `fail` was never called. */
export interface ITestMotifHost extends IMotifHost {
	readonly failures: readonly string[];
	/** Releases the backing store, exactly as `MotifSurface.dispose` does. */
	release(): void;
}

/**
 * A host of the kind the scheduler builds: a real element in this window, the
 * fixed buffer, and a palette.
 */
export function createTestMotifHost(kind: PrimalMotifKind, role: PrimalMotifRole, palette: IMotifPalette = INK_PALETTE): ITestMotifHost {
	const failures: string[] = [];
	const element: HTMLElement = kind === 'css'
		? mainWindow.document.createElement('div')
		: mainWindow.document.createElement('canvas');

	if (isMotifCanvas(element)) {
		// The same fixed backing store `MotifSurface` gives a real surface. A
		// motif that sized itself off the element would be measured wrong here.
		element.width = PRIMAL_MOTIF_BUFFER_WIDTH;
		element.height = PRIMAL_MOTIF_BUFFER_HEIGHT;
	}

	return {
		element,
		role,
		bufferWidth: PRIMAL_MOTIF_BUFFER_WIDTH,
		bufferHeight: PRIMAL_MOTIF_BUFFER_HEIGHT,
		palette,
		failures,
		fail: (reason: string) => {
			failures.push(reason);
		},
		release: () => {
			if (isMotifCanvas(element)) {
				element.width = 0;
				element.height = 0;
			}
			element.remove();
		}
	};
}

/** One frame of the kind the scheduler hands over at the full frame rate. */
export function createTestFrame(time: number, delta: number): IMotifFrame {
	return { time, delta, intensity: 1, resting: false };
}

/**
 * The main-thread cost of one `render()` call, in milliseconds.
 *
 * MEASURED IN BATCHES, AND THAT IS NOT A DETAIL. Chromium coarsens
 * `performance.now()` to about a tenth of a millisecond in a page that is not
 * cross-origin isolated, and every renderer in this contrib is an order of
 * magnitude cheaper than that - so timing one frame would read either zero or
 * one tick and mean nothing either way. A batch of frames is timed as a block
 * and divided, which puts the interval being measured several hundred ticks
 * above the clock's resolution, and the median of several batches is taken so
 * that one descheduled batch cannot decide the answer.
 *
 * The renderer is driven at the scheduler's own ceiling ({@link
 * PRIMAL_MOTIF_MAX_FPS}), with `intensity` at 1: this is what a motif costs
 * while it is moving as fast as it is ever allowed to.
 */
export function measureFrameCostMs(renderer: IMotifRenderer, batches: number, framesPerBatch: number): number {
	const delta = 1000 / PRIMAL_MOTIF_MAX_FPS;
	const costs: number[] = [];
	let time = 0;

	// Warm the code paths and let the tables settle before anything is timed, so
	// the first batch is not measuring the JIT.
	for (let frame = 0; frame < framesPerBatch; frame++) {
		time += delta;
		renderer.render(createTestFrame(time, delta));
	}

	for (let batch = 0; batch < batches; batch++) {
		const started = performance.now();
		for (let frame = 0; frame < framesPerBatch; frame++) {
			time += delta;
			renderer.render(createTestFrame(time, delta));
		}
		costs.push((performance.now() - started) / framesPerBatch);
	}

	costs.sort((left, right) => left - right);
	return costs[costs.length >> 1];
}
