/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	compositeOverSrgb,
	contrastRatio,
	formatHexColor,
	lightnessWeight,
	opaqueOf,
	perceptualDistance,
	rgbToLab,
	CVD_TYPES,
	OBSERVERS,
	type CvdType,
	type Observer,
	type Rgb,
	type Rgba
} from '../../../../base/common/primalColorScience.js';
import { localize } from '../../../../nls.js';
import {
	MIN_ANSI_CONTRAST,
	MIN_ANSI_DELTA_E,
	MIN_COMMENT_CONTRAST_ERROR,
	MIN_COMMENT_CONTRAST_WARN,
	MIN_EDITOR_TEXT_CONTRAST,
	MIN_SEMANTIC_DELTA_E,
	PRIMAL_ANSI_SLOTS,
	PRIMAL_COMMENT_SCOPES,
	PRIMAL_REQUIRED_COLORS,
	PRIMAL_SEMANTIC_GROUPS,
	type IPrimalSemanticGroup
} from './primalReadabilityRules.js';

/**
 * Everything the verdict needs from a theme, expressed so that a loaded
 * workbench theme, a pasted theme JSON and a test fixture can all supply it.
 *
 * A colour that the theme does not define answers `undefined`; the check that
 * wanted it is skipped and named in {@link IPrimalReadabilityVerdict.skipped}
 * rather than being measured against a default the theme never chose.
 */
export interface IPrimalThemeColorSource {
	/** The colour the theme declares for a workbench colour id, alpha intact. */
	getColor(colorId: string): Rgba | undefined;
	/** The foreground the theme declares for a TextMate scope, alpha intact. */
	getScopeForeground(scope: string): Rgba | undefined;
}

/** How readable a theme turned out to be. */
export type PrimalReadabilityLevel =
	/** Nothing has been measured yet (the theme has not been loaded). */
	| 'unchecked'
	/** The theme omits a colour the checks read through, so most of them could not run. */
	| 'incomplete'
	/** Every check that could run, ran, and none of them found a problem. */
	| 'clear'
	/** Only advisory findings: readable, but leaning on hue somewhere. */
	| 'caution'
	/** At least one hard floor is missed. */
	| 'fails';

/** Which rule produced a finding. Stable ids so callers can group and filter. */
export type PrimalReadabilityCheck =
	| 'editorTextContrast'
	| 'commentContrast'
	| 'commentMissing'
	| 'semanticSeparation'
	| 'lightnessSeparation'
	| 'ansiContrast'
	| 'ansiSeparation';

/** One measured shortfall. */
export interface IPrimalReadabilityFinding {
	readonly check: PrimalReadabilityCheck;
	/** The colour id, scope or pair at fault — what an author would have to edit. */
	readonly token: string;
	/** What was measured, with units. */
	readonly measured: string;
	/** The bar it had to clear. */
	readonly threshold: string;
	/** One line of plain English for the person who has to act on it. */
	readonly detail: string;
	/** For a check measured under several observers: the one the measurement came from. */
	readonly observer?: Observer;
}

/** The result of measuring one theme. */
export interface IPrimalReadabilityVerdict {
	readonly level: PrimalReadabilityLevel;
	readonly errors: readonly IPrimalReadabilityFinding[];
	readonly warnings: readonly IPrimalReadabilityFinding[];
	/** Colour ids the theme does not define, whose checks were therefore skipped. */
	readonly skipped: readonly string[];
}

/** The verdict for a theme nothing has been measured on yet. */
export const PRIMAL_UNCHECKED_VERDICT: IPrimalReadabilityVerdict = Object.freeze({
	level: 'unchecked' as const,
	errors: Object.freeze([]),
	warnings: Object.freeze([]),
	skipped: Object.freeze([])
});

/** Human-readable name for one semantic group, for a finding a user reads. */
function semanticGroupName(id: string): string {
	switch (id) {
		case 'diagnostics': return localize('primalReadability.group.diagnostics', "diagnostic squiggles");
		case 'problemsPanel': return localize('primalReadability.group.problemsPanel', "Problems panel icons");
		case 'notifications': return localize('primalReadability.group.notifications', "notification icons");
		case 'debugConsole': return localize('primalReadability.group.debugConsole', "debug console severities");
		case 'overviewRulerDiagnostics': return localize('primalReadability.group.overviewRulerDiagnostics', "overview ruler diagnostics");
		case 'gutterDiff': return localize('primalReadability.group.gutterDiff', "gutter diff bars");
		case 'overviewRulerDiff': return localize('primalReadability.group.overviewRulerDiff', "overview ruler diff marks");
		case 'sourceControl': return localize('primalReadability.group.sourceControl', "source control decorations");
		case 'diffText': return localize('primalReadability.group.diffText', "diff editor text");
		case 'diffLines': return localize('primalReadability.group.diffLines', "diff editor lines");
		case 'statusBarSeverities': return localize('primalReadability.group.statusBarSeverities', "status bar severities");
		case 'listSeverities': return localize('primalReadability.group.listSeverities', "list severities");
		case 'inputValidation': return localize('primalReadability.group.inputValidation', "input validation borders");
		default: return id;
	}
}

