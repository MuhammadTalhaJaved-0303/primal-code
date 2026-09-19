/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDictationAvailability, IDictationResult, IPrimalDictationService } from '../../../../platform/primalDictation/common/primalDictation.js';

/**
 * In the browser there is no main process to decrypt a key in, and a page
 * cannot call these APIs itself: the provider endpoints reject a cross-origin
 * request carrying an `Authorization` header. Dictation therefore says so
 * plainly rather than offering a button that cannot work.
 */
export class BrowserPrimalDictationService implements IPrimalDictationService {

	declare readonly _serviceBrand: undefined;

	async resolveAvailability(): Promise<IDictationAvailability> {
		return { available: false, message: this._unavailable() };
	}

	async transcribe(): Promise<IDictationResult> {
		return { ok: false, message: this._unavailable() };
	}

	private _unavailable(): string {
		return localize('primalDictation.browserUnsupported', "Dictation is only available in the desktop app.");
	}
}

registerSingleton(IPrimalDictationService, BrowserPrimalDictationService, InstantiationType.Delayed);
