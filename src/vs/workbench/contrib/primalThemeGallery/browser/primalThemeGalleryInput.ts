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

const PrimalThemeGalleryIcon = registerIcon('primal-theme-gallery-editor-label-icon', Codicon.symbolColor, localize('primalThemeGalleryEditorLabelIcon', 'Icon of the Primal theme gallery editor label.'));

/**
 * The theme gallery: one browse-and-preview surface for every colour theme the
 * window has.
 *
 * `Singleton` means one instance per editor GROUP, matching the Start page.
 */
export class PrimalThemeGalleryInput extends EditorInput {

	static readonly ID: string = 'workbench.input.primalThemeGallery';

	readonly resource = undefined;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof PrimalThemeGalleryInput;
	}

	override get typeId(): string {
		return PrimalThemeGalleryInput.ID;
	}

	override getName(): string {
		return localize('primalThemeGalleryInputName', "Themes");
	}

	override getIcon(): ThemeIcon {
		return PrimalThemeGalleryIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
