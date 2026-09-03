/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { PrimalRigEditor } from './primalRigEditor.js';
import { PrimalRigInput } from './primalRigInput.js';

/** Command that opens the Rig on demand (also in the command palette). */
const PRIMAL_OPEN_RIG_COMMAND_ID = 'primalCode.openRig';

const PRIMAL_CATEGORY = localize2('primalCode.rig.category', "Primal Code");

// --- editor pane + input ---------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		PrimalRigEditor,
		PrimalRigEditor.ID,
		localize('primalRigEditor', "The Rig"),
	),
	[new SyncDescriptor(PrimalRigInput)],
);

/**
 * The Rig holds no per-instance state, so restoring it is just re-creating the
 * singleton input - same shape as Primal Start's serializer.
 */
class PrimalRigInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '{}';
	}
	deserialize(): EditorInput {
		return new PrimalRigInput();
	}
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PrimalRigInput.ID, PrimalRigInputSerializer);

// --- action ----------------------------------------------------------------

class OpenPrimalRigAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_OPEN_RIG_COMMAND_ID,
			title: localize2('primalCode.openRig', "The Rig"),
			category: PRIMAL_CATEGORY,
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new PrimalRigInput(), { pinned: true });
	}
}
registerAction2(OpenPrimalRigAction);

// The startup surface is chosen by `primalCode.startPage.surface` and opened by
// Primal Start's existing runner (primalStart.contribution.ts). This contrib
// deliberately registers no startup contribution of its own: two runners racing
// for the same window is the failure the Rig spec forbids.
