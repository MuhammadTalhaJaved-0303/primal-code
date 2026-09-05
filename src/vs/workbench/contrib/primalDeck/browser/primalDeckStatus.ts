/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';

/** A status the Deck can actually source, as a text glyph, a codicon and a word. */
export interface IDeckStatusPresentation {
	readonly glyph: string;
	readonly icon: ThemeIcon;
	readonly label: string;
}

/**
 * The same four `ChatSessionStatus` cases The Rig's chips draw, in the Deck's
 * console voice. `undefined` in means `undefined` out: a status nobody can
 * report truthfully gets no glyph and no word, never a default.
 */
export function deckStatusPresentation(status: ChatSessionStatus | undefined): IDeckStatusPresentation | undefined {
	switch (status) {
		case ChatSessionStatus.InProgress:
			return { glyph: '●', icon: Codicon.sync, label: localize('primalDeck.status.running', "running") };
		case ChatSessionStatus.NeedsInput:
			return { glyph: '⚠', icon: Codicon.bell, label: localize('primalDeck.status.waiting', "waiting on you") };
		case ChatSessionStatus.Completed:
			return { glyph: '✓', icon: Codicon.check, label: localize('primalDeck.status.done', "done") };
		case ChatSessionStatus.Failed:
			// allow-any-unicode-next-line
			return { glyph: '✕', icon: Codicon.error, label: localize('primalDeck.status.failed', "failed") };
		default:
			return undefined;
	}
}
