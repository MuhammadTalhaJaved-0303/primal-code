/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paletteToColors } from '../../common/primalPaletteMapping.js';
import { MAX_IMPORT_BYTES, PrimalImportResult, readImportedTheme } from '../../common/primalThemeImport.js';

function accepted(result: PrimalImportResult): Extract<PrimalImportResult, { ok: true }> {
	assert.ok(result.ok, `expected the document to be accepted, got: ${result.ok ? '' : result.problems.map(problem => problem.message).join('; ')}`);
	return result;
}

function refused(result: PrimalImportResult): readonly string[] {
	assert.ok(!result.ok, 'expected the document to be refused');
	return result.problems.map(problem => problem.message);
}

/** A minimal, valid base16 palette in the JSON encoding. */
const PALETTE_JSON = JSON.stringify({
	system: 'base16',
	name: 'Test Scheme',
	palette: {
		base00: '#181818', base01: '#282828', base02: '#383838', base03: '#585858',
		base04: '#B8B8B8', base05: '#D8D8D8', base06: '#E8E8E8', base07: '#F8F8F8',
		base08: '#AB4642', base09: '#DC9656', base0A: '#F7CA88', base0B: '#A1B56C',
		base0C: '#86C1B9', base0D: '#7CAFC2', base0E: '#BA8BAF', base0F: '#A16946'
	}
});

suite('Primal theme import - refusals', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('nothing pasted is refused', () => {
		assert.ok(refused(readImportedTheme('   ')).length > 0);
	});

	test('an over-long document is refused before it is parsed', () => {
		const huge = '{"colors":{' + '"editor.background":"#000000",'.repeat(20000) + '}}';
		assert.ok(huge.length > MAX_IMPORT_BYTES);
		assert.ok(refused(readImportedTheme(huge))[0].includes('limit'));
	});

	test('malformed JSON is refused with the parser message, not a guess', () => {
		assert.ok(refused(readImportedTheme('{ "colors": ')).length > 0);
	});

	test('a JSON array is refused: a theme is an object', () => {
		assert.ok(refused(readImportedTheme('[1,2,3]')).length > 0);
	});

	test('a theme that inherits from another file is refused', () => {
		// `include` is a relative path the loader would follow: "paste some
		// colours" must not turn into "read a file of the document's choosing".
		const problems = refused(readImportedTheme(JSON.stringify({ include: './base.json', colors: { 'editor.background': '#000000' } })));
		assert.ok(problems[0].includes('inherits'), problems[0]);
	});

	test('a theme pointing its syntax colours at a TextMate file is refused', () => {
		const problems = refused(readImportedTheme(JSON.stringify({ colors: { 'editor.background': '#000000' }, tokenColors: './theme.tmTheme' })));
		assert.ok(problems[0].includes('TextMate'), problems[0]);
	});

	test('a document that is neither a theme nor a palette is refused', () => {
		assert.ok(refused(readImportedTheme(JSON.stringify({ hello: 'world' }))).length > 0);
	});

	test('a theme whose every colour is malformed is refused, and each value is named', () => {
		const problems = refused(readImportedTheme(JSON.stringify({ colors: { 'editor.background': 'rebeccapurple' } })));
		assert.ok(problems.some(message => message.includes('rebeccapurple')), problems.join('; '));
	});
});

