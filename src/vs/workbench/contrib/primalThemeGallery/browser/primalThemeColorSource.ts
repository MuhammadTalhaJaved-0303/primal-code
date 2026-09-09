/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { tryParseHexColor, type Rgba } from '../../../../base/common/primalColorScience.js';
import { ColorIdentifier } from '../../../../platform/theme/common/colorRegistry.js';
import { ITextMateThemingRule, IWorkbenchColorTheme } from '../../../services/themes/common/workbenchThemeService.js';
import { IPrimalThemeColorSource } from '../common/primalThemeReadability.js';

/**
 * Adapters that let the readability checks read a theme.
 *
 * Two shapes need measuring: a theme the workbench has loaded (colours already
 * parsed into `Color` objects), and a theme JSON a user pasted in (colours still
 * hex strings, and possibly malformed). Both end up behind the same
 * {@link IPrimalThemeColorSource} so there is one set of checks.
 */

/** The scopes a rule declares, whether written as a string list or an array. */
function scopesOf(rule: ITextMateThemingRule): readonly string[] {
	const scope = rule.scope;
	if (typeof scope === 'string') {
		return scope.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
	}
	return Array.isArray(scope) ? scope : [];
}

/**
 * Reads a loaded workbench theme.
 *
 * `useDefault: false` matters: a colour the theme does not set must answer
 * `undefined` so the check is skipped, rather than being measured against the
 * workbench default the theme's author never chose.
 *
 * A caveat worth stating plainly: by the time a theme is loaded, an unparseable
 * hex in its JSON has already been turned into `Color.red` by
 * `colorThemeData.ts`. Nothing downstream — including this — can tell that apart
 * from a theme that really did ask for red. The import path in
 * `primalThemeImport.ts` parses hexes itself, which is where a malformed value
 * is caught and reported in words.
 */
export function createLoadedThemeColorSource(theme: IWorkbenchColorTheme): IPrimalThemeColorSource {
	return {
		getColor(colorId: string): Rgba | undefined {
			const color = theme.getColor(colorId as ColorIdentifier, false);
			if (!color) {
				return undefined;
			}
			const { r, g, b, a } = color.rgba;
			return { r, g, b, alpha: a };
		},
		getScopeForeground(scope: string): Rgba | undefined {
			for (const rule of theme.tokenColors) {
				if (rule.settings?.foreground && scopesOf(rule).includes(scope)) {
					return tryParseHexColor(rule.settings.foreground);
				}
			}
			return undefined;
		}
	};
}

/**
 * Reads a plain colour map — the shape a pasted theme JSON reduces to after its
 * every value has been validated. Values that failed to parse must be dropped by
 * the caller before they get here, never substituted.
 */
export function createColorMapSource(colors: ReadonlyMap<string, Rgba>, scopeForegrounds: ReadonlyMap<string, Rgba>): IPrimalThemeColorSource {
	return {
		getColor: (colorId: string): Rgba | undefined => colors.get(colorId),
		getScopeForeground: (scope: string): Rgba | undefined => scopeForegrounds.get(scope)
	};
}
