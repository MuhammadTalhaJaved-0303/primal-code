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

const PrimalRigIcon = registerIcon('primal-rig-editor-label-icon', Codicon.dashboard, localize('primalRigEditorLabelIcon', 'Icon of the Rig editor label.'));

/** The Rig: the home console — projects, agent activity, today. */
export class PrimalRigInput extends EditorInput {

	static readonly ID: string = 'workbench.input.primalRig';

	readonly resource = undefined;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof PrimalRigInput;
	}

	override get typeId(): string {
		return PrimalRigInput.ID;
	}

	override getName(): string {
		return localize('primalRigInputName', "The Rig");
	}

	override getIcon(): ThemeIcon {
		return PrimalRigIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