suite('Primal theme import - colour themes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a well-formed theme is read, and stores the colour it parsed', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({
			name: 'Nice Theme',
			colors: { 'editor.background': '#101112', 'editor.foreground': '#FAFAFA' }
		})));
		assert.strictEqual(theme.kind, 'colorTheme');
		assert.strictEqual(theme.name, 'Nice Theme');
		assert.strictEqual(theme.colors.get('editor.background'), '#101112');
		assert.strictEqual(theme.parsedColors.get('editor.foreground')?.r, 250);
		assert.strictEqual(theme.problems.length, 0);
	});

	test('a value that validates only once trimmed is stored trimmed, never raw', () => {
		// The bug this guards: the hex was validated after a trim and then stored
		// as written. `Color.fromHex` branches on string LENGTH alone, so
		// "#00ff00 " (8 chars) matches no branch and comes back Color.red, and
		// "#fff " (5) is read as #RGBA with a space for the alpha digit, i.e. fully
		// transparent. The dialog would have measured the trimmed colours, called
		// them readable, and then painted something else entirely.
		const { theme } = accepted(readImportedTheme(JSON.stringify({
			colors: { 'editor.foreground': '#00ff00 ', 'editor.background': '#fff ' }
		})));
		assert.strictEqual(theme.colors.get('editor.foreground'), '#00FF00');
		assert.strictEqual(theme.colors.get('editor.background'), '#FFFFFF');
		for (const [colorId, value] of theme.colors) {
			assert.strictEqual(value.trim(), value, `${colorId} is stored without surrounding whitespace`);
			assert.ok(/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(value), `${colorId} is stored in a form Color.fromHex can read: ${value}`);
		}
	});

	test('a palette slot that validates only once trimmed is stored trimmed too', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({ palette: { base00: '181818 ', base05: '#D8D8D8' } })));
		assert.strictEqual(theme.colors.get('editor.background'), '#181818');
	});

	test('alpha survives canonicalisation', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({ colors: { 'editor.background': '#0000ff80' } })));
		assert.strictEqual(theme.colors.get('editor.background'), '#0000FF80');
	});

	test('a malformed hex is dropped and reported in words, never substituted', () => {
		// Color.fromHex answers an unparseable value with Color.red, which reports a
		// parse failure by hue. Nothing here may do that.
		const { theme } = accepted(readImportedTheme(JSON.stringify({
			colors: { 'editor.background': '#000000', 'editor.foreground': '#GGGGGG' }
		})));
		assert.ok(!theme.colors.has('editor.foreground'), 'the bad value is not carried through');
		const problem = theme.problems.find(entry => entry.at === 'editor.foreground');
		assert.ok(problem, 'the bad value is named');
		assert.ok(problem.message.includes('#GGGGGG'), problem.message);
	});

	test('a colour named by something that is not a colour id is dropped', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({
			colors: { 'editor.background': '#000000', '__proto__.polluted': '#FFFFFF', 'has space': '#FFFFFF' }
		})));
		assert.strictEqual(theme.colors.size, 1);
		assert.strictEqual(theme.problems.length, 2);
	});

	test('a non-string colour value is dropped', () => {
		const { theme } = accepted(readImportedTheme('{"colors":{"editor.background":"#000000","editor.foreground":42}}'));
		assert.ok(!theme.colors.has('editor.foreground'));
	});

	test('alpha is preserved, because a token that carries it is measured with it', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({ colors: { 'editor.background': '#00000080' } })));
		assert.strictEqual(theme.parsedColors.get('editor.background')?.alpha, 128 / 255);
	});

	test('syntax rules contribute their scope foregrounds', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({
			colors: { 'editor.background': '#000000' },
			tokenColors: [{ scope: 'comment, comment.line', settings: { foreground: '#808080' } }]
		})));
		assert.strictEqual(theme.scopeForegrounds.get('comment')?.r, 128);
		assert.strictEqual(theme.scopeForegrounds.get('comment.line')?.r, 128);
	});

	test('a syntax rule with a malformed foreground is skipped and reported', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({
			colors: { 'editor.background': '#000000' },
			tokenColors: [{ scope: 'comment', settings: { foreground: 'grey' } }]
		})));
		assert.strictEqual(theme.scopeForegrounds.size, 0);
		assert.strictEqual(theme.problems.length, 1);
	});

	test('a document with no name still gets one', () => {
		const { theme } = accepted(readImportedTheme(JSON.stringify({ colors: { 'editor.background': '#000000' } })));
		assert.ok(theme.name.length > 0);
	});
});

