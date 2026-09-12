/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IMotifDescriptor,
	IMotifPalette,
	PRIMAL_MOTIF_FRAME_BUDGET_MS,
	PRIMAL_MOTIF_STATIC_ID,
	PrimalMotifRole,
	getMotifDescriptors,
	isMotifCanvas
} from '../../browser/primalMotif.js';
import { STARFIELD_MOTIF_ID, STAR_LAYERS } from '../../browser/motifs/starfield.js';
import { PRIMAL_MOTIF_WORLD_ID } from '../../browser/motifs/globe.js';
import { PRIMAL_MOTIF_CONTOURS_ID } from '../../browser/motifs/contours.js';
import { PRIMAL_MOTIF_HORIZON_ID } from '../../browser/motifs/horizon.js';
import { PRIMAL_MOTIF_ORBIT_ID } from '../../browser/motifs/orbit.js';
// The shipping set, imported the way the workbench imports it. Everything below
// is written over `getMotifDescriptors()` rather than over a list kept here, so
// a motif cannot be added to the product without arriving in these suites.
import '../../browser/motifs/motifs.js';
import {
	ACCENT_ONLY_PALETTE,
	INK_PALETTE,
	LIGHT_INK_PALETTE,
	UNPARSEABLE_INK_PALETTE,
	createTestFrame,
	createTestMotifHost
} from './motifTestHost.js';

const ROLES: readonly PrimalMotifRole[] = Object.freeze(['ground', 'stage'] as const);

/** Ink pixels the buffer has to carry before a role counts as painted. */
const MINIMUM_PAINTED_PIXELS = 100;

/** How many ink pixels a renderer laid down, out of the whole buffer. */
function countPaintedPixels(element: HTMLElement): number {
	if (!isMotifCanvas(element)) {
		// `assert.fail` returns `never`, which is what narrows `element` below.
		assert.fail('a canvas motif must have been handed a canvas');
	}

	const context = element.getContext('2d');
	assert.ok(context, 'the canvas must still have its 2D context');

	const pixels = context.getImageData(0, 0, element.width, element.height).data;
	let painted = 0;
	for (let index = 3; index < pixels.length; index += 4) {
		if (pixels[index] > 0) {
			painted++;
		}
	}

	return painted;
}

/**
 * Every motif, on the terms the whole layer rests on.
 *
 * Written over the registry rather than over a list of ids, because the point of
 * these suites is exactly the motif somebody adds next: a new file under
 * `browser/motifs/` is imported by `motifs/motifs.ts`, arrives here on its own,
 * and has to answer the same three questions as everything already shipping -
 * does it describe itself, does it paint in both roles, and does it refuse to
 * invent a colour.
 */
