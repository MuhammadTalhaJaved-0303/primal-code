/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { contrastRatio, opaqueOf, perceptualDistance, tryParseHexColor, type Rgba } from '../../../../../base/common/primalColorScience.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_ANSI_SLOTS } from '../../common/primalReadabilityRules.js';
import { computeThemeReadability, IPrimalThemeColorSource } from '../../common/primalThemeReadability.js';
import { describeVerdictLevel } from '../../common/primalThemeVerdictLabel.js';

/** Parses a fixture hex, failing the test rather than substituting a colour. */
function hex(value: string): Rgba {
	const parsed = tryParseHexColor(value);
	assert.ok(parsed, `the fixture "${value}" is a colour`);
	return parsed;
}

/** A theme source built from plain hex maps. */
function source(colors: Record<string, string>, scopes: Record<string, string> = {}): IPrimalThemeColorSource {
	const parse = (values: Record<string, string>): Map<string, Rgba> =>
		new Map(Object.entries(values).map(([key, value]) => [key, hex(value)]));
	const parsedColors = parse(colors);
	const parsedScopes = parse(scopes);
	return {
		getColor: (colorId: string): Rgba | undefined => parsedColors.get(colorId),
		getScopeForeground: (scope: string): Rgba | undefined => parsedScopes.get(scope)
	};
}

/** A theme with nothing wrong with it, that every test can start from. */
const READABLE_BASE: Record<string, string> = {
	'editor.background': '#000000',
	'editor.foreground': '#FFFFFF'
};

const READABLE_COMMENT: Record<string, string> = { 'comment': '#8C8C8C' };

