/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const PrimalDeckIcon = registerIcon('primal-deck-editor-label-icon', Codicon.pulse, localize('primalDeckEditorLabelIcon', 'Icon of the Deck editor label.'));

/**
 * The Deck: the full-window console for watching an agent work. A singleton,
 * same shape as The Rig's input: opening it again reveals the open tab.
 */
export class PrimalDeckInput extends EditorInput {

	static readonly ID: string = 'workbench.input.primalDeck';

	readonly resource = undefined;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof PrimalDeckInput;
	}

	override get typeId(): string {
		return PrimalDeckInput.ID;
	}

	override getName(): string {
		return localize('primalDeckInputName', "The Deck");
	}

	override getIcon(): ThemeIcon {
		return PrimalDeckIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
