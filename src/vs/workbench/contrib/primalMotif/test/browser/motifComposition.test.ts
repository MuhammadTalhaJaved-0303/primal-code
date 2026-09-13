/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_MOTIF_BUFFER_HEIGHT, PRIMAL_MOTIF_BUFFER_WIDTH } from '../../browser/primalMotif.js';
import { BREATH_AMPLITUDE, computeContourComposition, computeContourRings } from '../../browser/motifs/contours.js';
import { computeOrbitSystem, orbitPeriodMs } from '../../browser/motifs/orbit.js';
import { HORIZON_GROUND_STRIP_PIXELS, computeHorizonCamera, horizonDepthLinePositions } from '../../browser/motifs/horizon.js';

/**
 * The three new motifs' compositions.
 *
 * `globePlacement.test.ts` makes the argument for testing this kind of
 * arithmetic rather than screenshotting it: a placement decides whether the
 * product shows a picture or a smudge, it has to hold at every window shape
 * rather than at the one somebody looked at, and the two roles have to be
 * genuinely different compositions rather than one composition scaled - which is
 * exactly the mistake that is easy to make and impossible to see in a single
 * screenshot.
 *
 * The shapes below are the ones that catch things: the buffer's own 16:9, a
 * maximised Start pane, a narrow vertical split, a wide horizontal one, and a
 * square.
 */
const BUFFER_WIDTH = PRIMAL_MOTIF_BUFFER_WIDTH;
const BUFFER_HEIGHT = PRIMAL_MOTIF_BUFFER_HEIGHT;

const SHAPES: readonly (readonly [number, number])[] = Object.freeze([
	[1280, 720],
	[1428, 1025],
	[900, 1400],
	[2400, 600],
	[1000, 1000]
] as const);

suite('Primal Motif - contours composition', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the ground role is anchored in screen pixels, so a ring is a circle on screen', () => {
		// The strip is a fixed screen size, so the nest is too - which means the
		// stretch of the fixed 640x360 buffer onto the window has to be undone on
		// each axis, exactly as the globe does it.
		for (const [cssWidth, cssHeight] of SHAPES) {
			const nest = computeContourComposition('ground', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			const screenX = nest.scaleX / BUFFER_WIDTH * cssWidth;
			const screenY = nest.scaleY / BUFFER_HEIGHT * cssHeight;
			assert.ok(Math.abs(screenX - screenY) < 1e-9, `a ring became an ellipse at ${cssWidth}x${cssHeight}: ${screenX} by ${screenY}`);
		}
	});

	test('the ground centre stays a third of the way down the title strip at every window height', () => {
		for (const cssHeight of [600, 720, 1080, 1440, 2160]) {
			const nest = computeContourComposition('ground', 1920, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			const centreYinCssPixels = nest.centreY / BUFFER_HEIGHT * cssHeight;
			assert.ok(Math.abs(centreYinCssPixels - 12) < 1e-9, `the summit drifted off the strip at ${cssHeight}px`);
		}
	});

	test('the stage role is composed to the frame instead, and crops on every edge', () => {
		const nest = computeContourComposition('stage', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);

		// A field, not an object: one unit of radius is the buffer itself, so the
		// nest follows whatever shape the pane is rather than resisting it.
		assert.strictEqual(nest.scaleX, BUFFER_WIDTH);
		assert.strictEqual(nest.scaleY, BUFFER_HEIGHT);

		const outer = nest.composition.outerRadius;
		assert.ok(nest.centreX + outer * nest.scaleX > BUFFER_WIDTH, 'the outermost ring must run off the right edge');
		assert.ok(nest.centreX - outer * nest.scaleX < 0, 'and off the left');
		assert.ok(nest.centreY + outer * nest.scaleY > BUFFER_HEIGHT, 'and off the bottom');
		assert.ok(nest.centreY - outer * nest.scaleY < 0, 'and off the top');
	});

	test('the two roles are different compositions, not one tuned twice', () => {
		const ground = computeContourComposition('ground', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);
		const stage = computeContourComposition('stage', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);

		assert.ok(stage.composition.rings > ground.composition.rings, 'a whole pane can carry more of the nest than a strip can');
		assert.ok(stage.composition.vertices > ground.composition.vertices, 'and can resolve each ring better');
		assert.ok(ground.centreY < BUFFER_HEIGHT * 0.05, 'the ground role hangs its summit in the title strip');
		assert.ok(stage.centreY > BUFFER_HEIGHT * 0.5, 'the stage role does not');
	});

	test('the rings never cross, in either role, at the worst pose of the relief and the breath', () => {
		// Contour lines that cross are not contour lines, and this is the one
		// property of the composition that a still frame would not reveal: it
		// takes the worst phase of two independent motions at once.
		//
		// A ring sits at `radius * (1 + breath) + relief * share`, and the relief
		// is ONE value shared by the whole nest at a given angle - which is the
		// property the design rests on. So at any angle two adjacent rings differ
		// by `gap + relief * (share_outer - share_inner)`, and the worst case is
		// that difference at the full relief, against the worst opposition of the
		// two breathing phases. The relief itself is bounded by the composition's
		// own figure because the harmonic weights sum to one.
		for (const role of ['ground', 'stage'] as const) {
			const nest = computeContourComposition(role, 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);
			const rings = computeContourRings(nest.composition);
			const relief = nest.composition.relief;

			for (let ring = 1; ring < rings.length; ring++) {
				const inner = rings[ring - 1];
				const outer = rings[ring];

				const closest = outer.radius * (1 - BREATH_AMPLITUDE)
					- inner.radius * (1 + BREATH_AMPLITUDE)
					- relief * Math.abs(outer.relief - inner.relief);

				assert.ok(closest > 0, `'${role}' ring ${ring} can touch ring ${ring - 1}: ${closest}`);
			}

			// And the summit cannot turn itself inside out: the innermost ring
			// stays outside its own centre at the worst pose of both motions.
			const summit = rings[0];
			assert.ok(
				summit.radius * (1 - BREATH_AMPLITUDE) - relief * summit.relief > 0,
				`'${role}' can invert its innermost ring`
			);
		}
	});
});

