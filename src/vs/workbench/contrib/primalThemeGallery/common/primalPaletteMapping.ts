/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { relativeLuminance, tryParseHexColor } from '../../../../base/common/primalColorScience.js';

/**
 * The base16 / base24 palette vocabulary, and the conventional mapping from it
 * onto workbench colour ids.
 *
 * WHAT THIS IS NOT: it is not a second copy of `primal/theme/generateTheme.ts`.
 * That file turns a 33-slot seed into ~449 workbench colours through a semantic
 * ladder, reads its token map off disk, and is build-time by construction. This
 * is the small, conventional slot-to-role mapping that base16 itself publishes —
 * the one every base16 shell template uses — applied to the handful of ids that
 * define an editor plane and a terminal ramp.
 *
 * Being honest about the difference matters: an imported palette gives a user
 * the palette's own colours in the places the palette actually specifies. It
 * does not give them a generated Primal theme, and the UI must not imply it does.
 */

/** The sixteen base16 slots, in canonical order. */
export const BASE16_SLOTS: readonly string[] = [
	'base00', 'base01', 'base02', 'base03', 'base04', 'base05', 'base06', 'base07',
	'base08', 'base09', 'base0A', 'base0B', 'base0C', 'base0D', 'base0E', 'base0F'
];

/** The eight further slots a base24 scheme adds: an explicit bright ANSI ramp. */
export const BASE24_EXTRA_SLOTS: readonly string[] = [
	'base10', 'base11', 'base12', 'base13', 'base14', 'base15', 'base16', 'base17'
];

/** Every slot either system may declare. */
export const ALL_PALETTE_SLOTS: readonly string[] = [...BASE16_SLOTS, ...BASE24_EXTRA_SLOTS];

/** One workbench colour id and the palette slot it takes its value from. */
interface ISlotBinding {
	readonly colorId: string;
	/** Slots tried in order; the first the palette declares wins. */
	readonly slots: readonly string[];
}

/**
 * The planes and the chromatic half of the ANSI ramp.
 *
 * The six chromatic slots go in SGR order. A base24 scheme overrides the bright
 * half with the slots it declares for exactly that purpose, which is why each
 * bright binding lists the base24 slot first.
 *
 * base10 and base11 are deliberately absent. base24 names them "Darker
 * Background" and "The Darkest Background" — they are further background planes,
 * not foregrounds, and reading base10 as bright black paints terminal output in
 * a shade of the terminal's own background. `primal/theme/importPalette.ts` says
 * the same thing of them: they "are read by nothing here".
 */
const PLANE_AND_CHROMATIC_BINDINGS: readonly ISlotBinding[] = [
	{ colorId: 'editor.background', slots: ['base00'] },
	{ colorId: 'editor.foreground', slots: ['base05'] },
	{ colorId: 'terminal.background', slots: ['base00'] },
	{ colorId: 'terminal.foreground', slots: ['base05'] },
	{ colorId: 'terminal.ansiRed', slots: ['base08'] },
	{ colorId: 'terminal.ansiGreen', slots: ['base0B'] },
	{ colorId: 'terminal.ansiYellow', slots: ['base0A'] },
	{ colorId: 'terminal.ansiBlue', slots: ['base0D'] },
	{ colorId: 'terminal.ansiMagenta', slots: ['base0E'] },
	{ colorId: 'terminal.ansiCyan', slots: ['base0C'] },
	{ colorId: 'terminal.ansiBrightRed', slots: ['base12', 'base08'] },
	{ colorId: 'terminal.ansiBrightGreen', slots: ['base14', 'base0B'] },
	{ colorId: 'terminal.ansiBrightYellow', slots: ['base13', 'base0A'] },
	{ colorId: 'terminal.ansiBrightBlue', slots: ['base16', 'base0D'] },
	{ colorId: 'terminal.ansiBrightMagenta', slots: ['base17', 'base0E'] },
	{ colorId: 'terminal.ansiBrightCyan', slots: ['base15', 'base0C'] }
];

