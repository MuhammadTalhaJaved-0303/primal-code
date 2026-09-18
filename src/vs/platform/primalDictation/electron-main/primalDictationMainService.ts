/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { isFalsyOrWhitespace } from '../../../base/common/strings.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { PRIMAL_HARNESS_PROVIDER_SETTING_ID, PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, providerById, providerSecretKey } from '../../agentHost/common/primalProviders.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEncryptionMainService } from '../../encryption/common/encryptionService.js';
import { ILogService } from '../../log/common/log.js';
import { readEncryptedSecret } from '../../secrets/common/secrets.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { StorageScope } from '../../storage/common/storage.js';
import { IDictationAvailability, IDictationRequest, IDictationResult, IPrimalDictationService } from '../common/primalDictation.js';
import { ITranscriptionHttpRequest, buildTranscriptionRequest, parseTranscriptionResponse } from '../common/transcriptionRequest.js';
import { ITranscriptionCapability, TRANSCRIPTION_PROVIDERS, noTranscriptionMessage, transcriptionCapabilityFor } from '../common/transcriptionProviders.js';
import { WAV_HEADER_BYTES } from '../common/wavEncoder.js';

/** OpenAI caps uploads at 25 MB; stay under it with room for the header. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024 - WAV_HEADER_BYTES;

/** Rates a microphone could plausibly have produced. */
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;

/** A transcript that has not arrived in a minute is not arriving. */
const REQUEST_TIMEOUT_MS = 60_000;

/** No provider returns megabytes of JSON for one transcript. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const LOG_PREFIX = '[PrimalDictation]';

/**
 * Transcribes a recording with whichever provider key the user already stored.
 * The key is read and decrypted here and never leaves this process: the
 * renderer sends audio and receives text.
 */
