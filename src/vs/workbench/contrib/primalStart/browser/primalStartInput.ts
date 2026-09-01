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

const PrimalStartIcon = registerIcon('primal-start-editor-label-icon', Codicon.home, localize('primalStartEditorLabelIcon', 'Icon of the Primal Start editor label.'));

/** The Primal Start page: the hero surface a new empty window opens with. */
export class PrimalStartInput extends EditorInput {

	static readonly ID: string = 'workbench.input.primalStart';

	readonly resource = undefined;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof PrimalStartInput;
	}

	override get typeId(): string {
		return PrimalStartInput.ID;
	}

	override getName(): string {
		return localize('primalStartInputName', "Primal Start");
	}

	override getIcon(): ThemeIcon {
		return PrimalStartIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
