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

/** Frames rendered before anything is timed, so the first batch is not measuring the JIT. */
const WARM_UP_FRAMES = 150;

/** The fewest frames a batch may hold, whatever the clock says one costs. */
const MIN_FRAMES_PER_BATCH = 150;

/**
 * The most frames a batch may hold: the ceiling for a renderer so cheap that
 * the calibration batch read as zero ticks. Twenty thousand frames of the
 * cheapest motif here is about a tenth of a second.
 */
const MAX_FRAMES_PER_BATCH = 20_000;

/**
 * The main-thread cost of one `render()` call, in milliseconds.
 *
 * MEASURED IN BATCHES SIZED BY WALL TIME, AND THAT IS NOT A DETAIL. Chromium
 * coarsens `performance.now()` to a tenth of a millisecond in a page that is
 * not cross-origin isolated, and every renderer in this contrib is an order of
 * magnitude cheaper than that - so timing one frame would read either zero or
 * one tick and mean nothing either way. A batch of frames is timed as a block
 * and divided. But a batch of a FIXED number of frames is not enough either:
 * a hundred and fifty frames of the cheapest motif here take under a
 * millisecond, which is eight ticks, and eight ticks quantise to figures that
 * differ by a quarter between two runs of the same code. So the frame count is
 * calibrated so that every batch spans at least `minBatchMs` - two hundred
 * ticks at twenty milliseconds - and the median of several batches is taken
 * so that one descheduled batch cannot decide the answer.
 *
 * The renderer is driven at the scheduler's own ceiling ({@link
 * PRIMAL_MOTIF_MAX_FPS}), with `intensity` at 1: this is what a motif costs
 * while it is moving as fast as it is ever allowed to.
 */
export function measureFrameCostMs(renderer: IMotifRenderer, batches: number, minBatchMs: number): number {
	const delta = 1000 / PRIMAL_MOTIF_MAX_FPS;
	let time = 0;

	const run = (frames: number): number => {
		const started = performance.now();
		for (let frame = 0; frame < frames; frame++) {
			time += delta;
			renderer.render(createTestFrame(time, delta));
		}
		return performance.now() - started;
	};

	run(WARM_UP_FRAMES);

	// A second, timed pass after the warm-up sizes the batches: the warm-up
	// itself would read high and make them too short.
	const calibrationMs = run(MIN_FRAMES_PER_BATCH);
	const framesPerBatch = calibrationMs > 0
		? Math.min(MAX_FRAMES_PER_BATCH, Math.max(MIN_FRAMES_PER_BATCH, Math.ceil(minBatchMs / (calibrationMs / MIN_FRAMES_PER_BATCH))))
		: MAX_FRAMES_PER_BATCH;

	const costs: number[] = [];
	for (let batch = 0; batch < batches; batch++) {
		costs.push(run(framesPerBatch) / framesPerBatch);
	}

	costs.sort((left, right) => left - right);
	return costs[costs.length >> 1];
}

/**
 * The main-thread cost of one `resize()` that actually changes the size, in
 * milliseconds: the median over `resizes` alternations between the two boxes.
 *
 * Alternating, because a renderer that compares the new geometry against the
 * old one and returns early - every one of them does - would measure its own
 * early return if the same size were handed over twice. The two boxes have to
 * differ enough to move every renderer's geometry past its rebuild epsilon;
 * the caller chooses them for the role.
 */
export function measureResizeCostMs(renderer: IMotifRenderer, resizes: number, from: readonly [number, number], to: readonly [number, number]): number {
	const costs: number[] = [];

	renderer.resize(from[0], from[1]);
	for (let index = 0; index < resizes; index++) {
		const [width, height] = index % 2 === 0 ? to : from;
		const started = performance.now();
		renderer.resize(width, height);
		costs.push(performance.now() - started);
	}

	costs.sort((left, right) => left - right);
	return costs[costs.length >> 1];
}