suite('Primal theme import - palettes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a base16 palette in JSON maps onto the ids it actually specifies', () => {
		const { theme } = accepted(readImportedTheme(PALETTE_JSON));
		assert.strictEqual(theme.kind, 'palette');
		assert.strictEqual(theme.name, 'Test Scheme');
		assert.strictEqual(theme.colors.get('editor.background'), '#181818');
		assert.strictEqual(theme.colors.get('terminal.ansiRed'), '#AB4642');
		assert.strictEqual(theme.colors.get('terminal.ansiBrightBlack'), '#585858');
	});

	test('the same palette as plain "slot: hex" lines reads identically', () => {
		const flat = [
			'# a comment',
			'scheme: "Test Scheme"',
			'base00: "181818"', 'base01: "282828"', 'base02: "383838"', 'base03: "585858"',
			'base04: "B8B8B8"', 'base05: "D8D8D8"', 'base06: "E8E8E8"', 'base07: "F8F8F8"',
			'base08: "AB4642"', 'base09: "DC9656"', 'base0A: "F7CA88"', 'base0B: "A1B56C"',
			'base0C: "86C1B9"', 'base0D: "7CAFC2"', 'base0E: "BA8BAF"', 'base0F: "A16946"'
		].join('\n');
		const { theme } = accepted(readImportedTheme(flat));
		assert.strictEqual(theme.kind, 'palette');
		assert.strictEqual(theme.colors.get('editor.background'), '#181818', 'a bare hex gains its #');
		assert.strictEqual(theme.colors.get('terminal.ansiRed'), '#AB4642');
	});

	test('a corpus scheme with trailing comments on every slot reads normally', () => {
		// The shape 94 of the 533 vendored corpus files ship in, catppuccin-mocha
		// among them. Taking the rest of the line as the value left `"#1e1e2e" # base`
		// as the "colour", every slot was refused as a malformed hex, and the whole
		// import came back "None of the palette's slots held a colour this build
		// could read."
		const corpus = [
			'system: "base24"',
			'name: "Catppuccin Mocha"',
			'author: "https://github.com/catppuccin/catppuccin"',
			'variant: "dark"',
			'palette:',
			'  base00: "#1e1e2e" # base',
			'  base01: "#181825" # mantle',
			'  base02: "#313244" # surface0',
			'  base03: "#45475a" # surface1',
			'  base04: "#585b70" # surface2',
			'  base05: "#cdd6f4" # text',
			'  base08: "#f38ba8" # red',
			'  base10: "#181825" # mantle - darker background',
			'  base12: "#eba0ac" # maroon - bright red'
		].join('\n');
		const { theme } = accepted(readImportedTheme(corpus));
		assert.strictEqual(theme.name, 'Catppuccin Mocha');
		assert.strictEqual(theme.colors.get('editor.background'), '#1E1E2E');
		assert.strictEqual(theme.colors.get('terminal.ansiRed'), '#F38BA8');
		assert.strictEqual(theme.colors.get('terminal.ansiBrightRed'), '#EBA0AC');
	});

	test('an unquoted slot with a trailing comment reads too', () => {
		const { theme } = accepted(readImportedTheme('base00: 181818 # background\nbase05: D8D8D8 # text\n'));
		assert.strictEqual(theme.colors.get('editor.background'), '#181818');
		assert.strictEqual(theme.colors.get('editor.foreground'), '#D8D8D8');
	});

	test('a line the reader does not model is refused rather than skipped', () => {
		// A lenient reader would drop the list and hand back a palette with a
		// plausible missing slot, which is worse than refusing.
		assert.ok(refused(readImportedTheme('base00: "181818"\n  - a list item\n')).length > 0);
	});

	test('a base24 palette overrides the bright ramp with its own slots', () => {
		const palette = new Map<string, string>([
			['base00', '#181818'], ['base05', '#D8D8D8'], ['base03', '#585858'],
			['base08', '#AB4642'], ['base12', '#FF0000']
		]);
		const colors = paletteToColors(palette);
		assert.strictEqual(colors.get('terminal.ansiRed'), '#AB4642');
		assert.strictEqual(colors.get('terminal.ansiBrightRed'), '#FF0000', 'base12 wins over base08');
	});

	test('a slot the palette omits produces no colour, rather than an invented one', () => {
		const colors = paletteToColors(new Map<string, string>([['base00', '#181818']]));
		assert.strictEqual(colors.get('editor.background'), '#181818');
		assert.strictEqual(colors.get('terminal.ansiRed'), undefined);
	});

	test('paletteToColors does not mutate the palette it is given', () => {
		const palette = new Map<string, string>([['base00', '#181818']]);
		paletteToColors(palette);
		assert.strictEqual(palette.size, 1);
	});

	test('ANSI black is never the terminal background it would be invisible against', () => {
		// The bug this guards: the naive shell convention says black is base00, but
		// base00 is terminal.background here — so every imported palette painted an
		// ANSI black at exactly 1.00:1, and this feature's own readability verdict
		// then reported a failure the mapping had manufactured.
		const { theme } = accepted(readImportedTheme(PALETTE_JSON));
		const background = theme.colors.get('terminal.background');
		assert.strictEqual(background, '#181818');
		assert.strictEqual(theme.colors.get('terminal.ansiBlack'), '#282828', 'black is base01, one plane off the editor');
		assert.notStrictEqual(theme.colors.get('terminal.ansiBlack'), background);
		assert.notStrictEqual(theme.colors.get('terminal.ansiBrightBlack'), background);
	});

	test('a base24 background slot is never read as a bright foreground', () => {
		// base10 is "Darker Background" and base11 "The Darkest Background".
		const colors = paletteToColors(new Map<string, string>([
			['base00', '#1E1E2E'], ['base01', '#181825'], ['base03', '#45475A'],
			['base05', '#CDD6F4'], ['base10', '#181825'], ['base11', '#11111B']
		]));
		assert.strictEqual(colors.get('terminal.ansiBrightBlack'), '#45475A', 'bright black is base03');
		assert.ok(![...colors.values()].includes('#11111B'), 'base11 is read by nothing');
	});

	test('a light scheme takes its neutrals from the ink end of its own ramp', () => {
		// base00 is paper in a light scheme, so the dark column would paint ANSI
		// black in white.
		const colors = paletteToColors(new Map<string, string>([
			['base00', '#FFF8E7'], ['base01', '#F7EBD3'], ['base02', '#EAD6B8'],
			['base03', '#C8A77A'], ['base04', '#765B45'], ['base05', '#4A2C20']
		]));
		assert.strictEqual(colors.get('terminal.background'), '#FFF8E7');
		assert.strictEqual(colors.get('terminal.ansiBlack'), '#4A2C20', 'the darkest ink, not the paper');
		assert.strictEqual(colors.get('terminal.ansiBrightBlack'), '#765B45');
		assert.notStrictEqual(colors.get('terminal.ansiBlack'), colors.get('terminal.ansiWhite'));
	});

	test('a palette whose slots are all unreadable is refused', () => {
		assert.ok(refused(readImportedTheme(JSON.stringify({ palette: { base00: 'not a colour' } }))).length > 0);
	});
});
