/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Primal Code — wallpaper layer (`primal/design/atmosphere-spec.md`, section B).
 *
 * Names shared between the settings registration, the layer contribution and
 * `media/primalWallpaper.css`. Nothing here touches the DOM or a service, so
 * both sides of the feature agree on one spelling of every key.
 */

/** How the ground is painted. Mirrors the `primalCode.wallpaper.mode` enum. */
export type PrimalWallpaperMode = 'ambient' | 'image' | 'off';

export const PRIMAL_WALLPAPER_MODE_SETTING_ID = 'primalCode.wallpaper.mode';
export const PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID = 'primalCode.wallpaper.imagePath';
export const PRIMAL_WALLPAPER_OPACITY_SETTING_ID = 'primalCode.wallpaper.opacity';
export const PRIMAL_WALLPAPER_TINT_SLABS_SETTING_ID = 'primalCode.wallpaper.tintSlabs';

/** Every setting the layer reacts to, for the `onDidChangeConfiguration` filter. */
export const PRIMAL_WALLPAPER_SETTING_IDS: readonly string[] = Object.freeze([
	PRIMAL_WALLPAPER_MODE_SETTING_ID,
	PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID,
	PRIMAL_WALLPAPER_OPACITY_SETTING_ID,
	PRIMAL_WALLPAPER_TINT_SLABS_SETTING_ID
]);

export const PRIMAL_WALLPAPER_MODES: readonly PrimalWallpaperMode[] = Object.freeze(['ambient', 'image', 'off'] as const);

export const PRIMAL_WALLPAPER_DEFAULT_MODE: PrimalWallpaperMode = 'ambient';
export const PRIMAL_WALLPAPER_DEFAULT_IMAGE_PATH = '';
export const PRIMAL_WALLPAPER_DEFAULT_OPACITY = 0.12;
export const PRIMAL_WALLPAPER_DEFAULT_TINT_SLABS = false;

/**
 * The ceiling exists so no setting can make the chrome unreadable
 * (atmosphere-spec.md, "Intensity"). It is enforced both in the JSON schema
 * and in {@link clampWallpaperOpacity}, because settings files are edited by
 * hand and a hand-edited value reaches us unvalidated.
 */
export const PRIMAL_WALLPAPER_MIN_OPACITY = 0;
export const PRIMAL_WALLPAPER_MAX_OPACITY = 0.35;

/** The single layer element appended to each workbench container. */
export const PRIMAL_WALLPAPER_LAYER_CLASS = 'primal-wallpaper';

/** On the container while the layer actually paints something. */
export const PRIMAL_WALLPAPER_ON_CLASS = 'primal-wallpaper-on';

/** On the container while `primalCode.wallpaper.tintSlabs` is enabled. */
export const PRIMAL_WALLPAPER_TINT_CLASS = 'primal-wallpaper-tint';

/** Custom properties the contribution writes onto the layer element. */
export const PRIMAL_WALLPAPER_IMAGE_PROPERTY = '--primal-wallpaper-image';
export const PRIMAL_WALLPAPER_GRAIN_PROPERTY = '--primal-wallpaper-grain';
export const PRIMAL_WALLPAPER_SIZE_PROPERTY = '--primal-wallpaper-size';
export const PRIMAL_WALLPAPER_OPACITY_PROPERTY = '--primal-wallpaper-opacity';

/** The CSS-wide keyword for "no background image". */
export const PRIMAL_WALLPAPER_NO_IMAGE = 'none';

/**
 * Clamps a raw settings value into `0…0.35`. Anything that is not a finite
 * number (a string, `null`, `NaN` from a hand-edited settings file) falls back
 * to the default rather than producing an invalid CSS opacity.
 */
export function clampWallpaperOpacity(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return PRIMAL_WALLPAPER_DEFAULT_OPACITY;
	}

	return Math.min(PRIMAL_WALLPAPER_MAX_OPACITY, Math.max(PRIMAL_WALLPAPER_MIN_OPACITY, value));
}

/** Narrows a raw settings value to a known mode, defaulting to `ambient`. */
export function toWallpaperMode(value: unknown): PrimalWallpaperMode {
	return PRIMAL_WALLPAPER_MODES.find(mode => mode === value) ?? PRIMAL_WALLPAPER_DEFAULT_MODE;
}