suite('Primal Motif - registry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const descriptors = getMotifDescriptors();

	test('the shipping set is the one the product offers', () => {
		// The barrel in `motifs/motifs.ts` is the only thing that decides what
		// exists. If an import is dropped from it, the settings enum loses a
		// choice silently - so the set is pinned here, and a motif added to the
		// product has to be added to this line as well.
		const ids = descriptors.map(descriptor => descriptor.id).sort();
		assert.deepStrictEqual(ids, [
			PRIMAL_MOTIF_CONTOURS_ID,
			STARFIELD_MOTIF_ID,
			PRIMAL_MOTIF_HORIZON_ID,
			PRIMAL_MOTIF_ORBIT_ID,
			PRIMAL_MOTIF_STATIC_ID,
			PRIMAL_MOTIF_WORLD_ID
		].sort());
	});

	test('motion is a real axis: at least four motifs move', () => {
		// The whole reason this branch exists. One moving motif is a feature with
		// an example in it; a choice needs several, and they have to be more than
		// reskins of each other - which is what the composition suites check.
		const moving = descriptors.filter(descriptor => descriptor.id !== PRIMAL_MOTIF_STATIC_ID);
		assert.ok(moving.length >= 4, `only ${moving.length} motifs move`);
	});

	for (const descriptor of descriptors) {

		test(`'${descriptor.id}' describes itself`, () => {
			assert.ok(descriptor.id.length > 0, 'a motif needs an id');
			assert.ok(descriptor.label.length > 0, 'a motif needs a label for the settings UI');
			// The description is an `enumDescriptions` entry: it is the only
			// sentence a user ever reads about this motif, so it has to be a
			// sentence rather than a word.
			assert.ok(descriptor.description.length > 40, `'${descriptor.id}' needs a description, not a label`);
			assert.ok(descriptor.description.trim().endsWith('.'), `'${descriptor.id}' description must read as prose`);
			assert.strictEqual(typeof descriptor.allowsPerpetual, 'boolean');
			assert.ok(['css', 'canvas2d', 'webgl'].includes(descriptor.kind), `'${descriptor.id}' has an unknown kind`);
			assert.ok(Number.isFinite(descriptor.frameCostMs) && descriptor.frameCostMs >= 0, `'${descriptor.id}' must declare a measured frame cost`);
			assert.ok(descriptor.frameCostMs <= PRIMAL_MOTIF_FRAME_BUDGET_MS, `'${descriptor.id}' declares ${descriptor.frameCostMs}ms, over the ${PRIMAL_MOTIF_FRAME_BUDGET_MS}ms budget`);
		});

		test(`'${descriptor.id}' builds a renderer that agrees with its descriptor`, () => {
			const renderer = descriptor.create();
			try {
				assert.strictEqual(renderer.id, descriptor.id, 'the renderer and the descriptor must be the same motif');
				assert.strictEqual(renderer.kind, descriptor.kind, 'the scheduler builds the element from the descriptor kind');
				assert.ok(renderer.label.length > 0, 'a renderer needs a label');
			} finally {
				renderer.dispose();
			}
		});

		for (const role of ROLES) {
			test(`'${descriptor.id}' paints in the '${role}' role`, () => {
				const host = createTestMotifHost(descriptor.kind, role, INK_PALETTE);
				const renderer = descriptor.create();

				try {
					assert.strictEqual(renderer.create(host), true, `'${descriptor.id}' declined a palette that supplies ink`);

					// A pane, not the buffer's own 16:9, so a motif that only
					// looks right at one aspect is caught here.
					renderer.resize(1428, 1025);
					renderer.render(createTestFrame(0, 0));
					renderer.render(createTestFrame(1000, 33));

					assert.deepStrictEqual(host.failures, [], `'${descriptor.id}' reported a terminal failure`);

					if (descriptor.id !== PRIMAL_MOTIF_STATIC_ID) {
						const painted = countPaintedPixels(host.element);
						assert.ok(
							painted >= MINIMUM_PAINTED_PIXELS,
							`'${descriptor.id}' laid down only ${painted} ink pixels in the '${role}' role, which is not a picture`
						);
					}
				} finally {
					renderer.dispose();
					host.release();
				}
			});
		}

		test(`'${descriptor.id}' survives a light theme and a resize before its first frame`, () => {
			const host = createTestMotifHost(descriptor.kind, 'ground', LIGHT_INK_PALETTE);
			const renderer = descriptor.create();

			try {
				assert.strictEqual(renderer.create(host), true);
				// Zero is what a hidden or unlaid-out container measures, and it
				// reaches renderers during startup. Nothing may divide by it.
				renderer.resize(0, 0);
				renderer.resize(2560, 1440);
				renderer.render(createTestFrame(0, 0));
				assert.deepStrictEqual(host.failures, []);
			} finally {
				renderer.dispose();
				host.release();
			}
		});
	}
});

/**
 * The colour-blind guard, for every motif rather than for one.
 *
 * `globe.ts` has carried this rule in its header since it was written - "one
 * token: foreground, at a varying alpha... a second hue in the ground would be
 * the one thing here that some users could not see" - and `globePlacement.test.ts`
 * has held the globe to it. It was `starfield` that contradicted it, in two
 * places at once, and the cost was that the scheduler had to bar that motif from
 * the stage rather than fix the colour. So the rule is now enforced over the
 * whole registry: a palette in which `focusBorder` is the only token that parses
 * must produce NO painting motif at all.
 */
