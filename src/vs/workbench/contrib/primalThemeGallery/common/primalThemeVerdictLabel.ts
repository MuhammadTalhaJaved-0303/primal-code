/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IPrimalReadabilityVerdict, PrimalReadabilityLevel } from './primalThemeReadability.js';

/**
 * How one readability verdict is presented.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a verdict is a WORD plus a DISTINCT
 * GLYPH SHAPE, and never a colour. The obvious implementation — a green dot for
 * a pass, a red one for a fail — reproduces exactly the defect the whole theme
 * generator exists to prevent, and reproduces it for the one reader who cannot
 * see it. So every level below carries a label that stands alone in plain text,
 * and an icon whose silhouette differs from every other level's. Nothing here
 * emits a colour; the card paints these in the inherited foreground.
 */
export interface IPrimalVerdictPresentation {
	/** The word on the card. Reads correctly with the icon stripped out. */
	readonly label: string;
	/** A glyph whose SHAPE distinguishes this level. Never tinted. */
	readonly icon: ThemeIcon;
	/** One sentence for the tooltip and the accessible name. */
	readonly summary: string;
}

/**
 * The word, glyph and one-line summary for a verdict level.
 *
 * The wording is deliberately careful. `clear` says "no problems found", not
 * "verified safe": these are the checks Primal's own generator is held to —
 * editor and comment contrast, semantic separation under three dichromacies, and
 * the ANSI ramp — and passing them is evidence of nothing beyond them. A theme
 * can clear every one of them and still be unpleasant to read.
 */
export function describeVerdictLevel(level: PrimalReadabilityLevel): IPrimalVerdictPresentation {
	switch (level) {
		case 'clear':
			return {
				label: localize('primalVerdict.clear', "No problems found"),
				icon: Codicon.check,
				summary: localize('primalVerdict.clear.summary', "Every readability check that could run, ran, and none found a problem. That is not the same as being verified accessible.")
			};
		case 'caution':
			return {
				label: localize('primalVerdict.caution', "Minor issues"),
				icon: Codicon.warning,
				summary: localize('primalVerdict.caution.summary', "Readable, but something leans on hue where it should lean on lightness. Nothing here misses a hard floor.")
			};
		case 'fails':
			return {
				label: localize('primalVerdict.fails', "Fails checks"),
				icon: Codicon.error,
				summary: localize('primalVerdict.fails.summary', "At least one contrast or separation floor is missed. Applying this theme is fine; knowing what it costs is the point.")
			};
		case 'incomplete':
			return {
				label: localize('primalVerdict.incomplete', "Partly checked"),
				icon: Codicon.dash,
				summary: localize('primalVerdict.incomplete.summary', "The theme leaves out colours the checks read through, so most of them could not run.")
			};
		default:
			return {
				label: localize('primalVerdict.unchecked', "Not checked"),
				icon: Codicon.question,
				summary: localize('primalVerdict.unchecked.summary', "This theme has not been measured yet.")
			};
	}
}

/** A one-line count of what was found, for the tooltip under the summary. */
export function describeVerdictCounts(verdict: IPrimalReadabilityVerdict): string {
	const errors = verdict.errors.length;
	const warnings = verdict.warnings.length;
	if (errors === 0 && warnings === 0) {
		return localize('primalVerdict.counts.none', "No findings.");
	}
	if (errors === 0) {
		return localize('primalVerdict.counts.warnings', "{0} advisory finding(s).", warnings);
	}
	if (warnings === 0) {
		return localize('primalVerdict.counts.errors', "{0} failing check(s).", errors);
	}
	return localize('primalVerdict.counts.both', "{0} failing check(s), {1} advisory finding(s).", errors, warnings);
}
