/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../../../base/common/buffer.js';

/**
 * Primal Code - the landmass mask the `world` motif samples.
 *
 * WHAT THIS IS. An equirectangular land/sea coverage raster, 256 columns of
 * longitude by 128 rows of latitude, inlined as base64. Column 0 is 180W and
 * row 0 is 90N, so cell (x, y) covers 1.40625 degrees of longitude and 1.40625
 * degrees of latitude - about 155km at the equator.
 *
 * PROVENANCE. Rasterised from Natural Earth's `ne_110m_land` vector layer.
 * Natural Earth is public domain: "no permission is needed to use Natural Earth.
 * Crediting the authors is unnecessary." The rasteriser sampled each cell 8x8
 * with an even-odd scanline fill, which handles the rings' holes (the Caspian,
 * the Great Lakes) without caring about winding order, and quantised the
 * resulting coverage to two bits.
 *
 * WHY TWO BITS AND NOT ONE. A one-bit mask at this resolution is a 50%
 * threshold, and a threshold deletes every island smaller than a cell - Britain
 * thins, Japan breaks up, Iceland and Sri Lanka disappear. Four levels keep
 * their mass as partial coverage, which is exactly what a tonal silhouette
 * wants, for 4KB more source. Eight bits would be another 21KB for detail that
 * the runtime blur below immediately throws away.
 *
 * WHY IT IS BLURRED AT RUNTIME AND NOT BAKED. The right amount of blur is a
 * property of the *sampling*, not of the map: a globe drawn at 35 buffer pixels
 * of radius packs about 1.2 mask columns into every pixel at the equator and
 * far more of them near the poles, where the columns converge. Prefiltering by
 * that footprint is what stops the coastlines crawling and shimmering as the
 * sphere turns, and the footprint changes when the window does, so the mip is
 * rebuilt with the geometry rather than shipped with the asset.
 *
 * There are no borders, no graticule, no cities and no place names here, and
 * there is nowhere for them to be added: this is one coverage channel.
 */

/** Columns of longitude. A power of two, so the sampler wraps with a mask rather than a modulo. */
export const GLOBE_MASK_WIDTH = 256;

/** Rows of latitude, from 90N at row 0 to 90S at row 127. */
export const GLOBE_MASK_HEIGHT = 128;

/** Cells per packed byte, at two bits each. */
const CELLS_PER_BYTE = 4;

/** The value one quantisation step is worth, scaling the two bits to a full byte. */
const LEVEL_STEP = 85;

/**
 * The mask itself. Split only so the lines stay readable; it is one string.
 */
