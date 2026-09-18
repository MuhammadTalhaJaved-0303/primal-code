/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IPrimalDictationService = createDecorator<IPrimalDictationService>('primalDictationService');

/**
 * Whether the keys on this machine can transcribe, answered before the user
 * presses the microphone so the button is never offered as a dead end.
 */
export type IDictationAvailability =
	| { readonly available: true; readonly providerId: string; readonly providerLabel: string }
	| { readonly available: false; readonly message: string };

export interface IDictationRequest {
	/** Signed 16-bit mono samples, little endian. */
	readonly pcm16: VSBuffer;
	readonly sampleRate: number;
}

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

	/** Transcribes one finished recording. Never throws for an expected failure. */
	transcribe(request: IDictationRequest): Promise<IDictationResult>;
}