/** The name of one observer, for a finding a user reads. */
function observerName(observer: Observer): string {
	switch (observer) {
		case 'protanopia': return localize('primalReadability.observer.protanopia', "a protanope");
		case 'deuteranopia': return localize('primalReadability.observer.deuteranopia', "a deuteranope");
		case 'tritanopia': return localize('primalReadability.observer.tritanopia', "a tritanope");
		default: return localize('primalReadability.observer.normal', "a trichromat");
	}
}

/**
 * Flattens a theme colour onto the plane it is painted over.
 *
 * Compositing runs in gamma-encoded sRGB because that is what the browser the
 * workbench runs in actually does with a CSS alpha — see `compositeOverSrgb`.
 * The build-time validator measures the same way, so the two never disagree.
 */
function resolveOpaque(source: IPrimalThemeColorSource, colorId: string, base: Rgb | undefined): Rgb | undefined {
	const declared = source.getColor(colorId);
	if (!declared) {
		return undefined;
	}
	if (declared.alpha >= 1 || !base) {
		return opaqueOf(declared);
	}
	return compositeOverSrgb(declared, base);
}

/** The dL* that on its own is worth {@link MIN_SEMANTIC_DELTA_E} at this lightness. */
function requiredLightnessDelta(lBar: number): number {
	return MIN_SEMANTIC_DELTA_E * lightnessWeight(lBar);
}

function ratio(value: number): string {
	return localize('primalReadability.ratio', "{0}:1", value.toFixed(2));
}

function ratioFloor(value: number): string {
	return localize('primalReadability.ratioFloor', "at least {0}:1", value.toFixed(1));
}

interface ICheckContext {
	readonly source: IPrimalThemeColorSource;
	readonly errors: IPrimalReadabilityFinding[];
	readonly warnings: IPrimalReadabilityFinding[];
	readonly skipped: string[];
	readonly editorBackground: Rgb;
}

function checkEditorText(context: ICheckContext): void {
	const foreground = resolveOpaque(context.source, 'editor.foreground', context.editorBackground);
	if (!foreground) {
		context.skipped.push('editor.foreground');
		return;
	}
	const measured = contrastRatio(foreground, context.editorBackground);
	if (measured >= MIN_EDITOR_TEXT_CONTRAST) {
		return;
	}
	context.errors.push({
		check: 'editorTextContrast',
		token: 'editor.foreground / editor.background',
		measured: localize('primalReadability.contrastOn', "{0} ({1} on {2})", ratio(measured), formatHexColor(foreground), formatHexColor(context.editorBackground)),
		threshold: ratioFloor(MIN_EDITOR_TEXT_CONTRAST),
		detail: localize('primalReadability.editorText', "Body text in the editor is below the WCAG AA floor for normal-size text.")
	});
}

function checkComments(context: ICheckContext): void {
	let scope: string | undefined;
	let declared: Rgba | undefined;
	for (const candidate of PRIMAL_COMMENT_SCOPES) {
		const found = context.source.getScopeForeground(candidate);
		if (found) {
			scope = candidate;
			declared = found;
			break;
		}
	}

	if (!scope || !declared) {
		context.warnings.push({
			check: 'commentMissing',
			token: `tokenColors "${PRIMAL_COMMENT_SCOPES[0]}"`,
			measured: localize('primalReadability.commentNone', "no rule sets a comment foreground"),
			threshold: localize('primalReadability.commentWanted', "a foreground for the comment scope"),
			detail: localize('primalReadability.commentInherits', "Comments inherit the editor foreground and lose their de-emphasis.")
		});
		return;
	}

	const comment = declared.alpha >= 1 ? opaqueOf(declared) : compositeOverSrgb(declared, context.editorBackground);
	const measured = contrastRatio(comment, context.editorBackground);
	if (measured >= MIN_COMMENT_CONTRAST_WARN) {
		return;
	}
	const failsHardFloor = measured < MIN_COMMENT_CONTRAST_ERROR;
	const finding: IPrimalReadabilityFinding = {
		check: 'commentContrast',
		token: `tokenColors "${scope}" / editor.background`,
		measured: localize('primalReadability.contrastOn', "{0} ({1} on {2})", ratio(measured), formatHexColor(comment), formatHexColor(context.editorBackground)),
		threshold: ratioFloor(failsHardFloor ? MIN_COMMENT_CONTRAST_ERROR : MIN_COMMENT_CONTRAST_WARN),
		detail: failsHardFloor
			? localize('primalReadability.commentUnreadable', "Comments are below the readability floor: this is the classic unreadable-theme failure.")
			: localize('primalReadability.commentDim', "Comments clear the readability floor but not the WCAG AA floor for normal-size text.")
	};
	if (failsHardFloor) {
		context.errors.push(finding);
	} else {
		context.warnings.push(finding);
	}
}