suite('Primal readability verdict', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a theme with no editor background cannot be measured and says so', () => {
		const verdict = computeThemeReadability(source({ 'editor.foreground': '#FFFFFF' }));
		assert.strictEqual(verdict.level, 'incomplete');
		assert.strictEqual(verdict.errors.length, 0);
		assert.ok(verdict.skipped.includes('editor.background'));
	});

	test('a legible theme with a comment colour comes back clear', () => {
		const verdict = computeThemeReadability(source(READABLE_BASE, READABLE_COMMENT));
		assert.strictEqual(verdict.level, 'clear');
		assert.strictEqual(verdict.errors.length, 0);
		assert.strictEqual(verdict.warnings.length, 0);
	});

	test('a clear verdict is worded as "no problems found", never as "safe"', () => {
		// The wording is load-bearing: these checks are the ones the product's own
		// generator is held to, and passing them is evidence of nothing beyond them.
		const presentation = describeVerdictLevel('clear');
		assert.ok(/no problems found/i.test(presentation.label), presentation.label);
		assert.ok(!/\bsafe\b|\bverified\b|\bpasses\b/i.test(presentation.label), presentation.label);
	});

	test('every level has its own glyph, so no two levels look alike in greyscale', () => {
		const icons = (['unchecked', 'incomplete', 'clear', 'caution', 'fails'] as const)
			.map(level => describeVerdictLevel(level).icon.id);
		assert.strictEqual(new Set(icons).size, icons.length, icons.join(', '));
	});

	test('body text below the WCAG AA floor fails', () => {
		const verdict = computeThemeReadability(source({ ...READABLE_BASE, 'editor.foreground': '#303030' }, READABLE_COMMENT));
		assert.strictEqual(verdict.level, 'fails');
		assert.strictEqual(verdict.errors[0].check, 'editorTextContrast');
	});

	test('a theme that sets no comment colour is flagged, but only advisorily', () => {
		const verdict = computeThemeReadability(source(READABLE_BASE));
		assert.strictEqual(verdict.level, 'caution');
		assert.strictEqual(verdict.warnings[0].check, 'commentMissing');
	});

	test('a comment below the readability floor is an error, not a warning', () => {
		const verdict = computeThemeReadability(source(READABLE_BASE, { 'comment': '#242424' }));
		assert.strictEqual(verdict.level, 'fails');
		assert.ok(verdict.errors.some(finding => finding.check === 'commentContrast'));
	});

	test('a comment between the floors is advisory', () => {
		// #6E6E6E on black: above 3.0, below 4.5.
		const measured = contrastRatio(opaqueOf(hex('#6E6E6E')), opaqueOf(hex('#000000')));
		assert.ok(measured > 3 && measured < 4.5, `fixture sits between the tiers (${measured.toFixed(2)})`);
		const verdict = computeThemeReadability(source(READABLE_BASE, { 'comment': '#6E6E6E' }));
		assert.strictEqual(verdict.level, 'caution');
		assert.ok(verdict.warnings.some(finding => finding.check === 'commentContrast'));
	});

	test('a comment colour is composited over the editor plane before it is measured', () => {
		// At 50% alpha over black, #FFFFFF80 lands mid-grey and clears the floor;
		// measured un-composited it would look like white and pass for the wrong reason.
		const verdict = computeThemeReadability(source(READABLE_BASE, { 'comment': '#FFFFFF80' }));
		assert.strictEqual(verdict.level, 'clear');
	});

	test('two identical severity colours collapse for everyone', () => {
		const verdict = computeThemeReadability(source({
			...READABLE_BASE,
			'editorError.foreground': '#B04A38',
			'editorWarning.foreground': '#B04A38'
		}, READABLE_COMMENT));
		const finding = verdict.errors.find(entry => entry.check === 'semanticSeparation');
		assert.ok(finding, 'the collision is reported');
		assert.strictEqual(finding.observer, 'normal');
	});

	test('a red/green pair a trichromat separates easily still fails for a deuteranope', () => {
		// This is the whole reason the check exists. Verified independently here so
		// the test does not just restate the implementation.
		const red = opaqueOf(hex('#D06060'));
		const green = opaqueOf(hex('#60A060'));
		assert.ok(perceptualDistance(red, green, 'normal') > 40, 'a trichromat sees these as different colours');
		assert.ok(perceptualDistance(red, green, 'deuteranopia') < 11, 'a deuteranope does not');

		const verdict = computeThemeReadability(source({
			...READABLE_BASE,
			'editorError.foreground': '#D06060',
			'editorWarning.foreground': '#60A060'
		}, READABLE_COMMENT));
		const finding = verdict.errors.find(entry => entry.check === 'semanticSeparation');
		assert.ok(finding, 'the collision is reported');
		assert.strictEqual(finding.observer, 'deuteranopia');
	});

	test('a colour a group does not declare is skipped, not measured against a default', () => {
		const verdict = computeThemeReadability(source({
			...READABLE_BASE,
			'editorError.foreground': '#D06060'
		}, READABLE_COMMENT));
		assert.ok(verdict.skipped.includes('editorWarning.foreground'));
		assert.ok(!verdict.errors.some(entry => entry.check === 'semanticSeparation'), 'one member alone has no pair to fail');
	});

	test('two ANSI slots painting the same colour is an error a trichromat sees', () => {
		const colors: Record<string, string> = { ...READABLE_BASE, 'terminal.background': '#000000' };
		const ramp = ['#767676', '#D06060', '#60A060', '#C0A030', '#6080D0', '#B060C0', '#40A0A0', '#D0D0D0',
			'#909090', '#E08080', '#80C080', '#E0C060', '#80A0E0', '#D080E0', '#60C0C0', '#FFFFFF'];
		PRIMAL_ANSI_SLOTS.forEach((slot, index) => { colors[slot] = ramp[index]; });
		colors['terminal.ansiBrightCyan'] = colors['terminal.ansiCyan'];

		const verdict = computeThemeReadability(source(colors, READABLE_COMMENT));
		const finding = verdict.errors.find(entry => entry.check === 'ansiSeparation'
			&& entry.observer === 'normal'
			&& entry.token.includes('terminal.ansiCyan')
			&& entry.token.includes('terminal.ansiBrightCyan'));
		assert.ok(finding, 'the identical pair is reported as an error a trichromat sees');
	});

	test('an ANSI slot illegible on the terminal plane is an error', () => {
		const verdict = computeThemeReadability(source({
			...READABLE_BASE,
			'terminal.background': '#000000',
			'terminal.ansiBlack': '#050505'
		}, READABLE_COMMENT));
		assert.ok(verdict.errors.some(entry => entry.check === 'ansiContrast' && entry.token === 'terminal.ansiBlack'));
	});

	test('the verdict is pure: measuring twice gives the same answer', () => {
		const colors = { ...READABLE_BASE, 'editorError.foreground': '#D06060', 'editorWarning.foreground': '#60A060' };
		const first = computeThemeReadability(source(colors, READABLE_COMMENT));
		const second = computeThemeReadability(source(colors, READABLE_COMMENT));
		assert.deepStrictEqual(first, second);
	});
});
