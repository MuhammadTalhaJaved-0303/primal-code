/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IPrimalThemeDescriptor, IPrimalVibeReference, PRIMAL_THEME_EXTENSION_ID } from '../../common/primalThemeGallery.js';
import { buildCatalogue, classifyTheme, filterCatalogue, groupCatalogue, modeOf } from '../../common/primalThemeGalleryModel.js';

/**
 * The six shipping vibes, as the pane hands them in.
 *
 * Restated here rather than imported: `PRIMAL_VIBES` lives in the vibes contrib's
 * `browser` layer, which a `common`-layer test may not reach, and the
 * classification under test takes the list as an argument precisely so it does
 * not depend on one. Keep the ids in step with
 * `primalVibes/browser/primalVibes.ts` — the labels here are also its colour
 * theme settings ids.
 */
const PRIMAL_VIBES: readonly IPrimalVibeReference[] = [
	{ id: 'ink', colorTheme: 'Primal Ink' },
	{ id: 'basalt', colorTheme: 'Primal Basalt' },
	{ id: 'tide', colorTheme: 'Primal Tide' },
	{ id: 'dusk', colorTheme: 'Primal Dusk' },
	{ id: 'fern', colorTheme: 'Primal Fern' },
	{ id: 'ridge', colorTheme: 'Primal Ridge' }
];

function primal(label: string, type: ColorScheme = ColorScheme.DARK): IPrimalThemeDescriptor {
	return { settingsId: label, label, type, extensionId: PRIMAL_THEME_EXTENSION_ID };
}

function thirdParty(label: string, type: ColorScheme = ColorScheme.DARK): IPrimalThemeDescriptor {
	return { settingsId: label, label, type, extensionId: 'someone.their-theme' };
}

suite('Primal theme gallery - catalogue', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a vibe theme classifies as a vibe and carries its vibe id', () => {
		const entry = classifyTheme(primal('Primal Basalt'), PRIMAL_VIBES);
		assert.strictEqual(entry.source, 'vibe');
		assert.strictEqual(entry.vibeId, 'basalt');
		assert.strictEqual(entry.family, 'Basalt');
		assert.strictEqual(entry.shortLabel, 'Basalt');
	});

	test('a bundled theme that is not a vibe classifies as corpus', () => {
		// This is one of the fifteen themes the vibe engine could not see.
		const entry = classifyTheme(primal('Primal Umber Hard'), PRIMAL_VIBES);
		assert.strictEqual(entry.source, 'corpus');
		assert.strictEqual(entry.vibeId, undefined);
		assert.strictEqual(entry.family, 'Umber', 'the depth suffix is not part of the family');
		assert.strictEqual(entry.shortLabel, 'Umber Hard');
	});

	test('every bundled corpus family groups its three depths together', () => {
		const entries = ['Primal Umber Soft', 'Primal Umber', 'Primal Umber Hard'].map(label => classifyTheme(primal(label), PRIMAL_VIBES));
		assert.deepStrictEqual(entries.map(entry => entry.family), ['Umber', 'Umber', 'Umber']);
	});

	test('a third-party theme classifies as installed and keeps its full name', () => {
		const entry = classifyTheme(thirdParty('Solarized Light', ColorScheme.LIGHT), PRIMAL_VIBES);
		assert.strictEqual(entry.source, 'installed');
		assert.strictEqual(entry.shortLabel, 'Solarized Light');
		assert.strictEqual(entry.mode, 'light');
	});

	test('a theme matching no vibe and no extension does not throw', () => {
		const entry = classifyTheme({ settingsId: 'Nameless', label: 'Nameless', type: ColorScheme.DARK }, PRIMAL_VIBES);
		assert.strictEqual(entry.source, 'installed');
	});

	test('a theme whose label carries no Primal prefix still classifies', () => {
		const entry = classifyTheme(primal('Odd One'), PRIMAL_VIBES);
		assert.strictEqual(entry.source, 'corpus');
		assert.strictEqual(entry.shortLabel, 'Odd One');
	});

	test('the mode facet comes from the colour scheme, including high contrast', () => {
		assert.strictEqual(modeOf(ColorScheme.LIGHT), 'light');
		assert.strictEqual(modeOf(ColorScheme.DARK), 'dark');
		assert.strictEqual(modeOf(ColorScheme.HIGH_CONTRAST_DARK), 'highContrastDark');
		assert.strictEqual(modeOf(ColorScheme.HIGH_CONTRAST_LIGHT), 'highContrastLight');
	});

	test('an empty vibe list leaves every bundled theme as corpus', () => {
		const noVibes: readonly IPrimalVibeReference[] = [];
		assert.strictEqual(classifyTheme(primal('Primal Basalt'), noVibes).source, 'corpus');
	});

	test('the catalogue puts vibes first in contract order, then everything else by name', () => {
		const entries = buildCatalogue([
			thirdParty('Zebra'),
			primal('Primal Umber'),
			primal('Primal Tide'),
			primal('Primal Ink', ColorScheme.LIGHT),
			thirdParty('Aardvark')
		], PRIMAL_VIBES);
		assert.deepStrictEqual(entries.map(entry => entry.label), [
			'Primal Ink', 'Primal Tide', 'Primal Umber', 'Aardvark', 'Zebra'
		]);
	});

	test('buildCatalogue does not mutate the descriptors it is given', () => {
		const descriptors = [primal('Primal Tide'), primal('Primal Basalt')];
		const snapshot = descriptors.map(descriptor => descriptor.label);
		buildCatalogue(descriptors, PRIMAL_VIBES);
		assert.deepStrictEqual(descriptors.map(descriptor => descriptor.label), snapshot);
	});
});

