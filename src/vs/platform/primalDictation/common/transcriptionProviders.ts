/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { providerById } from '../../agentHost/common/primalProviders.js';

/**
 * Dictation is bring-your-own-key like the rest of Primal Code, so it can only
 * speak to providers the user already has a key for. Most of them have no
 * speech API at all: Anthropic, DeepSeek and Kimi are text-only, and a custom
 * Anthropic-compatible endpoint is text-only by definition. This table is the
 * whole truth about which keys can transcribe, and everything else asks it
 * rather than guessing.
 */

/** How the provider wants the key presented. */
export type TranscriptionAuth = 'bearer' | 'google-api-key';

/** How the provider wants the audio presented. */
export type TranscriptionBody = 'multipart' | 'gemini-inline';

export interface ITranscriptionCapability {
	readonly providerId: string;
	/** Short name for messages the user reads; the settings page uses the full label. */
	readonly shortLabel: string;
	/** Endpoint to POST to. `{model}` is substituted when the provider puts the model in the URL. */
	readonly endpoint: string;
	readonly model: string;
	readonly auth: TranscriptionAuth;
	readonly body: TranscriptionBody;
}

export const TRANSCRIPTION_PROVIDERS: readonly ITranscriptionCapability[] = [
	{
		providerId: 'openai',
		shortLabel: 'OpenAI',
		endpoint: 'https://api.openai.com/v1/audio/transcriptions',
		model: 'gpt-4o-mini-transcribe',
		auth: 'bearer',
		body: 'multipart',
	},
	{
		providerId: 'google',
		shortLabel: 'Google',
		endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
		model: 'gemini-2.5-flash',
		auth: 'google-api-key',
		body: 'gemini-inline',
	},
];

export function transcriptionCapabilityFor(providerId: string | undefined): ITranscriptionCapability | undefined {
	return providerId ? TRANSCRIPTION_PROVIDERS.find(capability => capability.providerId === providerId) : undefined;
}

export function canTranscribe(providerId: string | undefined): boolean {
	return !!transcriptionCapabilityFor(providerId);
}

/** The full provider labels, in table order, for anywhere that lists the choice. */
export function transcriptionProviderLabels(): readonly string[] {
	return TRANSCRIPTION_PROVIDERS.map(capability => providerById(capability.providerId)?.label ?? capability.shortLabel);
}

/** The short names, joined the way a sentence wants them: "OpenAI or Google". */
function offeredProviders(): string {
	const names = TRANSCRIPTION_PROVIDERS.map(capability => capability.shortLabel);
	if (names.length <= 1) {
		return names[0] ?? '';
	}
	return localize('primalDictation.providerPair', "{0} or {1}", names.slice(0, -1).join(', '), names[names.length - 1]);
}

/**
 * Why dictation is unavailable for this key, said plainly and pointed somewhere
 * the user can act on. Never invents a name for a provider it does not know.
 */
export function noTranscriptionMessage(providerId: string | undefined): string {
	const provider = providerById(providerId);
	if (provider) {
		return localize(
			'primalDictation.providerHasNoSpeech',
			"{0} does not offer speech-to-text, so dictation cannot use that key. Add a {1} key in Settings to dictate.",
			provider.label,
			offeredProviders(),
		);
	}
	return localize(
		'primalDictation.noSpeechProvider',
		"Dictation needs a provider that offers speech-to-text. Add a {0} key in Settings to dictate.",
		offeredProviders(),
	);
}
