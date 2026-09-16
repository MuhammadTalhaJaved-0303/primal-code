/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { AGENTS_VOICE_AVAILABLE, AGENTS_VOICE_ENABLED } from '../../common/agentsVoice.js';

suite('Agents Voice - availability', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A context that answers yes to every key. Voice Mode is already dark at
	 * runtime because its entitlement key is never set, but "never set" and
	 * "cannot be set" are different promises: this context proves the gate holds
	 * even if some future code sets every key it reads.
	 */
	const everythingTrue: IContext = { getValue: <T>() => true as unknown as T };

	test('Voice Mode is not available in this product', () => {
		// It needs a Copilot entitlement, a GitHub sign-in and Microsoft's voice
		// backend. This fork has none of the three, by design.
		assert.strictEqual(AGENTS_VOICE_AVAILABLE, false);
	});

	test('nothing can turn Voice Mode on, whatever the context says', () => {
		assert.strictEqual(AGENTS_VOICE_ENABLED.evaluate(everythingTrue), false);
	});
});