suite('Primal Motif - orbit composition', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a ring is a circle on screen in both roles, whatever shape the host is', () => {
		// This one is a mechanism rather than a field, so unlike `contours` and
		// `horizon` it refuses to be stretched. An orrery drawn as an ellipse is
		// a broken orrery.
		for (const role of ['ground', 'stage'] as const) {
			for (const [cssWidth, cssHeight] of SHAPES) {
				const system = computeOrbitSystem(role, cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
				const screenX = system.reachX / BUFFER_WIDTH * cssWidth;
				const screenY = system.reachY / BUFFER_HEIGHT * cssHeight;
				assert.ok(Math.abs(screenX - screenY) < 1e-9, `'${role}' drew an ellipse at ${cssWidth}x${cssHeight}: ${screenX} by ${screenY}`);
			}
		}
	});

	test('the ground system holds a fixed screen size and hangs its primary in the title strip', () => {
		for (const cssHeight of [600, 720, 1080, 1440, 2160]) {
			const system = computeOrbitSystem('ground', 1920, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			const reachInCssPixels = system.reachY / BUFFER_HEIGHT * cssHeight;
			const centreYinCssPixels = system.centreY / BUFFER_HEIGHT * cssHeight;

			assert.ok(Math.abs(reachInCssPixels - 232) < 1e-9, `the system grew with the window at ${cssHeight}px`);
			assert.ok(Math.abs(centreYinCssPixels - 12) < 1e-9, `the primary drifted off the strip at ${cssHeight}px`);
		}
	});

	test('the stage system is sized from the pane and clamped at both ends', () => {
		const reachOf = (cssWidth: number, cssHeight: number) =>
			computeOrbitSystem('stage', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT).reachX / BUFFER_WIDTH * cssWidth;

		// The shorter side decides, so a wide short pane is not banded.
		assert.ok(Math.abs(reachOf(2400, 600) - 0.70 * 600) < 1e-9, 'the shorter side is the one that decides');
		assert.ok(Math.abs(reachOf(320, 300) - 260) < 1e-9, 'a tiny pane holds at the minimum');
		assert.ok(Math.abs(reachOf(5120, 2880) - 780) < 1e-9, 'a huge pane holds at the maximum');

		for (const [cssWidth, cssHeight] of SHAPES) {
			const reach = reachOf(cssWidth, cssHeight);
			assert.ok(reach >= 260 - 1e-9 && reach <= 780 + 1e-9, `reach ${reach} left its clamp at ${cssWidth}x${cssHeight}`);
		}
	});

	test('the stage carries a ring the pane crops, which the ground does not', () => {
		const ground = computeOrbitSystem('ground', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);
		const stage = computeOrbitSystem('stage', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);

		assert.ok(stage.rings.length > ground.rings.length, 'the stage is not the ground system at a larger size');

		const outermost = stage.rings[stage.rings.length - 1];
		assert.ok(outermost.radius > 1, 'the outermost stage ring must be past the reach, so the pane crops it');
		assert.ok(stage.centreY + outermost.radius * stage.reachY > BUFFER_HEIGHT, 'and it must actually leave the frame');

		for (const ring of ground.rings) {
			assert.ok(ring.radius <= 1, 'the ground system stays inside its own reach');
		}
	});

	test('depth is a luminance ladder: the further out a ring is, the fainter it is', () => {
		for (const role of ['ground', 'stage'] as const) {
			const rings = computeOrbitSystem(role, 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT).rings;
			for (let index = 1; index < rings.length; index++) {
				assert.ok(rings[index].radius > rings[index - 1].radius, `'${role}' ring ${index} is not outside its neighbour`);
				assert.ok(rings[index].alpha < rings[index - 1].alpha, `'${role}' ring ${index} is not fainter than its neighbour`);
			}
		}
	});

	test('the periods are Kepler, so the rings never turn as one wheel', () => {
		const rings = computeOrbitSystem('stage', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT).rings;

		for (let index = 1; index < rings.length; index++) {
			const inner = orbitPeriodMs(rings[index - 1].radius);
			const outer = orbitPeriodMs(rings[index].radius);
			assert.ok(outer > inner, `ring ${index} does not take longer than the one inside it`);
			// Faster further in, and by more than the radius ratio: that is what
			// the 1.5 exponent means, and it is what stops the picture repeating.
			assert.ok(outer / inner > rings[index].radius / rings[index - 1].radius, 'the ratio is not superlinear, so this is not Kepler');
		}

		// The whole range has to be legible: fast enough that a single settle
		// burst shows the inner body move, slow enough that the outer one is
		// weather rather than animation.
		const fastest = orbitPeriodMs(rings[0].radius);
		const slowest = orbitPeriodMs(rings[rings.length - 1].radius);
		assert.ok(fastest > 4000, 'the innermost body would read as a spin');
		assert.ok(slowest > fastest * 10, 'the outermost body has to be an order of magnitude slower');
	});
});

