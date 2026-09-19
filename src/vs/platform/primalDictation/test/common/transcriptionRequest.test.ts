/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildTranscriptionRequest, parseTranscriptionResponse } from '../../common/transcriptionRequest.js';
import { transcriptionCapabilityFor } from '../../common/transcriptionProviders.js';

const KEY = 'sk-test-key-do-not-leak';
const BOUNDARY = 'primal-boundary-0123';
const AUDIO = { pcm16: new Uint8Array([0x01, 0x00, 0x02, 0x00]), sampleRate: 16000 };

function asText(bytes: Uint8Array): string {
	return String.fromCharCode(...bytes);
}

suite('Primal dictation - request shaping', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('OpenAI gets a bearer-authenticated multipart upload of a WAV file', () => {
		const capability = transcriptionCapabilityFor('openai')!;
		const request = buildTranscriptionRequest(capability, AUDIO, KEY, BOUNDARY);
		const body = asText(request.body);

		assert.strictEqual(request.url, capability.endpoint);
		assert.strictEqual(request.headers['Authorization'], `Bearer ${KEY}`);
		assert.strictEqual(request.headers['Content-Type'], `multipart/form-data; boundary=${BOUNDARY}`);
		assert.ok(body.includes('name="model"'), 'model field');
		assert.ok(body.includes(capability.model), 'model value');
		assert.ok(body.includes('name="file"; filename="audio.wav"'), 'file field');
		assert.ok(body.includes('Content-Type: audio/wav'), 'file part type');
		assert.ok(body.includes('RIFF'), 'the WAV itself');
		assert.ok(body.endsWith(`--${BOUNDARY}--\r\n`), `closing boundary, got: ${JSON.stringify(body.slice(-40))}`);
	});

	test('the OpenAI key travels in the header only, never in the body', () => {
		const capability = transcriptionCapabilityFor('openai')!;
		const request = buildTranscriptionRequest(capability, AUDIO, KEY, BOUNDARY);

		assert.ok(!asText(request.body).includes(KEY));
	});

	test('Google gets its key in the header it expects, and the audio inline', () => {
		const capability = transcriptionCapabilityFor('google')!;
		const request = buildTranscriptionRequest(capability, AUDIO, KEY, BOUNDARY);
		const payload = JSON.parse(asText(request.body));

		assert.ok(request.url.includes(capability.model), 'model in the URL');
		assert.strictEqual(request.headers['x-goog-api-key'], KEY);
		assert.strictEqual(request.headers['Authorization'], undefined, 'no bearer header for Google');
		assert.strictEqual(request.headers['Content-Type'], 'application/json');

		const parts = payload.contents[0].parts;
		const audioPart = parts.find((p: Record<string, unknown>) => p.inline_data !== undefined);
		const textPart = parts.find((p: Record<string, unknown>) => p.text !== undefined);

		assert.ok(textPart?.text.length > 0, 'an instruction telling it to transcribe');
		assert.strictEqual(audioPart.inline_data.mime_type, 'audio/wav');
		assert.strictEqual(asText(decodeBase64(audioPart.inline_data.data).buffer).slice(0, 4), 'RIFF');
	});

	test('a request carries no cookies or credentials of its own', () => {
		for (const id of ['openai', 'google']) {
			const request = buildTranscriptionRequest(transcriptionCapabilityFor(id)!, AUDIO, KEY, BOUNDARY);
			assert.strictEqual(request.method, 'POST');
			assert.strictEqual(request.headers['Cookie'], undefined, `${id} sent a cookie`);
		}
	});

	test('an empty key is refused before a request is ever shaped', () => {
		const capability = transcriptionCapabilityFor('openai')!;

		assert.throws(() => buildTranscriptionRequest(capability, AUDIO, '   ', BOUNDARY), /key/i);
	});
});

suite('Primal dictation - response reading', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const openai = transcriptionCapabilityFor('openai')!;
	const google = transcriptionCapabilityFor('google')!;

	test('reads the text OpenAI returns', () => {
		const outcome = parseTranscriptionResponse(openai, 200, '{"text":"  open the file  "}');

		assert.deepStrictEqual(outcome, { ok: true, text: 'open the file' });
	});

	test('reads the text Google returns', () => {
		const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'open the file\n' }] } }] });
		const outcome = parseTranscriptionResponse(google, 200, body);

		assert.deepStrictEqual(outcome, { ok: true, text: 'open the file' });
	});

	test('silence transcribes to nothing, which is a success', () => {
		assert.deepStrictEqual(parseTranscriptionResponse(openai, 200, '{"text":""}'), { ok: true, text: '' });
	});

	test('a rejected key says so, and says which provider rejected it', () => {
		const outcome = parseTranscriptionResponse(openai, 401, '{"error":{"message":"Incorrect API key"}}');

		assert.ok(!outcome.ok);
		assert.ok(/key/i.test(outcome.message), outcome.message);
		assert.ok(outcome.message.includes('OpenAI'), outcome.message);
	});

	test('a quota or rate limit reads as one, not as a broken microphone', () => {
		const outcome = parseTranscriptionResponse(openai, 429, '{"error":{"message":"Rate limit reached"}}');

		assert.ok(!outcome.ok);
		assert.ok(/limit|quota/i.test(outcome.message), outcome.message);
	});

	test('a server fault reads as the service being down', () => {
		const outcome = parseTranscriptionResponse(openai, 503, 'upstream unavailable');

		assert.ok(!outcome.ok);
		assert.ok(/unavailable|try again/i.test(outcome.message), outcome.message);
	});

	test('a body that is not the shape we expect fails clearly instead of silently', () => {
		for (const body of ['not json at all', '{}', '{"text":42}', '{"candidates":[]}']) {
			const outcome = parseTranscriptionResponse(openai, 200, body);
			assert.ok(!outcome.ok, `expected failure for: ${body}`);
			assert.ok(outcome.message.length > 0);
		}
	});
});