suite('Primal Motif - ink', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const descriptors = getMotifDescriptors();

	const refuses = (descriptor: IMotifDescriptor, role: PrimalMotifRole, palette: IMotifPalette): boolean => {
		const host = createTestMotifHost(descriptor.kind, role, palette);
		const renderer = descriptor.create();

		try {
			return renderer.create(host) === false;
		} finally {
			renderer.dispose();
			host.release();
		}
	};

	for (const descriptor of descriptors.filter(descriptor => descriptor.id !== PRIMAL_MOTIF_STATIC_ID)) {

		for (const role of ROLES) {
			test(`'${descriptor.id}' declines a palette whose only colour is the accent, in the '${role}' role`, () => {
				assert.strictEqual(
					refuses(descriptor, role, ACCENT_ONLY_PALETTE),
					true,
					`'${descriptor.id}' painted something from 'focusBorder' alone - see motifs/motifPaint.ts`
				);
			});
		}

		test(`'${descriptor.id}' declines ink tokens that do not parse`, () => {
			// Present but malformed is not the same as absent, and a canvas
			// silently keeps its previous fill style for a value it cannot
			// parse - which on the first frame is black.
			assert.strictEqual(refuses(descriptor, 'ground', UNPARSEABLE_INK_PALETTE), true);
		});
	}

	test(`'static' is the only motif exempt from the ink rule, and it paints nothing`, () => {
		// Stated as an assertion rather than left as an absence, so that a future
		// motif cannot join the exemption by being written like this one.
		const accepted = descriptors
			.filter(descriptor => !refuses(descriptor, 'ground', ACCENT_ONLY_PALETTE))
			.map(descriptor => descriptor.id);

		assert.deepStrictEqual(accepted, [PRIMAL_MOTIF_STATIC_ID]);

		const statik = descriptors.find(descriptor => descriptor.id === PRIMAL_MOTIF_STATIC_ID);
		assert.ok(statik, `'static' must always be registered: it is the default`);
		assert.strictEqual(statik.kind, 'css');
		assert.strictEqual(statik.frameCostMs, 0, `'static' is never rendered, so its cost is zero rather than small`);
	});
});

/**
 * The starfield's depth, now that it has no hue to carry it.
 *
 * The brightest layer used to be painted in `palette.accent`. Removing that
 * leaves the two cues that were always doing most of the work - how bright a
 * star is and how big it is - and this is what stops a later tweak from
 * flattening either of them and leaving the field a uniform speckle.
 */
suite('Primal Motif - starfield depth', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the layers are a strictly increasing ladder of alpha', () => {
		for (let index = 1; index < STAR_LAYERS.length; index++) {
			const nearer = STAR_LAYERS[index];
			const further = STAR_LAYERS[index - 1];
			assert.ok(
				nearer.alphaMin > further.alphaMax,
				`layer ${index} overlaps layer ${index - 1} in alpha: the two would not read as different distances`
			);
		}
	});

	test('the layers are a non-decreasing ladder of size, and the ladder actually rises', () => {
		for (let index = 1; index < STAR_LAYERS.length; index++) {
			assert.ok(STAR_LAYERS[index].size >= STAR_LAYERS[index - 1].size, `layer ${index} is smaller than the one behind it`);
		}

		assert.ok(
			STAR_LAYERS[STAR_LAYERS.length - 1].size > STAR_LAYERS[0].size,
			'if every layer is the same size, size is not a depth cue at all'
		);
	});

	test('the nearer a layer is, the faster it drifts', () => {
		for (let index = 1; index < STAR_LAYERS.length; index++) {
			assert.ok(STAR_LAYERS[index].driftX > STAR_LAYERS[index - 1].driftX, `layer ${index} does not out-run the one behind it`);
		}
	});

	test('no layer asks for a hue', () => {
		for (const layer of STAR_LAYERS) {
			assert.ok(layer.tone === 'ink' || layer.tone === 'dim', `a star layer asked for '${layer.tone}'`);
		}
	});

	test('twinkle stays far below anything that could read as a flash', () => {
		// Three per second is the slowest flicker that could be called a flash;
		// the fastest star here takes four and a half seconds for one cycle.
		for (const layer of STAR_LAYERS) {
			assert.ok(layer.twinkle <= 0.2, 'twinkle amplitude is a photosensitivity bound, not a taste');
		}
	});
});
