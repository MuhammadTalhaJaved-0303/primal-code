/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildTranscriptionRequest, parseTranscriptionResponse } from '../../common/transcriptionRequest.js';
import { ITranscriptionCapability } from '../../common/transcriptionProviders.js';
import { WAV_HEADER_BYTES } from '../../common/wavEncoder.js';

/**
 * The unit tests check the bytes we build. This one checks that a real HTTP
 * server, reading them the way a provider would, finds a well-formed multipart
 * upload with a playable WAV inside it — and that the reply comes back as text.
 * Nothing leaves the machine: the provider is a local server.
 */

const SAMPLE_RATE = 16000;

/** One second of a 440 Hz tone, as the microphone would hand it over. */
function tonePcm16(seconds: number): Uint8Array {
	const frames = SAMPLE_RATE * seconds;
	const pcm = new Uint8Array(frames * 2);
	const view = new DataView(pcm.buffer);
	for (let i = 0; i < frames; i++) {
		view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 440 * (i / SAMPLE_RATE)) * 0x4000), true);
	}
	return pcm;
}

interface IReceived {
	readonly headers: Record<string, string | undefined>;
	readonly fields: Record<string, string>;
	readonly file: { readonly filename: string; readonly contentType: string; readonly bytes: Buffer } | undefined;
}

/** Reads a multipart body the way a server framework would, without one. */
function readMultipart(contentType: string, body: Buffer): Pick<IReceived, 'fields' | 'file'> {
	const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
	assert.ok(boundary, `no boundary in: ${contentType}`);

	const separator = Buffer.from(`--${boundary}`);
	const fields: Record<string, string> = {};
	let file: IReceived['file'];

	let cursor = body.indexOf(separator);
	while (cursor >= 0) {
		const partStart = cursor + separator.length;
		if (body.subarray(partStart, partStart + 2).toString() === '--') {
			break; // closing boundary
		}
		const next = body.indexOf(separator, partStart);
		assert.ok(next > partStart, 'a part was never closed');

		const part = body.subarray(partStart + 2, next - 2); // strip the CRLF on each side
		const headerEnd = part.indexOf('\r\n\r\n');
		assert.ok(headerEnd > 0, 'a part had no header block');

		const headers = part.subarray(0, headerEnd).toString('utf8');
		const content = part.subarray(headerEnd + 4);
		const name = /name="([^"]+)"/.exec(headers)?.[1];
		assert.ok(name, `a part had no name: ${headers}`);

		const filename = /filename="([^"]+)"/.exec(headers)?.[1];
		if (filename) {
			file = {
				filename,
				contentType: /Content-Type: (.+)/.exec(headers)?.[1]?.trim() ?? '',
				bytes: Buffer.from(content),
			};
		} else {
			fields[name] = content.toString('utf8');
		}
		cursor = next;
	}

	return { fields, file };
}

function post(url: string, headers: Record<string, string>, body: Uint8Array): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(url, { method: 'POST', headers }, res => {
			const chunks: Buffer[] = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.end(Buffer.from(body));
	});
}

suite('Primal dictation - round trip through a real HTTP server', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let server: Server | undefined;
	let received: IReceived | undefined;
	let reply = { status: 200, body: '{"text":"open the file"}' };

	setup(async () => {
		received = undefined;
		reply = { status: 200, body: '{"text":"open the file"}' };
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', chunk => chunks.push(chunk));
			req.on('end', () => {
				const body = Buffer.concat(chunks);
				const contentType = req.headers['content-type'] ?? '';
				received = {
					headers: { authorization: req.headers['authorization'] as string | undefined, 'content-type': contentType },
					...readMultipart(contentType, body),
				};
				res.writeHead(reply.status, { 'Content-Type': 'application/json' });
				res.end(reply.body);
			});
		});
		await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
	});

	teardown(async () => {
		const closing = server;
		server = undefined;
		await new Promise<void>(resolve => closing ? closing.close(() => resolve()) : resolve());
	});

	function localCapability(): ITranscriptionCapability {
		const { port } = server!.address() as AddressInfo;
		return {
			providerId: 'openai',
			shortLabel: 'OpenAI',
			endpoint: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
			model: 'gpt-4o-mini-transcribe',
			auth: 'bearer',
			body: 'multipart',
		};
	}

	test('a server reads back exactly the upload we meant to send', async () => {
		const capability = localCapability();
		const pcm = tonePcm16(1);
		const request = buildTranscriptionRequest(capability, { pcm16: pcm, sampleRate: SAMPLE_RATE }, 'sk-local-test', 'primal-round-trip');

		const response = await post(request.url, request.headers as Record<string, string>, request.body);

		assert.strictEqual(received?.headers.authorization, 'Bearer sk-local-test');
		assert.deepStrictEqual(received?.fields, { model: 'gpt-4o-mini-transcribe', response_format: 'json' });
		assert.strictEqual(received?.file?.filename, 'audio.wav');
		assert.strictEqual(received?.file?.contentType, 'audio/wav');
		assert.strictEqual(parseTranscriptionResponse(capability, response.status, response.body).ok, true);
	});

	test('the file that arrives is a WAV holding every sample we recorded', async () => {
		const capability = localCapability();
		const pcm = tonePcm16(1);
		const request = buildTranscriptionRequest(capability, { pcm16: pcm, sampleRate: SAMPLE_RATE }, 'sk-local-test', 'primal-round-trip');

		await post(request.url, request.headers as Record<string, string>, request.body);

		const wav = received!.file!.bytes;
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		assert.strictEqual(wav.subarray(0, 4).toString('ascii'), 'RIFF');
		assert.strictEqual(wav.subarray(8, 12).toString('ascii'), 'WAVE');
		assert.strictEqual(view.getUint32(24, true), SAMPLE_RATE, 'sample rate survived the upload');
		assert.strictEqual(view.getUint32(40, true), pcm.length, 'declared data length');
		assert.strictEqual(wav.length, WAV_HEADER_BYTES + pcm.length, 'no bytes added or lost in transit');
		assert.ok(wav.subarray(WAV_HEADER_BYTES).equals(Buffer.from(pcm)), 'the samples arrived unchanged');
	});

	test('a transcript comes back as text the editor can insert', async () => {
		const capability = localCapability();
		const request = buildTranscriptionRequest(capability, { pcm16: tonePcm16(1), sampleRate: SAMPLE_RATE }, 'sk-local-test', 'primal-round-trip');

		const response = await post(request.url, request.headers as Record<string, string>, request.body);

		assert.deepStrictEqual(
			parseTranscriptionResponse(capability, response.status, response.body),
			{ ok: true, text: 'open the file' },
		);
	});

	test('a rejection from the server becomes a sentence, not a stack trace', async () => {
		const capability = localCapability();
		reply = { status: 401, body: '{"error":{"message":"Incorrect API key provided: sk-loc***est"}}' };
		const request = buildTranscriptionRequest(capability, { pcm16: tonePcm16(1), sampleRate: SAMPLE_RATE }, 'sk-local-test', 'primal-round-trip');

		const response = await post(request.url, request.headers as Record<string, string>, request.body);
		const outcome = parseTranscriptionResponse(capability, response.status, response.body);

		assert.ok(!outcome.ok);
		assert.match(outcome.message, /OpenAI rejected the API key/);
		assert.ok(!outcome.message.includes('sk-loc'), 'the rejected key must not be echoed back at the user');
	});
});