suite('Primal theme gallery - search and grouping', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const catalogue = buildCatalogue([
		primal('Primal Ink', ColorScheme.LIGHT),
		primal('Primal Basalt'),
		primal('Primal Umber Soft'),
		primal('Primal Umber Hard'),
		thirdParty('Solarized Light', ColorScheme.LIGHT)
	], PRIMAL_VIBES);

	test('an empty query matches everything', () => {
		assert.strictEqual(filterCatalogue(catalogue, '   ').length, catalogue.length);
	});

	test('search matches the name', () => {
		assert.deepStrictEqual(filterCatalogue(catalogue, 'umber').map(entry => entry.label), ['Primal Umber Hard', 'Primal Umber Soft']);
	});

	test('search matches the mode word', () => {
		const light = filterCatalogue(catalogue, 'light').map(entry => entry.label);
		assert.ok(light.includes('Primal Ink'), 'the light vibe matches the word "light"');
		assert.ok(!light.includes('Primal Basalt'), 'a dark theme does not');
	});

	test('every term has to match, so a second word narrows', () => {
		assert.deepStrictEqual(filterCatalogue(catalogue, 'umber hard').map(entry => entry.label), ['Primal Umber Hard']);
	});

	test('search is case insensitive', () => {
		assert.strictEqual(filterCatalogue(catalogue, 'BASALT').length, 1);
	});

	test('grouping by family gathers the depths of one family', () => {
		const groups = groupCatalogue(catalogue, 'family');
		const umber = groups.find(group => group.id === 'Umber');
		assert.ok(umber, 'there is an Umber group');
		assert.strictEqual(umber.entries.length, 2);
	});

	test('grouping by mode splits light from dark', () => {
		const groups = groupCatalogue(catalogue, 'mode');
		assert.deepStrictEqual(
			groups.map(group => group.id).sort(),
			['dark', 'light']
		);
	});

	test('grouping keeps every entry exactly once', () => {
		for (const grouping of ['family', 'mode'] as const) {
			const total = groupCatalogue(catalogue, grouping).reduce((sum, group) => sum + group.entries.length, 0);
			assert.strictEqual(total, catalogue.length, `grouping by ${grouping} loses nothing`);
		}
	});
});