/** Resolves the members of one semantic group that the theme actually defines. */
function resolveGroup(context: ICheckContext, group: IPrimalSemanticGroup): ReadonlyArray<readonly [string, Rgb]> {
	const base = group.over
		? resolveOpaque(context.source, group.over, context.editorBackground) ?? context.editorBackground
		: context.editorBackground;
	const members: [string, Rgb][] = [];
	for (const token of group.tokens) {
		const colour = resolveOpaque(context.source, token, base);
		if (colour) {
			members.push([token, colour]);
		} else {
			context.skipped.push(token);
		}
	}
	return members;
}

function checkSemanticSeparation(context: ICheckContext): void {
	for (const group of PRIMAL_SEMANTIC_GROUPS) {
		const members = resolveGroup(context, group);
		const groupName = semanticGroupName(group.id);

		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				const [tokenA, colourA] = members[i];
				const [tokenB, colourB] = members[j];
				const pair = `${tokenA} / ${tokenB}`;

				let worstObserver: Observer = 'normal';
				let worstDistance = Number.POSITIVE_INFINITY;
				for (const observer of OBSERVERS) {
					const distance = perceptualDistance(colourA, colourB, observer);
					if (distance < worstDistance) {
						worstDistance = distance;
						worstObserver = observer;
					}
				}

				if (worstDistance < MIN_SEMANTIC_DELTA_E) {
					context.errors.push({
						check: 'semanticSeparation',
						token: pair,
						measured: localize('primalReadability.deltaUnder', "{0} dE00 for {1} ({2} / {3})", worstDistance.toFixed(2), observerName(worstObserver), formatHexColor(colourA), formatHexColor(colourB)),
						threshold: localize('primalReadability.deltaFloor', "at least {0} dE00 for every observer", MIN_SEMANTIC_DELTA_E),
						observer: worstObserver,
						detail: worstObserver === 'normal'
							? localize('primalReadability.semanticNormal', "These {0} read as the same colour even to a trichromat.", groupName)
							: localize('primalReadability.semanticCvd', "These {0} collapse together for {1}; they need separating by lightness, not hue.", groupName, observerName(worstObserver))
					});
				}

				const lightnessA = rgbToLab(colourA).l;
				const lightnessB = rgbToLab(colourB).l;
				const delta = Math.abs(lightnessA - lightnessB);
				const required = requiredLightnessDelta((lightnessA + lightnessB) / 2);
				if (delta < required) {
					context.warnings.push({
						check: 'lightnessSeparation',
						token: pair,
						measured: localize('primalReadability.lightnessMeasured', "{0} L* apart ({1} / {2})", delta.toFixed(1), formatHexColor(colourA), formatHexColor(colourB)),
						threshold: localize('primalReadability.lightnessFloor', "at least {0} L* apart", required.toFixed(1)),
						detail: localize('primalReadability.lightnessDetail', "These {0} lean on hue for part of their separation, and hue is the channel a colour-blind reader loses.", groupName)
					});
				}
			}
		}
	}
}