const GLOBE_MASK_BASE64: readonly string[] = [
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABalVQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAABWr///+lVlZf////qQFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABqqq///qr',
	'//////////+kAAAAAAAVUAAAABUAAAAAAAAAGpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAW/7//lBv//////////4AAAAAAGr6qQA',
	'AAAAAAAAAAAAAAr9UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQBUpVW/+Qb///////////8AAAAAAAL9JAAAAAAAAAAAAAAAAAAWgAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAACqVGAFlqWqqAAv//////////+AAAAAAAAUAAAAAAAAAAVZAAAAAAAX+qUAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAa+pBpYuq+AAAAAv////////gAAAAAAAAAAAAAAAAAK5QAAAABr////6AAAAAH6hUAAAAAAAAAAAAAAAAAAAB+pAAUFSoFFVAAAAA////',
	'////kAAAAAAAAAAAAAAAAAfQAAAAGq/////6VUBUAABQAAAAAAAAAAAAAAAAAAAAB/r+qtG90P/6pAAAAH///////gAAAAAAAAAAAAAAAAAu',
	'AAAtFW///////////gACqpQAAAAAAIAAAAWlAAAAAABRu//kFfS///7UAAAb//////tAAAAAAAAAABqQAAAAGkAB/b////////////+u7//+',
	'VlAAAAEAAAC////6UVu6pSv//hq5AuVv/wAAKv/////5AAAAAAAAACv/+UAAAAACkb5////////////////////mlSql5AAb///////////5',
	'VuVZv9fwFf5QAAv////pQAAAAAAAAAb////+QoGqu/6/P/////////////////////////6kBb/////////////////+oBH/+gAP///+AAAA',
	'QAAAAAAf////r5af/////b////////////////////////9b5C//////////////////9kBr/1kAB//+QAAC/+AAAAAAv/4f/4R/////////',
	'////////////////////////AEQAb////////////////lekVb/gAAP//AAAAKpAAAAAB//5v//r////////////////////////////////',
	'+AAAB/////////////////QAUVUaUAAAv+AAAAAAAAAAAL//g/////////////////////////////////+//+kAAAv//77////////////Q',
	'AAB/5AAAACvgAAAAAAAAAAH//0L///////////////////////////////1Zv/kAAAARv/2kFb//////////gAAAf/gUAAAAQAAAAAAAAAAB',
	'///AZb////////////////////////////rwC5QAAAAAAAX4AAAKv////////+AAAH/+vQAAAAAAAAAAAACQAKT/AD//////////////////',
	'/////////0AAAH0AAAAAAAAGSQAAAC/////////6QAAv//8AAAAAAAAAAAAB9AAJfgK///////////////////////////gAAAL/AAAAAAAA',
	'VAAAAAAL//////////lAf///0AAAAAAAAAAAALgAHaQD//////////////////////////+QAAAH/QAAAAAAAQAAAAAAEv//////////0f//',
	'//0AAAAAAAAAAB4eAB6m7///////////////////////////5RAAB/QAAAAAAAAAAAAAAAS//////////+D/////QAAAAAAAAAAtf4L/////',
	'//////////////////////////+gAAOQAAAAAAAAAAAAAAAAL//////////6////+kAAAAAAAAAAEH+b////////////////////////////',
	'////cAABAAAAAAAAAAAAAAAAACr/////////////lkdAAAAAAAAAAABBf////////////////////////////////zQAAAAAAAAAAAAAAAAA',
	'AAACf///////////+vAP9AAAAAAAAAAAK/////////////////////////////////4gAAAAAAAAAAAAAAAAAAAAAf////////////v0AFQA',
	'AAAAAAAAAAv////////6//+v///////////////////4IAAAAAAAAAAAAAAAAAAAAAD/////////////6oAAAAAAAAAAAAAD///v///S1//0',
	'H///////////////////4AAAAAAAAAAAAAAAAAAAAAAB/////////////iQAAAAAAAAAAAAAA//7w///QEL/4L///////////////////4B1',
	'AAAAAAAAAAAAAAAAAAAAAf///////////+AAAAAAAAAAAAAAH//1RfC//wAAb/Bv/////////////////+UBuAAAAAAAAAAAAAAAAAAAAAH/',
	'//////////+QAAAAAAAAAAAAAB//4ARuH/9W5G/4G/////////////////9AAUAAAAAAAAAAAAAAAAAAAAAB///////////9AAAAAAAAAAAA',
	'AAAf/wAMB0+G/////R///////////////9a9AAHAAAAAAAAAAAAAAAAAAAAAAL//////////+AAAAAAAAAAAAAAAL/4ABAIHg/////wL////',
	'//////////4APQACgAAAAAAAAAAAAAAAAAAAAAA//////////+AAAAAAAAAAAAAAABv5AVUYAkL////+S///////////////qB8AG0AAAAAA',
	'AAAAAAAAAAAAAAAAH//////////wAAAAAAAAAAAAAAABQf/+AAAAER///////////////////9APBb8AAAAAAAAAAAAAAAAAAAAAAAb/////',
	'////kAAAAAAAAAAAAAAAAv///QAAAAEv///////////////////QBBrkAAAAAAAAAAAAAAAAAAAAAAAAv////////QAAAAAAAAAAAAAAAB//',
	'//9QAQAAP///////////////////8AClAAAAAAAAAAAAAAAAAAAAAAAAADv///////QAAAAAAAAAAAAAAAAv/////QvlFH//////////////',
	'//////gAUAAAAAAAAAAAAAAAAAAAAAAAAAAZ/////5awAAAAAAAAAAAAAAAAP//////v//////r////////////////4AAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAABb///kEAOAAAAAAAAAAAAAAAAL/////////+v//0v///////////////+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAdv//gAACwA',
	'AAAAAAAAAAAAAAf//////////i///C///////////////+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAi//4AAAcAAAAAAAAAAAAAAAf////////',
	'//9P//5Bb//////////////QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFL/+AAAAEAAAAAAAAAAAAAAL///////////x///h0AB////////////',
	'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQv/QAAFQAAAAAAAAAAAAAAL///////////9H////gAH//////////+CQAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAD/4ABBGkAAAAAAAAAAAAAD////////////1////9AAf///5L///7kAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAA//AHwAHgAAAAA',
	'AAAAAAAAv///////////9L///9AABf//4B///ggAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAH/5G4AABuAAAAAAAAAAAAL////////////gv',
	'//+AAAH//0AH//0oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//9AAUBBAAAAAAAAAAAC////////////9D//9AAAA//0AAv//AAAcAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAGq/VAAAAAAAAAAAAAAAAv////////////wv/0AAAAL/gAAJv/4AAKAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAL/4AAAAAAAAAAAAAAAf////////////+L/gAAAAA/wAAAH//gABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG+AAAAAAAAAAAAA',
	'AAD/////////////95AAAAAAP8AAAA7/4AAWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALgABUAAAAAAAAAAAAv/////////////gBQAAA',
	'AB+AAAAMP+AAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AL7plAAAAAAAAAAB/////////////+r0AAAAAPgAAACBuAAEJAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAACmX+//gAAAAAAAAAAL//////////////8AAAAAC2AAAAgFAAABIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAGL////QAAAAAAAAAB//////////////+AAAAAABwAAAFAAAAAvAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////9QAAAAAAAAAC/',
	'/+v//////////AAAAAAAIAAAAoAABgCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/////gAAAAAAAAAHlkB7/////////QAAAAAAAAA',
	'AKLQAB9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////+AAAAAAAAAAAAAAf////////gAAAAAAAAAAB54AB+AAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAC//////wAAAAAAAAAAAAAH////////QAAAAAAAAAAAHrAH/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC',
	'//////9AAAAAAAAAAAAAB////////QAAAAAAAAAAAAvQL/4ZRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB///////5AAAAAAAAAAAAAv/',
	'//////AAAAAAAAAAAAAC4B/9FQAZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf///////9QAAAAAAAAAAAH///////QAAAAAAAAAAAAAfgL',
	'/HgACSkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/////////0AAAAAAAAAAAf//////QAAAAAAAAAAAAAB9AWhsAUq/5ABAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAC//////////kAAAAAAAAAAC//////gAAAAAAAAAAAAAAHQAAJQAAb/4BQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/////',
	'/////AAAAAAAAAAAf/////4AAAAAAAAAAAAAAAKVAAAAAQv/hQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAC//////////0AAAAAAAAAAC//////',
	'AAAAAAAAAAAAAAAAW5AAAAAL+sAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/////////8AAAAAAAAAAAv/////wAAAAAAAAAAAAAAAAABVFAA',
	'AGCgABQAAAAAAAAAAAAAAAAAAAAAAAAAAAB/////////8AAAAAAAAAAAH/////+AAAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAP////////9AAAAAAAAAAAB//////gAAAAAAAAAAAAAAAAAAAABpAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB////////9A',
	'AAAAAAAAAAA//////8AKAAAAAAAAAAAAAAAAAAB/wHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL////////QAAAAAAAAAAAf//////AHgAA',
	'AAAAAAAAAAAAAAAt/4B9AAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAf///////0AAAAAAAAAAAL//////Qb0AAAAAAAAAAAAAAAAAv//gvQAA',
	'AAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAv//////8AAAAAAAAAAAC/////+AL9AAAAAAAAAAAAAAAAA////v8AAAAAAAgAAAAAAAAAAAAAAAAA',
	'AAAAAAAAD//////+AAAAAAAAAAAAP////9AC/AAAAAAAAAAAAAAAAAv/////QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA///////QAAAAAA',
	'AAAAAC////+AAvgAAAAAAAAAAAAAAAG//////+AAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////gAAAAAAAAAAAAP////wAf0AAAAAAAA',
	'AAAAAAAf///////0AAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////+QAAAAAAAAAAAAC////9AD8AAAAAAAAAAAAAAAP////////QAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAB/////0AAAAAAAAAAAAAAv///+AAuAAAAAAAAAAAAAAAH////////9AAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAf////4AAAAAAAAAAAAAAH///9AAAAAAAAAAAAAAAAAAB/////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH////9AAAAAAAAAAAAAA',
	'A////QAAAAAAAAAAAAAAAAAAP////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/////AAAAAAAAAAAAAAAH///gAAAAAAAAAAAAAAAAA',
	'AB/////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAv////QAAAAAAAAAAAAAAAv//gAAAAAAAAAAAAAAAAAAAf////////wAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAP////QAAAAAAAAAAAAAAAD//wAAAAAAAAAAAAAAAAAAAC//+W////4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//',
	'//gAAAAAAAAAAAAAAAA//gAAAAAAAAAAAAAAAAAAAAv/gAH///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB///qgAAAAAAAAAAAAAAAAGQAA',
	'AAAAAAAAAAAAAAAAAAALkAAAn//9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAv//9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAf//AAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAf///QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//gAAAAAkAAAAAAAAAAA',
	'AAAAAAAAAAAAAAH//6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFVAAAAAAPgAAAAAAAAAAAAAAAAAAAAAAAAB//4AAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAAAAAAv/kAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAtAAAAAKQAAAAAAAAAAAAAAAAAAAAAAAAAG/9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQ',
	'AAAALQAAAAAAAAAAAAAAAAAAAAAAAAAC/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQAAAAAAAAAAAAAAAAA',
	'AAAAAAAAB/9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQAAAAAAAAAAAAAAAAAAAAAAAAAAf/gAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAf8ABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAC+QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK9AAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	'AAAAAAAAAAAAAAAAAAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC1AAAA',
	'AAAAAAAAAAAAAAAAAAAAAAG/kAAAAABZVRb9W/lWqqvVqQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAQAa/',
	'//6+kABv//////////////+UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOv0AAAAAAAAAAAAAAAAQEVQAFum//////9Ba////////////////',
	'//6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX7/QAAAAAAAAAAAUVVa/v//v/////////+B/////////////////////qpAAAAAAAAAAAAAAAAA',
	'AAAGlABAAAFl/4AAAAAAAAAABv//////////////////6///////////////////////0AAAAAAAAAAAAAAUFVUABvq//qqm//+AAAAAAAAA',
	'AH//////////////////////////////////////////+kAAAAAAAAAAVq//////+qq////////kAAAAAAAAAAb/////////////////////',
	'/////////////////////9AAAAAAAAAAFv///////////////+qUAAAAAAAAAav///////////////////////////////////////////9A',
	'AAAAAABRv//////////////////oAAAAABpABr//////////////////////////////////////////////1AAAAAAAZAVb////////////',
	'////kAAAAAH/wAZX////////////////////////////////////////////+UAAAAAAAAAVVv////////////////+lFZAalQAVq///////',
	'//////////////////////////////////////QAAAAAAAAABv////////////////////6QWv+v////////////////////////////////',
	'///////////////+UAAAABUAAAK///////////////////////////////////////////////////////////////////////////5UAP//',
	'+pVVUW////////////////////////////////////////////////////////////////////////////7/////////////////////////',
	'////////////////////////////////////////////////////////////////////////////////////////////////////////////',
	'////////////////////////////////////////////////////////////////////////////////////////////////////////////',
	'//////////////8='
];

