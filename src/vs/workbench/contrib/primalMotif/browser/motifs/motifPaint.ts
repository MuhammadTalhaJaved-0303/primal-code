/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../../base/common/color.js';
import { IMotifHost, IMotifPalette, isMotifCanvas } from '../primalMotif.js';

/**
 * Primal Code - the two things every motif has to settle before it can paint:
 * what it paints with, and what it paints into.
 *
 * THE INK RULE, IN ONE PLACE. `globe.ts` states the doctrine in its header:
 * "One token: foreground, at a varying alpha. Land, sea, terminator, limb,
 * atmosphere and the wash behind them are all the same ink; the picture is
 * carried entirely by luminance." Every motif in this folder obeys it, so the
 * rule lives here rather than being restated - and re-derived, and eventually
 * got wrong - in each of them. {@link readMotifInk} is the whole of it:
 * `foreground`, or `descriptionForeground` under a theme that defines no
 * foreground at all, which is the same ink at a lower strength.
 *
 * `palette.accent` is NOT a fallback and must never become one. It resolves to
 * `focusBorder`, which is a saturated hue in four of the six shipping vibes, and
 * a second hue in the ground is the one thing here that a colour blind reader
 * could not see. A motif handed a palette that offers nothing but the accent
 * declines to paint - `create()` returns false, the scheduler records the
 * refusal against that motif and that palette, and the ground keeps the
 * wallpaper's own wash. Declining is a supported answer; inventing a colour is
 * not. `test/browser/motifRegistry.test.ts` asserts this for every registered
 * motif, so a new motif cannot ship without it.
 */

/**
 * Parses one resolved theme token.
 *
 * `Color.Format.CSS.parse` throws on malformed input rather than returning
 * null, and a palette's strings arrive from the scheduler as whatever the theme
 * had - so this is a boundary, and it is guarded like one.
 */
export function parseMotifToken(value: string): Color | undefined {
	if (!value) {
		return undefined;
	}

	try {
		return Color.Format.CSS.parse(value) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * The one ink a motif is allowed: `foreground`, falling back to
 * `descriptionForeground`, and to nothing else at all.
 *
 * `undefined` means this palette cannot supply ink, and the caller must decline
 * to paint. See this file's header for why the accent is not a third chance.
 */
export function readMotifInk(palette: IMotifPalette): Color | undefined {
	return parseMotifToken(palette.ink) ?? parseMotifToken(palette.dim);
}

/**
 * The 2D context of the host's canvas, or `undefined` when there is not one.
 *
 * A refusal rather than {@link IMotifHost.fail}: a context that would not
 * initialise is a fact about this surface, not a lost graphics context, and the
 * scheduler already has a path for a motif that declines. The element check is
 * not paranoia - the scheduler hands a `css` motif a `<div>`, and a canvas built
 * in another window fails a plain `instanceof`, which is what
 * {@link isMotifCanvas} exists for.
 */
export function acquireMotifContext(host: IMotifHost): CanvasRenderingContext2D | undefined {
	const element = host.element;
	if (!isMotifCanvas(element)) {
		return undefined;
	}

	// `alpha: true` is the default and is stated because every motif here
	// depends on it: the ground below belongs to the workbench, and a motif
	// lays ink onto it rather than replacing it.
	return element.getContext('2d', { alpha: true }) ?? undefined;
}

/** The usual three-argument clamp. Shared so five motifs do not each keep one. */
export function clampMotif(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}

/**
 * A positive remainder, so a wrap works for a negative offset too. `%` in
 * JavaScript keeps the sign of the dividend, which is never what a treadmill
 * wants.
 */
export function wrapMotif(value: number, span: number): number {
	const wrapped = value % span;
	return wrapped < 0 ? wrapped + span : wrapped;
}
