/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer, encodeBase64 } from '../../../base/common/buffer.js';
import { isFalsyOrWhitespace } from '../../../base/common/strings.js';
import { localize } from '../../../nls.js';
import { buildMultipartBody, multipartContentType } from './multipartBody.js';
import { ITranscriptionCapability } from './transcriptionProviders.js';
import { encodeWav } from './wavEncoder.js';

/**
 * Turning a recording into an HTTP request, and an HTTP response back into
 * text. Both halves are pure so they can be tested without a network, a key or
 * a microphone; the main process supplies those.
 */

export interface ITranscriptionAudio {
	/** Signed 16-bit mono samples, little endian, exactly as the microphone produced them. */
	readonly pcm16: Uint8Array;
	readonly sampleRate: number;
}

export interface ITranscriptionHttpRequest {
	readonly url: string;
	readonly method: 'POST';
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
}

export type TranscriptionOutcome =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly message: string };

const AUDIO_MIME_TYPE = 'audio/wav';
const AUDIO_FILENAME = 'audio.wav';

const GEMINI_INSTRUCTION = 'Transcribe this audio verbatim. Reply with the transcript only: no commentary, no quotation marks, no formatting. If there is no speech, reply with nothing at all.';

export function buildTranscriptionRequest(
	capability: ITranscriptionCapability,
	audio: ITranscriptionAudio,
	apiKey: string,
	boundary: string,
): ITranscriptionHttpRequest {
	if (isFalsyOrWhitespace(apiKey)) {
		throw new Error(`Dictation has no ${capability.shortLabel} API key to send.`);
	}

	const wav = encodeWav(audio.pcm16, audio.sampleRate);

	switch (capability.body) {
		case 'multipart':
			return {
				url: capability.endpoint,
				method: 'POST',
				headers: {
					...authHeader(capability, apiKey),
					'Content-Type': multipartContentType(boundary),
				},
				body: buildMultipartBody(
					boundary,
					[{ name: 'model', value: capability.model }, { name: 'response_format', value: 'json' }],
					[{ name: 'file', filename: AUDIO_FILENAME, contentType: AUDIO_MIME_TYPE, data: wav }],
				),
			};

		case 'gemini-inline':
			return {
				url: capability.endpoint.replace('{model}', capability.model),
				method: 'POST',
				headers: {
					...authHeader(capability, apiKey),
					'Content-Type': 'application/json',
				},
				body: VSBuffer.fromString(JSON.stringify({
					contents: [{
						parts: [
							{ text: GEMINI_INSTRUCTION },
							{ inline_data: { mime_type: AUDIO_MIME_TYPE, data: encodeBase64(VSBuffer.wrap(wav)) } },
						],
					}],
					generationConfig: { temperature: 0, responseMimeType: 'text/plain' },
				})).buffer,
			};
	}
}

function authHeader(capability: ITranscriptionCapability, apiKey: string): Record<string, string> {
	switch (capability.auth) {
		case 'bearer':
			return { 'Authorization': `Bearer ${apiKey}` };
		case 'google-api-key':
			return { 'x-goog-api-key': apiKey };
	}
}

/**
 * Reads the provider's answer. The upstream error text is deliberately left out
 * of the message: providers echo fragments of the rejected key back, and this
 * string is shown in the editor. The caller logs the raw body instead.
 */
export function parseTranscriptionResponse(
	capability: ITranscriptionCapability,
	status: number,
	body: string,
): TranscriptionOutcome {
	if (status < 200 || status >= 300) {
		return { ok: false, message: httpFailureMessage(capability, status) };
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return { ok: false, message: unreadableMessage(capability) };
	}

	const text = capability.body === 'gemini-inline' ? geminiText(payload) : whisperText(payload);
	return text === undefined
		? { ok: false, message: unreadableMessage(capability) }
		: { ok: true, text: text.trim() };
}

function whisperText(payload: unknown): string | undefined {
	const text = (payload as { text?: unknown } | null)?.text;
	return typeof text === 'string' ? text : undefined;
}

function geminiText(payload: unknown): string | undefined {
	const parts = (payload as { candidates?: { content?: { parts?: unknown } }[] } | null)
		?.candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts)) {
		return undefined;
	}
	const spoken = parts
		.map(part => (part as { text?: unknown })?.text)
		.filter((text): text is string => typeof text === 'string');
	return spoken.length ? spoken.join('') : undefined;
}

function httpFailureMessage(capability: ITranscriptionCapability, status: number): string {
	if (status === 401 || status === 403) {
		return localize(
			'primalDictation.keyRejected',
			"{0} rejected the API key, so it could not transcribe. Check the key in Settings.",
			capability.shortLabel,
		);
	}
	if (status === 429) {
		return localize(
			'primalDictation.rateLimited',
			"{0} is rate limiting dictation, or the account is out of quota. Try again shortly.",
			capability.shortLabel,
		);
	}
	if (status >= 500) {
		return localize(
			'primalDictation.serviceDown',
			"{0} is unavailable right now, so dictation could not run. Try again in a moment.",
			capability.shortLabel,
		);
	}
	return localize(
		'primalDictation.refused',
		"{0} refused the recording (HTTP {1}), so there is no transcript.",
		capability.shortLabel,
		status,
	);
}

function unreadableMessage(capability: ITranscriptionCapability): string {
	return localize(
		'primalDictation.unreadable',
		"{0} answered with something dictation could not read, so there is no transcript.",
		capability.shortLabel,
	);
}