let coverage: Uint8Array | undefined;

/**
 * The unfiltered mask, as one byte of coverage per cell.
 *
 * Decoded once per window and then shared: it is immutable, it is 32KB, and
 * every surface and every rebuild wants the same bytes.
 */
export function getGlobeMask(): Uint8Array {
	if (!coverage) {
		const packed = decodeBase64(GLOBE_MASK_BASE64.join('')).buffer;
		const cells = GLOBE_MASK_WIDTH * GLOBE_MASK_HEIGHT;
		const decoded = new Uint8Array(cells);

		for (let i = 0; i < cells; i++) {
			const shift = 6 - 2 * (i & (CELLS_PER_BYTE - 1));
			decoded[i] = ((packed[i >> 2] >> shift) & 3) * LEVEL_STEP;
		}

		coverage = decoded;
	}

	return coverage;
}

/**
 * The mask prefiltered for one particular globe size.
 *
 * `rowWidth` is the box width, in mask columns, that each row was filtered
 * with. The projection hands it back per pixel to decide how much further a
 * pixel whose footprint is wider than that - anything approaching the limb -
 * has to dissolve towards `rowMean`.
 */
export interface IGlobeMaskMip {
	readonly coverage: Uint8Array;
	readonly rowMean: Uint8Array;
	readonly rowWidth: Uint8Array;
}

