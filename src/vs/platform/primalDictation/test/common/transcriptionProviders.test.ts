/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PRIMAL_PROVIDERS, providerById } from '../../../agentHost/common/primalProviders.js';
import { TRANSCRIPTION_PROVIDERS, canTranscribe, noTranscriptionMessage, transcriptionCapabilityFor, transcriptionProviderLabels } from '../../common/transcriptionProviders.js';

suite('Primal dictation - provider capability table', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every entry names a provider the app actually offers', () => {
		for (const capability of TRANSCRIPTION_PROVIDERS) {
			assert.ok(providerById(capability.providerId), `unknown provider id: ${capability.providerId}`);
		}
	});

	test('OpenAI can transcribe, over a bearer-authenticated multipart upload', () => {
		const capability = transcriptionCapabilityFor('openai');

		assert.ok(capability);
		assert.strictEqual(capability.auth, 'bearer');
		assert.strictEqual(capability.body, 'multipart');
		assert.ok(capability.endpoint.startsWith('https://api.openai.com/'));
		assert.ok(capability.model.length > 0);
	});

	test('Google can transcribe, over its own api-key header', () => {
		const capability = transcriptionCapabilityFor('google');

		assert.ok(capability);
		assert.strictEqual(capability.auth, 'google-api-key');
		assert.strictEqual(capability.body, 'gemini-inline');
	});

	test('Anthropic cannot transcribe - it ships no speech API', () => {
		assert.strictEqual(canTranscribe('anthropic'), false);
		assert.strictEqual(transcriptionCapabilityFor('anthropic'), undefined);
	});

	test('providers with no speech API are refused by name, and pointed somewhere useful', () => {
		const message = noTranscriptionMessage('anthropic');

		assert.ok(message.includes('Anthropic'), `expected the provider name in: ${message}`);
		assert.ok(message.includes('OpenAI'), `expected a provider that does work in: ${message}`);
	});

	test('an unknown provider is refused without inventing a name for it', () => {
		assert.strictEqual(canTranscribe('not-a-provider'), false);
		assert.ok(noTranscriptionMessage('not-a-provider').length > 0);
		assert.ok(!noTranscriptionMessage(undefined).includes('undefined'));
	});

	test('the labels it offers are the labels the settings page uses', () => {
		const labels = transcriptionProviderLabels();

		assert.deepStrictEqual(
			labels,
			TRANSCRIPTION_PROVIDERS.map(c => PRIMAL_PROVIDERS.find(p => p.id === c.providerId)!.label),
		);
	});
});
