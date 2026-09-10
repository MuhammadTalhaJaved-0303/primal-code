/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMotifPalette, PRIMAL_MOTIF_BUFFER_HEIGHT, PRIMAL_MOTIF_BUFFER_WIDTH } from '../../browser/primalMotif.js';
import { computeGlobePlacement, readGlobeInk } from '../../browser/motifs/globe.js';

/**
 * The globe's composition, and its one colour rule.
 *
 * Both are pure arithmetic over an explicit set of numbers, and both decide
 * something that a screenshot can only show one instance of: whether the picture
 * is a globe or a smudge, whether it is a circle or an ellipse, and whether it
 * introduces a hue that some readers cannot see. Those are exactly the questions
 * worth pinning down here rather than in the running product.
 */
suite('Primal Motif - globe placement', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const BUFFER_WIDTH = PRIMAL_MOTIF_BUFFER_WIDTH;
	const BUFFER_HEIGHT = PRIMAL_MOTIF_BUFFER_HEIGHT;

	/**
	 * The disc is drawn into a fixed 640x360 buffer that CSS then stretches to
	 * the host, so "circular" is a statement about the host and not about the
	 * buffer: an ellipse in buffer coordinates is what a circle on screen looks
	 * like. This undoes the stretch on each axis and hands back the two screen
	 * radii, which must agree.
	 */
	const screenRadii = (placement: { radiusX: number; radiusY: number }, cssWidth: number, cssHeight: number) => ({
		x: placement.radiusX / BUFFER_WIDTH * cssWidth,
		y: placement.radiusY / BUFFER_HEIGHT * cssHeight
	});

	// --- the ground role: today's composition, unchanged ---------------------

	test('the ground role reproduces the shipped title-strip numbers exactly at 1280x720', () => {
		// These are the values the shipped constants produce - RADIUS_RATIO 0.09
		// clamped up to RADIUS_MIN_PIXELS 100, CENTRE_X_RATIO 0.74, CENTRE_Y_PIXELS
		// 12 - and the chrome strip is composed around them. Nothing about the
		// stage is allowed to move them, so they are written out rather than
		// derived: a test that recomputed the formula would agree with any change
		// to it.
		const placement = computeGlobePlacement('ground', 1280, 720, BUFFER_WIDTH, BUFFER_HEIGHT);

		assert.strictEqual(placement.centreX, 473.6);
		assert.strictEqual(placement.centreY, 6);
		assert.strictEqual(placement.radiusX, 50);
		assert.strictEqual(placement.radiusY, 50);
	});

	test('the ground role keeps its centre inside the title strip at every window height', () => {
		// CENTRE_Y_PIXELS is a screen offset and not a ratio precisely so that the
		// centre lands a third of the way down the ~35px strip whatever the window
		// is doing. In buffer coordinates that means a *smaller* number as the
		// window gets taller.
		for (const cssHeight of [600, 720, 1080, 1440, 2160]) {
			const placement = computeGlobePlacement('ground', 1920, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			const centreYinCssPixels = placement.centreY / BUFFER_HEIGHT * cssHeight;
			assert.ok(Math.abs(centreYinCssPixels - 12) < 1e-9, `centre drifted off the strip at ${cssHeight}px`);
		}
	});

	test('the ground role clamps its radius to a screen size the strip can hold', () => {
		// 0.09 of the height, but never smaller than 100 screen pixels and never
		// larger than 190: the strip is a fixed screen size, so a globe that grew
		// with the window would only get flatter inside it.
		const small = screenRadii(computeGlobePlacement('ground', 1280, 400, BUFFER_WIDTH, BUFFER_HEIGHT), 1280, 400);
		assert.ok(Math.abs(small.x - 100) < 1e-9, 'below the clamp the radius must hold at the minimum');

		const large = screenRadii(computeGlobePlacement('ground', 3440, 4000, BUFFER_WIDTH, BUFFER_HEIGHT), 3440, 4000);
		assert.ok(Math.abs(large.x - 190) < 1e-9, 'above the clamp the radius must hold at the maximum');

		const middle = screenRadii(computeGlobePlacement('ground', 2560, 1440, BUFFER_WIDTH, BUFFER_HEIGHT), 2560, 1440);
		assert.ok(Math.abs(middle.x - 0.09 * 1440) < 1e-9, 'between the clamps the ratio applies');
	});

	// --- the stage role: the limb ---------------------------------------------

	test('the stage role puts the centre off towards the bottom-right and lets the pane crop the disc', () => {
		// A typical Start pane in a maximised window. What has to show is a large
		// arc rising into frame, which means three things at once: the centre is in
		// the bottom-right quadrant, and the disc runs past both the right and the
		// bottom edge so the pane cuts it.
		const cssWidth = 1428;
		const cssHeight = 1025;
		const placement = computeGlobePlacement('stage', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);

		assert.ok(placement.centreX > BUFFER_WIDTH / 2, 'the centre must sit right of the middle');
		assert.ok(placement.centreY > BUFFER_HEIGHT / 2, 'the centre must sit below the middle');
		assert.ok(placement.centreX + placement.radiusX > BUFFER_WIDTH, 'the disc must run off the right edge');
		assert.ok(placement.centreY + placement.radiusY > BUFFER_HEIGHT, 'the disc must run off the bottom edge');

		// ...and it must still reach back far enough to read as a limb rather than
		// as a corner smudge.
		assert.ok(placement.centreX - placement.radiusX < BUFFER_WIDTH / 2, 'the arc has to reach past the middle of the pane');
		assert.ok(placement.centreY - placement.radiusY < BUFFER_HEIGHT / 2, 'the arc has to rise past the middle of the pane');
	});

	test('the stage radius stays inside its clamp at every pane size', () => {
		const radiusOf = (cssWidth: number, cssHeight: number) =>
			screenRadii(computeGlobePlacement('stage', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT), cssWidth, cssHeight).x;

		// A narrow split, a typical pane, and a very large one. 220 and 560 are the
		// clamp; nothing between them may leave it.
		for (const [cssWidth, cssHeight] of [[320, 400], [640, 480], [1428, 1025], [2560, 1440], [5120, 2880]] as const) {
			const radius = radiusOf(cssWidth, cssHeight);
			assert.ok(radius >= 220 - 1e-9, `radius ${radius} fell under the clamp at ${cssWidth}x${cssHeight}`);
			assert.ok(radius <= 560 + 1e-9, `radius ${radius} broke the clamp at ${cssWidth}x${cssHeight}`);
		}

		assert.ok(Math.abs(radiusOf(320, 300) - 220) < 1e-9, 'a tiny pane holds at the minimum');
		assert.ok(Math.abs(radiusOf(5120, 2880) - 560) < 1e-9, 'a huge pane holds at the maximum');
		// 0.55 of 800 is 440, which is inside the clamp; note that a maximised pane
		// at 1025 tall would ask for 563.75 and be held at 560, so the size chosen
		// here has to be one where the ratio is actually what applies.
		assert.ok(Math.abs(radiusOf(1200, 800) - 0.55 * 800) < 1e-9, 'in between, 0.55 of the shorter side');
	});

	test('the stage radius is taken from the shorter side, so a wide short pane is not banded', () => {
		// A pane split horizontally is wide and short. Sizing off the long side
		// would put a disc taller than the pane into it, and all that would show is
		// a band with no curvature in it at all.
		const wide = screenRadii(computeGlobePlacement('stage', 2000, 500, BUFFER_WIDTH, BUFFER_HEIGHT), 2000, 500);
		assert.ok(Math.abs(wide.x - 0.55 * 500) < 1e-9, 'the shorter side is the one that decides');
	});

	// --- the invariant that made the stage possible at all -------------------

	test('the disc stays circular in screen space when the 16:9 buffer is stretched to a pane that is not', () => {
		// This is what the `measure` parameter on MotifSurface exists for. The
		// buffer is 16:9; a Start pane very rarely is. If the two screen radii ever
		// disagree, the globe is an ellipse.
		const shapes: readonly (readonly [number, number])[] = [
			[1280, 720],    // the buffer's own aspect
			[1428, 1025],   // a maximised Start pane, 1.39:1
			[900, 1400],    // taller than it is wide
			[2400, 600],    // a wide horizontal split
			[1000, 1000]    // square
		];

		for (const role of ['ground', 'stage'] as const) {
			for (const [cssWidth, cssHeight] of shapes) {
				const radii = screenRadii(computeGlobePlacement(role, cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT), cssWidth, cssHeight);
				assert.ok(
					Math.abs(radii.x - radii.y) < 1e-9,
					`'${role}' drew an ellipse at ${cssWidth}x${cssHeight}: ${radii.x} by ${radii.y}`
				);
			}
		}
	});

	test('the two roles are genuinely different compositions, not one tuned twice', () => {
		const cssWidth = 1428;
		const cssHeight = 1025;
		const ground = computeGlobePlacement('ground', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
		const stage = computeGlobePlacement('stage', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);

		assert.ok(stage.radiusX > ground.radiusX * 4, 'the whole point of the stage is that there is room to be big');
		assert.ok(ground.centreY < BUFFER_HEIGHT * 0.05, 'the ground role still hangs its centre off the top edge');
		assert.ok(stage.centreY > BUFFER_HEIGHT * 0.5, 'the stage role does not');
	});
});

/**
 * The colour-blind guard, as a test rather than as a comment.
 *
 * `globe.ts` states in its header that the picture is carried entirely by
 * luminance and that a second hue in the ground "would be the one thing here
 * that some users could not see". The code contradicted its own comment for as
 * long as `readInk` fell back to `palette.accent`, which resolves to
 * `focusBorder` and is a saturated hue in four of the six shipped vibes. This is
 * what stops that from coming back.
 */
suite('Primal Motif - globe ink', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const palette = (overrides: Partial<IMotifPalette>): IMotifPalette => ({
		ground: '#101010',
		ink: '',
		dim: '',
		accent: '',
		dark: true,
		...overrides
	});

	test('foreground is the ink', () => {
		const ink = readGlobeInk(palette({ ink: '#e8e4de', dim: '#8a8a8a', accent: '#7fb4e8' }));
		assert.strictEqual(ink?.toString().toLowerCase(), '#e8e4de');
	});

	test('descriptionForeground is the only fallback, and it is the same ink by another name', () => {
		const ink = readGlobeInk(palette({ dim: '#8a8a8a', accent: '#7fb4e8' }));
		assert.strictEqual(ink?.toString().toLowerCase(), '#8a8a8a');
	});

	test('the accent is never the ink, however loudly the palette offers it', () => {
		// The regression guard. A palette in which the accent is the only token
		// that parses must produce no ink at all - the renderer then declines to
		// paint, which the scheduler has a path for, and the ground keeps the
		// wallpaper's own wash. A picture drawn in `focusBorder` would be a hue
		// field that some readers cannot distinguish from the ground.
		assert.strictEqual(readGlobeInk(palette({ accent: '#7fb4e8' })), undefined);
		assert.strictEqual(readGlobeInk(palette({ ink: '', dim: '', accent: '#ff0000' })), undefined);
	});

	test('an unparseable token is not an ink either', () => {
		assert.strictEqual(readGlobeInk(palette({ ink: 'not-a-colour', dim: 'also-not' })), undefined);
		assert.strictEqual(readGlobeInk(palette({ ink: 'not-a-colour', dim: '#8a8a8a' }))?.toString().toLowerCase(), '#8a8a8a');
	});
});
