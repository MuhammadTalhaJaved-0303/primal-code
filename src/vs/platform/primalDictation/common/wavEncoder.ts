/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The microphone already hands us signed 16-bit mono samples at a known rate,
 * which is exactly what a WAV file holds. Every speech API we talk to wants a
 * file rather than a raw buffer, so the only thing missing is the 44-byte
 * RIFF/WAVE header that says what the samples are.
 */

export const WAV_HEADER_BYTES = 44;

const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const CHANNEL_COUNT = 1;
const PCM_FORMAT_TAG = 1;
const FMT_CHUNK_BYTES = 16;

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) {
		view.setUint8(offset + i, text.charCodeAt(i));
	}
}

/**
 * Wraps raw PCM in a WAV container. Returns a new buffer; the samples handed in
 * are never touched.
 */
export function encodeWav(pcm16: Uint8Array, sampleRate: number): Uint8Array {
	if (pcm16.length % BYTES_PER_SAMPLE !== 0) {
		throw new Error(`Dictation audio is not made of whole 16-bit samples (${pcm16.length} bytes).`);
	}
	if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
		throw new Error(`Dictation audio has an impossible sample rate: ${sampleRate}.`);
	}

	const wav = new Uint8Array(WAV_HEADER_BYTES + pcm16.length);
	const view = new DataView(wav.buffer);
	const byteRate = sampleRate * CHANNEL_COUNT * BYTES_PER_SAMPLE;

	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, WAV_HEADER_BYTES - 8 + pcm16.length, true);
	writeAscii(view, 8, 'WAVE');

	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, FMT_CHUNK_BYTES, true);
	view.setUint16(20, PCM_FORMAT_TAG, true);
	view.setUint16(22, CHANNEL_COUNT, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, CHANNEL_COUNT * BYTES_PER_SAMPLE, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);

	writeAscii(view, 36, 'data');
	view.setUint32(40, pcm16.length, true);
	wav.set(pcm16, WAV_HEADER_BYTES);

	return wav;
}