/** The narrowest cosine the filter width is allowed to divide by, near the poles. */
const MIN_LATITUDE_COSINE = 0.06;

/** How much of a pixel's footprint the horizontal filter spans. */
const FILTER_FOOTPRINT = 0.8;

/** The smallest radius the filter will size itself against, so a collapsed layout cannot divide by zero. */
const MIN_RADIUS = 4;

/**
 * Builds the mip for a globe of `rx` by `ry` buffer pixels.
 *
 * Horizontally this is a circular box blur whose width follows the sampling
 * density - `1 / cos(latitude)` wider with every row towards a pole, where the
 * columns converge on a point. Vertically it is a three tap smooth weighted by
 * how many mask rows land in one screen pixel, which is what keeps a small
 * globe from stepping between latitude rows.
 *
 * Costs one pass over 32K cells with a running sum, so it is linear in the mask
 * and independent of the blur width. It runs on `create` and on a resize that
 * actually changed the globe's size, never on a frame.
 */
export function buildGlobeMaskMip(rx: number, ry: number): IGlobeMaskMip {
	const source = getGlobeMask();
	const width = GLOBE_MASK_WIDTH;
	const wrap = width - 1;
	const blurred = new Float32Array(width * GLOBE_MASK_HEIGHT);
	const result = new Uint8Array(width * GLOBE_MASK_HEIGHT);
	const rowMean = new Uint8Array(GLOBE_MASK_HEIGHT);
	const rowWidth = new Uint8Array(GLOBE_MASK_HEIGHT);

	const columnsPerPixel = width / (2 * Math.PI * Math.max(MIN_RADIUS, rx));
	const maxRadius = width >> 2;

	for (let y = 0; y < GLOBE_MASK_HEIGHT; y++) {
		const latitude = (0.5 - (y + 0.5) / GLOBE_MASK_HEIGHT) * Math.PI;
		const cosine = Math.max(MIN_LATITUDE_COSINE, Math.cos(latitude));
		const radius = Math.max(1, Math.min(maxRadius, Math.round(FILTER_FOOTPRINT * columnsPerPixel / cosine)));
		const span = 2 * radius + 1;
		const row = y * width;

		let running = 0;
		let total = 0;
		for (let k = -radius; k <= radius; k++) {
			running += source[row + ((k + width) & wrap)];
		}

		for (let x = 0; x < width; x++) {
			blurred[row + x] = running / span;
			total += source[row + x];
			running += source[row + ((x + radius + 1) & wrap)] - source[row + ((x - radius + width) & wrap)];
		}

		rowMean[y] = Math.round(total / width);
		rowWidth[y] = Math.min(255, span);
	}

	// One mask row per screen pixel needs no vertical filtering; several rows per
	// pixel need all of them, so the neighbours' weight is the row density itself.
	const neighbour = Math.min(1, 0.5 * GLOBE_MASK_HEIGHT / (Math.PI * Math.max(MIN_RADIUS, ry)));
	const scale = 1 / (1 + 2 * neighbour);

	for (let y = 0; y < GLOBE_MASK_HEIGHT; y++) {
		const here = y * width;
		const above = Math.max(0, y - 1) * width;
		const below = Math.min(GLOBE_MASK_HEIGHT - 1, y + 1) * width;

		for (let x = 0; x < width; x++) {
			result[here + x] = Math.round((blurred[here + x] + neighbour * (blurred[above + x] + blurred[below + x])) * scale);
		}
	}

	return { coverage: result, rowMean, rowWidth };
}