function checkAnsiRamp(context: ICheckContext): void {
	const terminalBackground = resolveOpaque(context.source, 'terminal.background', context.editorBackground) ?? context.editorBackground;
	const slots: [string, Rgb][] = [];
	for (const token of PRIMAL_ANSI_SLOTS) {
		const colour = resolveOpaque(context.source, token, terminalBackground);
		if (colour) {
			slots.push([token, colour]);
		} else {
			context.skipped.push(token);
		}
	}

	for (const [token, colour] of slots) {
		const measured = contrastRatio(colour, terminalBackground);
		if (measured < MIN_ANSI_CONTRAST) {
			context.errors.push({
				check: 'ansiContrast',
				token,
				measured: localize('primalReadability.contrastOn', "{0} ({1} on {2})", ratio(measured), formatHexColor(colour), formatHexColor(terminalBackground)),
				threshold: ratioFloor(MIN_ANSI_CONTRAST),
				detail: localize('primalReadability.ansiContrastDetail', "Terminal output printed in this colour is not legible against the terminal background.")
			});
		}
	}

	for (let i = 0; i < slots.length; i++) {
		for (let j = i + 1; j < slots.length; j++) {
			const [tokenA, colourA] = slots[i];
			const [tokenB, colourB] = slots[j];

			// The split is on the TRICHROMAT measurement, not on whichever observer
			// scored lowest. Simulating a dichromat almost always shrinks a distance,
			// so filing a pair under its worst observer would relabel every ordinary
			// collision as "a dichromat cannot escape this" and demote it. Whether a
			// trichromat can tell the two slots apart is the pass/fail question; which
			// observer scored worst is reporting detail. A red/green collision that
			// only a dichromat sees is a property of the ANSI convention itself, which
			// no repalette can fix, so it is advisory.
			const normalDistance = perceptualDistance(colourA, colourB, 'normal');
			let cvdObserver: CvdType = CVD_TYPES[0];
			let cvdDistance = Number.POSITIVE_INFINITY;
			for (const observer of CVD_TYPES) {
				const distance = perceptualDistance(colourA, colourB, observer);
				if (distance < cvdDistance) {
					cvdDistance = distance;
					cvdObserver = observer;
				}
			}

			const trichromatCollides = normalDistance < MIN_ANSI_DELTA_E;
			if (!trichromatCollides && cvdDistance >= MIN_ANSI_DELTA_E) {
				continue;
			}
			const observer: Observer = trichromatCollides ? 'normal' : cvdObserver;
			const distance = trichromatCollides ? normalDistance : cvdDistance;
			const finding: IPrimalReadabilityFinding = {
				check: 'ansiSeparation',
				token: `${tokenA} / ${tokenB}`,
				measured: localize('primalReadability.deltaUnder', "{0} dE00 for {1} ({2} / {3})", distance.toFixed(2), observerName(observer), formatHexColor(colourA), formatHexColor(colourB)),
				threshold: localize('primalReadability.deltaFloor', "at least {0} dE00 for every observer", MIN_ANSI_DELTA_E),
				observer,
				detail: trichromatCollides
					? localize('primalReadability.ansiNormal', "Two ANSI slots paint the same colour for everyone, so the meaning a program encodes in them is lost.")
					: localize('primalReadability.ansiCvd', "Two ANSI slots collide for {0}, so the meaning a program encodes in them is lost.", observerName(observer))
			};
			if (trichromatCollides) {
				context.errors.push(finding);
			} else {
				context.warnings.push(finding);
			}
		}
	}
}

/**
 * Measures one theme and returns a verdict.
 *
 * Pure: it reads the source and returns findings; it never mutates its argument
 * and never touches a service. The wording the UI puts on the result must stay
 * honest — a `clear` verdict means "none of these checks found a problem", not
 * "this theme is verified accessible". These are the checks the product's own
 * generator is held to, and they are not the whole of readability.
 */
export function computeThemeReadability(source: IPrimalThemeColorSource): IPrimalReadabilityVerdict {
	const errors: IPrimalReadabilityFinding[] = [];
	const warnings: IPrimalReadabilityFinding[] = [];
	const skipped: string[] = [];

	const editorBackground = resolveOpaque(source, 'editor.background', undefined);
	if (!editorBackground) {
		return {
			level: 'incomplete',
			errors: [],
			warnings: [],
			skipped: [...PRIMAL_REQUIRED_COLORS]
		};
	}

	const context: ICheckContext = { source, errors, warnings, skipped, editorBackground };
	checkEditorText(context);
	checkComments(context);
	checkSemanticSeparation(context);
	checkAnsiRamp(context);

	const missesRequired = PRIMAL_REQUIRED_COLORS.some(colorId => skipped.includes(colorId));
	let level: PrimalReadabilityLevel;
	if (errors.length > 0) {
		level = 'fails';
	} else if (missesRequired) {
		level = 'incomplete';
	} else if (warnings.length > 0) {
		level = 'caution';
	} else {
		level = 'clear';
	}

	return { level, errors, warnings, skipped };
}
