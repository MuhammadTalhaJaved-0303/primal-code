/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Primal Code - the ground the `world` motif's globe stands in.
 *
 * The scheduler's seam drops the wallpaper's own `background-image` while a
 * motif holds the ground (media/primalMotif.css), so the motif owes the ground
 * whatever that wash was giving it. This reproduces the geometry of
 * `composeAmbientWash` in primalWallpaper/browser/primalWallpaperPaint.ts - a
 * bright pool at 18% 6% and a counter pool at 88% 94% - as one alpha byte per
 * buffer pixel rather than as a CSS gradient, so turning the world motif on
 * changes what is in the ground without changing its character.
 *
 * It is alpha only. The wash is one token, `foreground`, at three strengths;
 * which ink those bytes end up painted in is the renderer's business, and that
 * is what lets this table be computed once and shared by every window.
 */

const WASH_NEAR_X = 0.18;
const WASH_NEAR_Y = 0.06;
const WASH_NEAR_RADIUS_X = 1.20;
const WASH_NEAR_RADIUS_Y = 1.10;
const WASH_NEAR_ALPHA = 1.0;
const WASH_NEAR_MID_STOP = 0.34;
const WASH_NEAR_MID_ALPHA = 0.45;
const WASH_NEAR_END_STOP = 0.70;

const WASH_FAR_X = 0.88;
const WASH_FAR_Y = 0.94;
const WASH_FAR_RADIUS_X = 1.00;
const WASH_FAR_RADIUS_Y = 0.95;
const WASH_FAR_ALPHA = 0.70;
const WASH_FAR_END_STOP = 0.62;


interface IWashMap {
	readonly width: number;
	readonly height: number;
	readonly alpha: Uint8Array;
}

let washMap: IWashMap | undefined;

/** `t` is the fraction of a pool's radius; the result is that pool's alpha there. */
const nearPoolAlpha = (t: number): number => {
	if (t <= WASH_NEAR_MID_STOP) {
		return WASH_NEAR_ALPHA + (WASH_NEAR_MID_ALPHA - WASH_NEAR_ALPHA) * (t / WASH_NEAR_MID_STOP);
	}
	if (t >= WASH_NEAR_END_STOP) {
		return 0;
	}
	return WASH_NEAR_MID_ALPHA * (1 - (t - WASH_NEAR_MID_STOP) / (WASH_NEAR_END_STOP - WASH_NEAR_MID_STOP));
};

const farPoolAlpha = (t: number): number => t >= WASH_FAR_END_STOP ? 0 : WASH_FAR_ALPHA * (1 - t / WASH_FAR_END_STOP);

/**
 * The wash, as one alpha byte per buffer pixel.
 *
 * It depends on nothing but the fixed 640x360 buffer - the ink it is painted in
 * is applied later - so it is built once for the life of the window and shared
 * by every surface and every rebuild.
 */
export const getWashMap = (width: number, height: number): Uint8Array => {
	if (washMap && washMap.width === width && washMap.height === height) {
		return washMap.alpha;
	}

	const alpha = new Uint8Array(width * height);
	const nearX = WASH_NEAR_X * width;
	const nearY = WASH_NEAR_Y * height;
	const farX = WASH_FAR_X * width;
	const farY = WASH_FAR_Y * height;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const nearDx = (x - nearX) / (WASH_NEAR_RADIUS_X * width);
			const nearDy = (y - nearY) / (WASH_NEAR_RADIUS_Y * height);
			const farDx = (x - farX) / (WASH_FAR_RADIUS_X * width);
			const farDy = (y - farY) / (WASH_FAR_RADIUS_Y * height);

			const near = nearPoolAlpha(Math.sqrt(nearDx * nearDx + nearDy * nearDy));
			const far = farPoolAlpha(Math.sqrt(farDx * farDx + farDy * farDy));

			// Source-over of one ink onto itself: the pools add without ever
			// exceeding the ceiling either of them could reach alone.
			alpha[y * width + x] = Math.round(255 * (near + far * (1 - near)));
		}
	}

	washMap = { width, height, alpha };
	return alpha;
};