suite('Primal Motif - horizon composition', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the ground vanishing point sits inside the title strip at every window height', () => {
		for (const cssHeight of [600, 720, 1080, 1440, 2160]) {
			const camera = computeHorizonCamera('ground', 1920, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			const vanishingInCssPixels = camera.vanishingY / BUFFER_HEIGHT * cssHeight;
			assert.ok(Math.abs(vanishingInCssPixels - 10) < 1e-9, `the horizon left the strip at ${cssHeight}px`);
		}
	});

	test('the stage raises the horizon and widens the field of view', () => {
		const ground = computeHorizonCamera('ground', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);
		const stage = computeHorizonCamera('stage', 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);

		assert.ok(stage.vanishingY > BUFFER_HEIGHT * 0.3, 'a pane has sky above the horizon; a strip does not');
		assert.ok(stage.vanishingY < BUFFER_HEIGHT * 0.5, 'and the grid still gets more of the frame than the sky does');
		assert.ok(ground.vanishingY < BUFFER_HEIGHT * 0.05, 'the ground role keeps its horizon in the strip');
		assert.ok(stage.spread > ground.spread, 'the stage is a wider field of view, not the same one enlarged');
	});

	test('the nearest line leaves the visible frame before the treadmill recycles it', () => {
		// The recycle is only invisible if the line being recycled has already
		// gone. `reach` is what puts it past the edge - the pane's bottom edge on
		// a stage, and the strip's bottom edge in the ground role, where the slab
		// below the strip is the only edge anybody can see.
		for (const [cssWidth, cssHeight] of SHAPES) {
			const stage = computeHorizonCamera('stage', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			assert.ok(stage.vanishingY + stage.reach > BUFFER_HEIGHT, `'stage' would recycle a line inside the pane at ${cssWidth}x${cssHeight}`);

			const ground = computeHorizonCamera('ground', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			const nearestInCssPixels = (ground.vanishingY + ground.reach) / BUFFER_HEIGHT * cssHeight;
			assert.ok(nearestInCssPixels > HORIZON_GROUND_STRIP_PIXELS, `'ground' would recycle a line inside the strip at ${cssWidth}x${cssHeight}`);
		}
	});

	test('the ground plane is a fixed screen size, so the strip holds the same picture at every window size', () => {
		// The same argument `globe.ts` makes for its radius: the strip is a fixed
		// screen size, so a plane that grew with the window would only put its
		// lines further behind the slab. Both axes, because the fan's shape is
		// part of the picture.
		const reference = computeHorizonCamera('ground', 1280, 720, BUFFER_WIDTH, BUFFER_HEIGHT);
		const referenceReach = reference.reach / BUFFER_HEIGHT * 720;
		const referenceSpread = reference.spread / BUFFER_WIDTH * 1280;

		for (const [cssWidth, cssHeight] of SHAPES) {
			const camera = computeHorizonCamera('ground', cssWidth, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);
			assert.ok(Math.abs(camera.reach / BUFFER_HEIGHT * cssHeight - referenceReach) < 1e-9, `the plane grew with the window at ${cssWidth}x${cssHeight}`);
			assert.ok(Math.abs(camera.spread / BUFFER_WIDTH * cssWidth - referenceSpread) < 1e-9, `the fan changed shape at ${cssWidth}x${cssHeight}`);
		}
	});

	test('in the ground role every carried line but the nearest is inside the strip, at every phase of the cycle', () => {
		// This is what the ground role exists to show, and it is what the
		// previous camera never did: composed for the whole window, its farthest
		// line sat eighty screen pixels below a strip that ends at thirty-five,
		// so the only thing the strip ever held was the static horizon rule.
		// Checked at the two ends of the treadmill's cycle, which bound every
		// position in between, and at every window height.
		for (const cssHeight of [600, 720, 1080, 1440, 2160]) {
			const camera = computeHorizonCamera('ground', 1920, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);

			for (const frac of [0, 0.5, 1]) {
				const positions = horizonDepthLinePositions(camera, frac);
				const inside = positions.filter(y => y / BUFFER_HEIGHT * cssHeight < HORIZON_GROUND_STRIP_PIXELS);
				assert.ok(inside.length >= positions.length - 1, `only ${inside.length} of ${positions.length} lines are in the strip at ${cssHeight}px, frac ${frac}`);

				// And they are below the horizon, not on it: the strip is a picture
				// of a plane, not a thicker horizon rule.
				const farthestInCssPixels = (positions[positions.length - 1] - camera.vanishingY) / BUFFER_HEIGHT * cssHeight;
				assert.ok(farthestInCssPixels > 1, `the far field collapsed onto the horizon at ${cssHeight}px`);
			}
		}
	});

	test('in the ground role the two nearest carried lines never come within five screen pixels of each other', () => {
		// Lines that are closer than that are a band, not lines. The near field
		// is where the alpha is, so it is the near field that has to resolve;
		// the far field is allowed to dissolve into the horizon, exactly as it
		// does on a stage. In screen pixels, because a 4K window has six of them
		// to a buffer pixel and the buffer is not the unit that matters.
		for (const cssHeight of [600, 720, 1080, 1440, 2160]) {
			const camera = computeHorizonCamera('ground', 1920, cssHeight, BUFFER_WIDTH, BUFFER_HEIGHT);

			for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
				const [nearest, next] = horizonDepthLinePositions(camera, frac);
				const gapInCssPixels = (nearest - next) / BUFFER_HEIGHT * cssHeight;
				assert.ok(gapInCssPixels >= 5, `the two nearest lines are ${gapInCssPixels}px apart at ${cssHeight}px, frac ${frac}`);
			}
		}
	});

	test('both roles centre the vanishing point and keep the plane in front of the viewer', () => {
		for (const role of ['ground', 'stage'] as const) {
			const camera = computeHorizonCamera(role, 1428, 1025, BUFFER_WIDTH, BUFFER_HEIGHT);
			assert.strictEqual(camera.vanishingX, BUFFER_WIDTH / 2);
			assert.ok(camera.reach > 0, 'the plane must run away from the viewer, not towards them');
			assert.ok(camera.spread > 0, 'the rays must fan out');
		}
	});
});
