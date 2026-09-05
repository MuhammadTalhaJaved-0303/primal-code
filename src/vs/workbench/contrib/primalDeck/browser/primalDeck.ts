/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Command that enters or leaves The Deck (also in the command palette). */
export const PRIMAL_DECK_TOGGLE_COMMAND_ID = 'primalCode.deck.toggle';

export const IPrimalDeckService = createDecorator<IPrimalDeckService>('primalDeckService');

/**
 * Owns the layout side of The Deck: which workbench parts were visible when
 * the Deck opened, and putting exactly those back when it closes.
 *
 * The service - not the pane - is the owner, because the pane is disposed on
 * tab close before anything inside it could restore the layout.
 */
export interface IPrimalDeckService {
	readonly _serviceBrand: undefined;

	/** Whether a Deck tab is open in any editor group. */
	readonly isOpen: boolean;

	/** Opens the Deck when it is closed, leaves it when it is open. */
	toggle(): Promise<void>;

	/**
	 * Remembers side bar and panel visibility, hides both, makes sure the chat
	 * view is present in the auxiliary bar and opens the pane.
	 */
	enter(): Promise<void>;

	/** Closes the Deck tab in every group; the close restores the remembered parts. */
	leave(): Promise<void>;

	/**
	 * Called once after workbench restore. Adopts a Deck tab the editor
	 * serializer brought back so closing it still restores the layout; when no
	 * tab came back but a remembered layout is still on disk, restores it now,
	 * so a reload can never strand the side bar and panel hidden.
	 */
	adoptRestoredDeck(): void;
}
