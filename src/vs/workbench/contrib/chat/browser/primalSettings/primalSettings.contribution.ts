/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { PRIMAL_OPEN_SETTINGS_COMMAND_ID } from '../../../../../platform/agentHost/common/primalProviders.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { PrimalSettingsEditor } from './primalSettingsEditor.js';
import { PrimalSettingsEditorInput } from './primalSettingsEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		PrimalSettingsEditor,
		PrimalSettingsEditor.ID,
		localize('primalSettingsEditor', "Primal Code Settings"),
	),
	[new SyncDescriptor(PrimalSettingsEditorInput)],
);

class PrimalSettingsEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '{}';
	}
	deserialize(): EditorInput {
		return new PrimalSettingsEditorInput();
	}
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PrimalSettingsEditorInput.ID, PrimalSettingsEditorInputSerializer);

class OpenPrimalSettingsAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_OPEN_SETTINGS_COMMAND_ID,
			title: localize2('primalCode.openSettings', "Primal Code Settings"),
			icon: Codicon.settingsGear,
			f1: true,
			menu: [{
				id: MenuId.GlobalActivity,
				group: '2_configuration',
				order: 1,
			}],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new PrimalSettingsEditorInput(), { pinned: true });
	}
}
registerAction2(OpenPrimalSettingsAction);
