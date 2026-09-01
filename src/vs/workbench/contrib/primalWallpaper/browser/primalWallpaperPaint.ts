/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { Color } from '../../../../base/common/color.js';
import { Schemas } from '../../../../base/common/network.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { editorForeground, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { IColorTheme } from '../../../../platform/theme/common/themeService.js';

/**
 * Composes the two things the wallpaper layer can paint: the procedural
 * `ambient` wash, and a validated `background-image` value for `image` mode.
 *
 * Everything here is a pure function of the active theme or of the raw setting
 * value — no DOM, no services, no I/O — so the layer contribution stays a thin
 * piece of wiring and this can be reasoned about (and tested) on its own.
 */

/** Edge length of the repeating grain tile, in CSS pixels. */
const GRAIN_TILE_SIZE = 160;

/**
 * Relative alphas of the ambient wash. They describe the *shape* of the
 * gradient only: the layer element's own `opacity` carries the user's clamped
 * intensity, so these never have to be recomputed when the setting changes.
 *
 * These are full-strength on purpose. The layer's opacity (0.12 by default)
 * is what keeps the wash quiet; scaling the stops down as well multiplied the
 * two together and left the ambient at roughly 2% ink, i.e. invisible.
 */
const WASH_ALPHA_NEAR = 1;
const WASH_ALPHA_MID = 0.45;
const WASH_ALPHA_COUNTER = 0.7;

/**
 * The grain, as a `url()` for `background-image`.
 *
 * An inline SVG `feTurbulence` is the standard way to get film grain without
 * shipping an asset: `fractalNoise` with `stitchTiles='stitch'` produces a tile
 * that repeats seamlessly, and `feColorMatrix type='saturate' values='0'`
 * strips the hue so the speckle reads as luminance only — which keeps it
 * correct on light and dark themes alike and introduces no color of its own.
 * The `<rect>` needs no fill: a filter primitive that generates its own result
 * replaces the source graphic entirely.
 *
 * The string is constant, so it is built once and memoized. It is never
 * regenerated on a repaint.
 */
let grainImageValue: string | undefined;

export function getWallpaperGrainImage(): string {
	if (!grainImageValue) {
		const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${GRAIN_TILE_SIZE}' height='${GRAIN_TILE_SIZE}'>`
			+ `<filter id='primalGrain' x='0' y='0' width='100%' height='100%'>`
			+ `<feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/>`
			+ `<feColorMatrix type='saturate' values='0'/>`
			+ `</filter>`
			+ `<rect width='100%' height='100%' filter='url(#primalGrain)'/>`
			+ `</svg>`;

		// `encodeURIComponent` escapes the `#` of the filter reference (which
		// would otherwise terminate the data URI) and leaves the single quotes
		// alone, so the result is safe inside a double-quoted CSS url().
		grainImageValue = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
	}

	return grainImageValue;
}

/**
 * The `ambient` wash: a soft off-center radial pool from the top left plus a
 * quieter counter-pool at the bottom right, both drawn in the *active theme's
 * own* `foreground` color.
 *
 * Deriving the wash from `foreground` rather than from per-vibe values is what
 * makes this work for user themes too: `foreground` always contrasts the
 * theme's background, so the wash lifts a dark ground and deepens a light one
 * without either direction being hardcoded. It is also a luminance-only move —
 * it introduces no hue that the theme did not already have.
 *
 * Both foci sit outside the box so that the two slices of ground that are
 * actually visible — the strip above the slabs and the strip below them — each
 * cut across a real gradient instead of a flat tone.
 *
 * Returns `undefined` when the theme defines neither token, in which case the
 * caller paints nothing rather than guessing a color.
 */
export function composeAmbientWash(theme: IColorTheme): string | undefined {
	const ink = theme.getColor(foreground) ?? theme.getColor(editorForeground);
	if (!ink) {
		return undefined;
	}

	const near = alpha(ink, WASH_ALPHA_NEAR);
	const mid = alpha(ink, WASH_ALPHA_MID);
	const counter = alpha(ink, WASH_ALPHA_COUNTER);

	// The last stop is the same color at zero alpha rather than the
	// `transparent` keyword, so the interpolation never runs through a
	// different hue on its way out.
	const clear = alpha(ink, 0);

	// Both pools keep their bright core inside the viewport. An off-screen core
	// (a negative/over-100% position) leaves only the faint tail visible, which
	// at the default intensity is indistinguishable from a flat ground.
	return `radial-gradient(120% 110% at 18% 6%, ${near} 0%, ${mid} 34%, ${clear} 70%), `
		+ `radial-gradient(100% 95% at 88% 94%, ${counter} 0%, ${clear} 62%)`;
}

function alpha(color: Color, factor: number): string {
	return color.transparent(factor).toString();
}

/**
 * Validates `primalCode.wallpaper.imagePath` and turns it into a URI.
 *
 * Accepted, per atmosphere-spec.md: an absolute filesystem path, a `file:` URI
 * or a `data:` image URI. Everything else — a relative path, an `http(s)` URL,
 * a non-image data URI — is rejected so the chrome never reaches out to the
 * network and never renders something that is not an image.
 *
 * Returns `undefined` for anything it cannot vouch for; it never throws.
 */
export function parseWallpaperImagePath(rawPath: string): URI | undefined {
	const value = rawPath.trim();
	if (!value) {
		return undefined;
	}

	try {
		if (/^data:/i.test(value)) {
			// Only image payloads, and only the `;base64,` / `,` forms.
			return /^data:image\/[a-z0-9.+-]+[;,]/i.test(value) ? URI.parse(value) : undefined;
		}

		if (/^file:/i.test(value)) {
			const uri = URI.parse(value);
			return uri.scheme === Schemas.file && uri.path.length > 1 ? uri : undefined;
		}

		// `isAbsolute` is the platform-appropriate one, so this accepts
		// `/Users/...` on posix and `C:\...` / UNC on Windows, and rejects a
		// bare relative path (which has no workspace to resolve against here).
		return isAbsolute(value) ? URI.file(value) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The `background-image` value for a validated wallpaper URI.
 *
 * `asCSSUrl` (base/browser/cssValue.ts) is the workbench's own route from a URI
 * to a CSS url(): it runs the URI through `FileAccess.uriToBrowserUri`, which
 * rewrites a `file:` resource to the `vscode-file://vscode-app` form the
 * renderer is actually allowed to load, and then escapes it. A raw `file:` URL
 * would be blocked by the workbench content security policy.
 */
export function toWallpaperImageValue(uri: URI): string {
	return asCSSUrl(uri);
}
