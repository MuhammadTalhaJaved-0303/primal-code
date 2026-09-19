/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IPrimalDictationService = createDecorator<IPrimalDictationService>('primalDictationService');

/**
 * The most audio one take may carry. OpenAI caps uploads at 25 MB; both sides
 * measure against this so a recording is refused in plain words rather than
 * silently clipped.
 */
export const MAX_DICTATION_AUDIO_BYTES = 24 * 1024 * 1024;

/**
 * Whether the keys on this machine can transcribe, answered before the user
 * presses the microphone so the button is never offered as a dead end.
 */
export type IDictationAvailability =
	| { readonly available: true; readonly providerId: string; readonly providerLabel: string }
	| { readonly available: false; readonly message: string };

export type IDictationResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly message: string };

/**
 * Dictation runs in the main process for two reasons: the API key is decrypted
 * there and never crosses a process boundary, and a renderer cannot call these
 * APIs at all — `vscode-file://` origins fail CORS preflight on `Authorization`.
 */
export interface IPrimalDictationService {
	readonly _serviceBrand: undefined;

	/** Which stored key dictation would use, or in plain words why it cannot. */
	resolveAvailability(): Promise<IDictationAvailability>;

	/**
	 * Transcribes one finished recording. Never throws for an expected failure.
	 *
	 * The samples are signed 16-bit mono, little endian, and travel as a
	 * top-level argument on purpose: the IPC layer carries a `VSBuffer` intact
	 * only there, and turns one nested in an object into JSON.
	 */
	transcribe(pcm16: VSBuffer, sampleRate: number): Promise<IDictationResult>;
}