export class PrimalDictationMainService implements IPrimalDictationService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEncryptionMainService private readonly _encryptionMainService: IEncryptionMainService,
		@IApplicationStorageMainService private readonly _applicationStorageMainService: IApplicationStorageMainService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async resolveAvailability(): Promise<IDictationAvailability> {
		const resolved = await this._resolveProvider();
		if (!resolved) {
			return { available: false, message: this._noProviderMessage() };
		}
		return {
			available: true,
			providerId: resolved.capability.providerId,
			providerLabel: providerById(resolved.capability.providerId)?.label ?? resolved.capability.shortLabel,
		};
	}

	async transcribe(request: IDictationRequest): Promise<IDictationResult> {
		const invalid = this._rejectMalformedRequest(request);
		if (invalid) {
			return invalid;
		}

		const resolved = await this._resolveProvider();
		if (!resolved) {
			return { ok: false, message: this._noProviderMessage() };
		}

		const { capability, apiKey } = resolved;
		let httpRequest: ITranscriptionHttpRequest;
		try {
			httpRequest = buildTranscriptionRequest(
				capability,
				{ pcm16: request.pcm16.buffer, sampleRate: request.sampleRate },
				apiKey,
				`primal-${generateUuid()}`,
			);
		} catch (error) {
			this._logService.error(`${LOG_PREFIX} Could not shape the ${capability.shortLabel} request.`, error);
			return { ok: false, message: this._unexpectedMessage(capability) };
		}

		try {
			const response = await this._post(httpRequest);
			const outcome = parseTranscriptionResponse(capability, response.status, response.body);
			if (!outcome.ok) {
				// The user sees a clean sentence; the detail belongs in the log,
				// where it is safe to keep the provider's own words.
				this._logService.error(`${LOG_PREFIX} ${capability.shortLabel} returned ${response.status}: ${response.body.slice(0, 2000)}`);
			} else {
				this._logService.trace(`${LOG_PREFIX} ${capability.shortLabel} transcribed ${outcome.text.length} characters.`);
			}
			return outcome;
		} catch (error) {
			this._logService.error(`${LOG_PREFIX} The ${capability.shortLabel} request failed before a reply arrived.`, error);
			return {
				ok: false,
				message: localize(
					'primalDictation.unreachable',
					"Dictation could not reach {0}. Check the network connection and try again.",
					capability.shortLabel,
				),
			};
		}
	}

	/** Boundary validation: the renderer is trusted, a bug in it is not. */
	private _rejectMalformedRequest(request: IDictationRequest): IDictationResult | undefined {
		const samples = request.pcm16?.byteLength ?? 0;
		if (samples === 0) {
			return { ok: false, message: localize('primalDictation.silent', "There was no audio to transcribe.") };
		}
		if (samples > MAX_AUDIO_BYTES) {
			return {
				ok: false,
				message: localize('primalDictation.tooLong', "That recording is too long to transcribe. Try again in shorter takes."),
			};
		}
		if (!Number.isInteger(request.sampleRate) || request.sampleRate < MIN_SAMPLE_RATE || request.sampleRate > MAX_SAMPLE_RATE) {
			this._logService.error(`${LOG_PREFIX} Refusing audio with an impossible sample rate: ${request.sampleRate}.`);
			return { ok: false, message: localize('primalDictation.badAudio', "That recording could not be read, so there is no transcript.") };
		}
		return undefined;
	}

	/**
	 * Prefers the provider already driving the agent, so a user with one key
	 * needs no extra setting; otherwise takes the first stored key that can
	 * transcribe at all.
	 */
	private async _resolveProvider(): Promise<{ capability: ITranscriptionCapability; apiKey: string } | undefined> {
		const configured = this._configurationService.getValue<string>(PRIMAL_HARNESS_PROVIDER_SETTING_ID);
		const preferred = transcriptionCapabilityFor(configured);
		const order = preferred
			? [preferred, ...TRANSCRIPTION_PROVIDERS.filter(c => c.providerId !== preferred.providerId)]
			: TRANSCRIPTION_PROVIDERS;

		for (const capability of order) {
			const apiKey = await this._readProviderKey(capability.providerId);
			if (apiKey) {
				return { capability, apiKey };
			}
		}
		return undefined;
	}

	private _noProviderMessage(): string {
		const configured = this._configurationService.getValue<string>(PRIMAL_HARNESS_PROVIDER_SETTING_ID);
		return noTranscriptionMessage(configured);
	}

	private _unexpectedMessage(capability: ITranscriptionCapability): string {
		return localize(
			'primalDictation.unexpected',
			"Dictation could not prepare the recording for {0}.",
			capability.shortLabel,
		);
	}

	/** One provider's key from encrypted APPLICATION storage, decrypted in this process only. */
	private async _readProviderKey(providerId: string): Promise<string | undefined> {
		try {
			const read = (secretKey: string) => readEncryptedSecret(
				secretKey,
				fullKey => this._applicationStorageMainService.get(fullKey, StorageScope.APPLICATION),
				value => this._encryptionMainService.decrypt(value),
				this._logService,
			);
			let key = await read(providerSecretKey(providerId));
			if ((!key || isFalsyOrWhitespace(key)) && providerId === 'anthropic') {
				key = await read(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY);
			}
			return key && !isFalsyOrWhitespace(key) ? key : undefined;
		} catch (error) {
			this._logService.error(`${LOG_PREFIX} Could not read the stored '${providerId}' key.`, error);
			return undefined;
		}
	}

	/**
	 * Posts through Chromium's network stack, which honours the system proxy and
	 * certificate store, and unlike the shared request service accepts bytes
	 * rather than a string.
	 */
	private _post(request: ITranscriptionHttpRequest): Promise<{ status: number; body: string }> {
		return new Promise((resolve, reject) => {
			const clientRequest = net.request({ method: request.method, url: request.url });
			let settled = false;
			const timer = setTimeout(() => {
				finish(() => reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms.`)));
				clientRequest.abort();
			}, REQUEST_TIMEOUT_MS);

			const finish = (act: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				act();
			};

			for (const [name, value] of Object.entries(request.headers)) {
				clientRequest.setHeader(name, value);
			}

			clientRequest.on('response', response => {
				const chunks: Buffer[] = [];
				let received = 0;
				response.on('data', (chunk: Buffer) => {
					received += chunk.byteLength;
					if (received > MAX_RESPONSE_BYTES) {
						finish(() => reject(new Error('The reply was larger than any transcript could be.')));
						clientRequest.abort();
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () => finish(() => resolve({
					status: response.statusCode,
					body: Buffer.concat(chunks).toString('utf8'),
				})));
				response.on('error', (error: Error) => finish(() => reject(error)));
			});
			clientRequest.on('error', error => finish(() => reject(error)));

			clientRequest.write(Buffer.from(request.body));
			clientRequest.end();
		});
	}
}
