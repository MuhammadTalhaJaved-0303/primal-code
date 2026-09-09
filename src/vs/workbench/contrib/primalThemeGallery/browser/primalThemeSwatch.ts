/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../base/common/color.js';
import { ColorIdentifier } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkbenchColorTheme } from '../../../services/themes/common/workbenchThemeService.js';

/**
 * The three colours one card's mini palette preview is painted from.
 *
 * Every value is a CSS colour the theme itself declares. The Start page's vibe
 * strip inlines six hardcoded seed triples because it has to preview a vibe
 * before the theme is loaded; the gallery does not — it waits for the theme and
 * asks the theme. That matters beyond tidiness: vibe seed colours are already
 * mirrored in four places in this repository, and a gallery that grows to a
 * hundred themes cannot be a fifth.
 */
export interface IPrimalSwatchColors {
	/** The editor plane. */
	readonly editor: string;
	/** The chrome plane the editor slab rises off. */
	readonly chrome: string;
	/** A single mark, taken from the theme's own text colour. */
	readonly accent: string;
}

/** Colour ids tried in order for each of the three swatch planes. */
const EDITOR_PLANE: readonly string[] = ['editor.background'];
const CHROME_PLANE: readonly string[] = ['editorGroupHeader.tabsBackground', 'sideBar.background', 'activityBar.background', 'editor.background'];
const ACCENT: readonly string[] = ['editor.foreground', 'foreground', 'editorLineNumber.activeForeground'];

function firstDeclared(theme: IWorkbenchColorTheme, colorIds: readonly string[]): Color | undefined {
	for (const colorId of colorIds) {
		const color = theme.getColor(colorId as ColorIdentifier, false);
		if (color) {
			return color;
		}
	}
	return undefined;
}

/**
 * The swatch for a theme, or `undefined` when the theme has not been loaded or
 * declares none of the planes.
 *
 * `undefined` is a real answer the card must render in words. Substituting a
 * plausible colour would show the user a preview of a theme that does not exist.
 */
export function swatchForTheme(theme: IWorkbenchColorTheme): IPrimalSwatchColors | undefined {
	const editor = firstDeclared(theme, EDITOR_PLANE);
	if (!editor) {
		return undefined;
	}
	const chrome = firstDeclared(theme, CHROME_PLANE) ?? editor;
	const accent = firstDeclared(theme, ACCENT);
	if (!accent) {
		return undefined;
	}
	return {
		editor: editor.toString(),
		chrome: chrome.toString(),
		accent: accent.toString()
	};
}