/**
 * The four ANSI neutrals — the one place this mapping departs from the naive
 * base16 shell convention, and it has to.
 *
 * The convention says ANSI black is base00. But base00 is ALSO
 * `terminal.background` in the table above, so spec-black would be painted in
 * exactly the terminal's background colour: 1.00:1, invisible, on every palette
 * ever imported — and then reported as an error by this very feature's
 * readability verdict, a failure manufactured by the mapping rather than found
 * in the palette. `primal/theme/importPalette.ts` reached the same conclusion
 * for the build-time importer and documents the table followed here: black is
 * base01 (one plane off the editor, which is what the shipping dark vibes do)
 * and bright black is base03.
 *
 * The convention is also written for dark schemes only. On a light scheme base00
 * is the paper and the ramp darkens towards base07, so the dark column would
 * paint ANSI black in white. The light column therefore walks the neutral ramp
 * the other way, keeping all four neutrals as inks on paper and keeping them
 * distinct from one another.
 *
 * Unlike the build-time importer, nothing here lifts a neutral whose own palette
 * left it too dark to read, and nothing blends two slots into a third: an
 * imported palette gives the user the palette's own colours in the places the
 * palette specifies, and the verdict reports honestly what they measure.
 */
const DARK_NEUTRAL_BINDINGS: readonly ISlotBinding[] = [
	{ colorId: 'terminal.ansiBlack', slots: ['base01', 'base02', 'base03'] },
	{ colorId: 'terminal.ansiBrightBlack', slots: ['base03', 'base04'] },
	{ colorId: 'terminal.ansiWhite', slots: ['base05', 'base06'] },
	{ colorId: 'terminal.ansiBrightWhite', slots: ['base07', 'base06'] }
];

/** The same four, for a scheme whose base00 is paper rather than ink. */
const LIGHT_NEUTRAL_BINDINGS: readonly ISlotBinding[] = [
	{ colorId: 'terminal.ansiBlack', slots: ['base05', 'base06', 'base07'] },
	{ colorId: 'terminal.ansiBrightBlack', slots: ['base04', 'base05'] },
	{ colorId: 'terminal.ansiWhite', slots: ['base03', 'base02'] },
	{ colorId: 'terminal.ansiBrightWhite', slots: ['base02', 'base01'] }
];

/** The ids whose colour is printed ON the terminal background, and so may not BE it. */
const TERMINAL_FOREGROUND_IDS: ReadonlySet<string> = new Set([
	...PLANE_AND_CHROMATIC_BINDINGS.map(binding => binding.colorId),
	...DARK_NEUTRAL_BINDINGS.map(binding => binding.colorId)
].filter(colorId => colorId.startsWith('terminal.') && colorId !== 'terminal.background'));

/** Case-insensitive, so `#1E1E2E` and `#1e1e2e` are recognised as one colour. */
function isSameColorText(first: string | undefined, second: string | undefined): boolean {
	return first !== undefined && second !== undefined && first.toUpperCase() === second.toUpperCase();
}

/** Which end of its own ramp a palette's background sits at. */
export type PrimalPaletteMode = 'dark' | 'light';

/**
 * Reads the palette's mode off its own slots rather than off the `variant:` key,
 * which is free text a scheme may omit or get wrong.
 *
 * base00 is the background and base05 the default foreground in both systems, so
 * a background lighter than its own text is a light scheme. A palette that
 * declares neither is treated as dark, which is what the shell convention
 * assumes and what all but a handful of the corpus are.
 */
export function paletteMode(palette: ReadonlyMap<string, string>): PrimalPaletteMode {
	const background = tryParseHexColor(palette.get('base00') ?? '');
	const foreground = tryParseHexColor(palette.get('base05') ?? '');
	if (!background || !foreground) {
		return 'dark';
	}
	return relativeLuminance(background) > relativeLuminance(foreground) ? 'light' : 'dark';
}

/**
 * Turns a validated palette into the workbench colours it actually specifies.
 *
 * Returns a new map; the input is never touched. Slots the palette omits simply
 * produce no entry — nothing is invented to fill a gap.
 */
export function paletteToColors(palette: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
	const neutrals = paletteMode(palette) === 'light' ? LIGHT_NEUTRAL_BINDINGS : DARK_NEUTRAL_BINDINGS;
	const terminalBackground = palette.get('base00');
	const colors = new Map<string, string>();
	for (const binding of [...PLANE_AND_CHROMATIC_BINDINGS, ...neutrals]) {
		const printedOnTheBackground = TERMINAL_FOREGROUND_IDS.has(binding.colorId);
		for (const slot of binding.slots) {
			const value = palette.get(slot);
			if (value === undefined) {
				continue;
			}
			// A slot the palette happens to have set to its own background colour
			// is not a colour to print in: it is 1.00:1, invisible, and it would be
			// reported as an error the mapping had manufactured. Some schemes really
			// do declare base01 == base00. Try the next slot the palette offers, and
			// if there is none, leave the id alone rather than paint it invisible.
			if (printedOnTheBackground && isSameColorText(value, terminalBackground)) {
				continue;
			}
			colors.set(binding.colorId, value);
			break;
		}
	}
	return colors;
}
