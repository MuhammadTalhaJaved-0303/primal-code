/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import * as nls from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

const PrimalSettingsEditorIcon = registerIcon('primal-settings-editor-label-icon', Codicon.settingsGear, nls.localize('primalSettingsEditorLabelIcon', 'Icon of the Primal Code Settings editor label.'));

/** The one place for provider keys, the coding-agent provider, and model visibility. */
export class PrimalSettingsEditorInput extends EditorInput {

	static readonly ID: string = 'workbench.input.primalSettings';

	readonly resource = undefined;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof PrimalSettingsEditorInput;
	}

	override get typeId(): string {
		return PrimalSettingsEditorInput.ID;
	}

	override getName(): string {
		return nls.localize('primalSettingsEditorInputName', "Primal Code Settings");
	}

	override getIcon(): ThemeIcon {
		return PrimalSettingsEditorIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
