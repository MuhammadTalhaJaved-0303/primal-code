/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { PRIMAL_THEME_CLEAR_IMPORT_COMMAND_ID, PRIMAL_THEME_GALLERY_COMMAND_ID, PRIMAL_THEME_IMPORT_COMMAND_ID } from '../common/primalThemeGallery.js';
import { PrimalThemeGalleryEditor } from './primalThemeGalleryEditor.js';
import { PrimalThemeGalleryInput } from './primalThemeGalleryInput.js';
import { clearImportedTheme, importThemeFromClipboard } from './primalThemeImportAction.js';

const PRIMAL_CATEGORY = localize2('primalCode.category', "Primal Code");

// --- editor pane + input ---------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		PrimalThemeGalleryEditor,
		PrimalThemeGalleryEditor.ID,
		localize('primalThemeGalleryEditor', "Themes"),
	),
	[new SyncDescriptor(PrimalThemeGalleryInput)],
);

class PrimalThemeGalleryInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '{}';
	}
	deserialize(): EditorInput {
		return new PrimalThemeGalleryInput();
	}
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PrimalThemeGalleryInput.ID, PrimalThemeGalleryInputSerializer);

// --- actions ---------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_THEME_GALLERY_COMMAND_ID,
			title: localize2('primalGallery.open', "Browse Themes"),
			category: PRIMAL_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyG)
			}
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new PrimalThemeGalleryInput(), { pinned: true });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_THEME_IMPORT_COMMAND_ID,
			title: localize2('primalGallery.importCommand', "Import Theme Colours from Clipboard..."),
			category: PRIMAL_CATEGORY,
			f1: true
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await importThemeFromClipboard(
			accessor.get(IClipboardService),
			accessor.get(IConfigurationService),
			accessor.get(IDialogService),
			accessor.get(INotificationService),
			accessor.get(IStorageService),
			accessor.get(ILogService)
		);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_THEME_CLEAR_IMPORT_COMMAND_ID,
			title: localize2('primalGallery.clearImportCommand', "Remove Imported Theme Colours"),
			category: PRIMAL_CATEGORY,
			f1: true
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await clearImportedTheme(
			accessor.get(IConfigurationService),
			accessor.get(INotificationService),
			accessor.get(IStorageService),
			accessor.get(ILogService)
		);
	}
});
