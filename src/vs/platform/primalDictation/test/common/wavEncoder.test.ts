/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WAV_HEADER_BYTES, encodeWav } from '../../common/wavEncoder.js';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readUint16(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

suite('Primal dictation - WAV framing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const pcm = new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x10, 0x20]);

	test('wraps the samples in a 44-byte RIFF/WAVE header', () => {
		const wav = encodeWav(pcm, 16000);

		assert.strictEqual(WAV_HEADER_BYTES, 44);
		assert.strictEqual(wav.length, 44 + pcm.length);
		assert.strictEqual(ascii(wav, 0, 4), 'RIFF');
		assert.strictEqual(ascii(wav, 8, 4), 'WAVE');
		assert.strictEqual(ascii(wav, 12, 4), 'fmt ');
		assert.strictEqual(ascii(wav, 36, 4), 'data');
	});

	test('declares 16-bit mono PCM at the rate it was handed', () => {
		const wav = encodeWav(pcm, 16000);

		assert.strictEqual(readUint32(wav, 16), 16, 'fmt chunk size');
		assert.strictEqual(readUint16(wav, 20), 1, 'PCM format tag');
		assert.strictEqual(readUint16(wav, 22), 1, 'channel count');
		assert.strictEqual(readUint32(wav, 24), 16000, 'sample rate');
		assert.strictEqual(readUint32(wav, 28), 32000, 'byte rate');
		assert.strictEqual(readUint16(wav, 32), 2, 'block align');
		assert.strictEqual(readUint16(wav, 34), 16, 'bits per sample');
	});

	test('the two size fields agree with the payload', () => {
		const wav = encodeWav(pcm, 16000);

		assert.strictEqual(readUint32(wav, 4), 36 + pcm.length, 'RIFF chunk size');
		assert.strictEqual(readUint32(wav, 40), pcm.length, 'data chunk size');
	});

	test('copies the samples through untouched', () => {
		const wav = encodeWav(pcm, 16000);

		assert.deepStrictEqual(Array.from(wav.subarray(44)), Array.from(pcm));
	});

	test('a silent recording is still a valid file', () => {
		const wav = encodeWav(new Uint8Array(0), 16000);

		assert.strictEqual(wav.length, 44);
		assert.strictEqual(readUint32(wav, 40), 0);
		assert.strictEqual(readUint32(wav, 4), 36);
	});

	test('carries a different sample rate through both rate fields', () => {
		const wav = encodeWav(pcm, 24000);

		assert.strictEqual(readUint32(wav, 24), 24000);
		assert.strictEqual(readUint32(wav, 28), 48000);
	});

	test('refuses samples that are not whole 16-bit frames', () => {
		assert.throws(() => encodeWav(new Uint8Array([0x01]), 16000), /16-bit/);
	});

	test('refuses a sample rate that could not have come from a microphone', () => {
		assert.throws(() => encodeWav(pcm, 0), /sample rate/i);
		assert.throws(() => encodeWav(pcm, -16000), /sample rate/i);
		assert.throws(() => encodeWav(pcm, 16000.5), /sample rate/i);
	});
});
