/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { InEditorZenModeContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IPrimalDeckService, PRIMAL_DECK_TOGGLE_COMMAND_ID } from './primalDeck.js';
import { PrimalDeckEditor } from './primalDeckEditor.js';
import { PrimalDeckInput } from './primalDeckInput.js';
import { PrimalDeckService } from './primalDeckService.js';

const PRIMAL_CATEGORY = localize2('primalCode.deck.category', "Primal Code");

// --- service ---------------------------------------------------------------

registerSingleton(IPrimalDeckService, PrimalDeckService, InstantiationType.Delayed);

// --- editor pane + input ---------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		PrimalDeckEditor,
		PrimalDeckEditor.ID,
		localize('primalDeckEditor', "The Deck"),
	),
	[new SyncDescriptor(PrimalDeckInput)],
);

/**
 * The Deck holds no per-instance state, so restoring it is re-creating the
 * singleton input. The layout it hid is remembered by the service, on disk,
 * and adopted after restore (`adoptRestoredDeck`).
 */
class PrimalDeckInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '{}';
	}
	deserialize(): EditorInput {
		return new PrimalDeckInput();
	}
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PrimalDeckInput.ID, PrimalDeckInputSerializer);

// --- action ----------------------------------------------------------------

/**
 * Ctrl+Cmd+D on mac, Ctrl+Alt+D elsewhere: the same modifier family as the
 * chat's Ctrl+Cmd+I / Ctrl+Alt+I, and free of any in-product binding on all
 * three platforms. Not available inside zen mode, which owns the same parts.
 */
class TogglePrimalDeckAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_DECK_TOGGLE_COMMAND_ID,
			title: localize2('primalCode.deck.toggle', "Toggle The Deck"),
			category: PRIMAL_CATEGORY,
			f1: true,
			precondition: InEditorZenModeContext.negate(),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyD,
				mac: { primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyD }
			}
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IPrimalDeckService).toggle();
	}
}
registerAction2(TogglePrimalDeckAction);

// --- restore after reload --------------------------------------------------

/**
 * Runs once the editors are restored: a Deck tab that came back is adopted so
 * closing it restores the layout; a remembered layout with no tab is restored
 * immediately.
 */
class PrimalDeckRestoreContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalDeckRestore';

	constructor(@IPrimalDeckService deckService: IPrimalDeckService) {
		super();
		deckService.adoptRestoredDeck();
	}
}
registerWorkbenchContribution2(PrimalDeckRestoreContribution.ID, PrimalDeckRestoreContribution, WorkbenchPhase.AfterRestored);
