/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { AuxiliaryBarMaximizedContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { PrimalStartEditor } from './primalStartEditor.js';
import { PrimalStartInput } from './primalStartInput.js';

/** Command that opens Primal Start on demand (also in the command palette). */
const PRIMAL_OPEN_START_COMMAND_ID = 'primalCode.openStart';

/** Opt-out for the automatic startup page. */
const PRIMAL_START_PAGE_ENABLED_SETTING_ID = 'primalCode.startPage.enabled';

/** Upstream's startup editor, whose default this fork flips to 'none'. */
const UPSTREAM_STARTUP_EDITOR_SETTING_ID = 'workbench.startupEditor';

const PRIMAL_CATEGORY = localize2('primalCode.category', "Primal Code");

// --- editor pane + input ---------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		PrimalStartEditor,
		PrimalStartEditor.ID,
		localize('primalStartEditor', "Primal Start"),
	),
	[new SyncDescriptor(PrimalStartInput)],
);

class PrimalStartInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '{}';
	}
	deserialize(): EditorInput {
		return new PrimalStartInput();
	}
}
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PrimalStartInput.ID, PrimalStartInputSerializer);

// --- setting ---------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'primalCode',
	title: localize('primalCode.settings', "Primal Code"),
	properties: {
		[PRIMAL_START_PAGE_ENABLED_SETTING_ID]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.startPage.enabled', "Open the Primal Start page in new windows that restore no editors. The Get Started walkthroughs stay available through the 'Help: Welcome' command."),
		},
	},
});

// --- action ----------------------------------------------------------------

class OpenPrimalStartAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_OPEN_START_COMMAND_ID,
			title: localize2('primalCode.openStart', "Primal Start"),
			category: PRIMAL_CATEGORY,
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new PrimalStartInput(), { pinned: true });
	}
}
registerAction2(OpenPrimalStartAction);

// --- startup ---------------------------------------------------------------

/**
 * Opens Primal Start for new/empty windows.
 *
 * The guards mirror `StartupPageRunnerContribution` in
 * `welcomeGettingStarted/browser/startupPage.ts`, which is the surface this page
 * replaces: wait for `LifecyclePhase.Restored`, skip when `--skip-welcome` was
 * passed, skip reloaded windows, skip when the auxiliary bar is maximized, and
 * only open when the window restored no editors of its own.
 *
 * The opt-out is `primalCode.startPage.enabled`. Upstream's `workbench.startupEditor`
 * still wins where a user set it explicitly, so the two runners never open two
 * startup pages into the same window; its default is flipped to `none` for this
 * fork precisely so Primal Start is what a fresh install gets.
 */
class PrimalStartRunnerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalStartRunner';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();

		this.run().then(undefined, onUnexpectedError);
	}

	private async run(): Promise<void> {
		// Wait for resolving the startup editor until we are restored, to reduce
		// startup pressure (same reason as upstream).
		await this.lifecycleService.when(LifecyclePhase.Restored);

		if (!this.shouldOpenStartPage()) {
			return;
		}

		await this.editorService.openEditor(new PrimalStartInput(), {
			pinned: false,
			preserveFocus: this.shouldPreserveFocus()
		});
	}

	private shouldOpenStartPage(): boolean {
		if (!this.configurationService.getValue<boolean>(PRIMAL_START_PAGE_ENABLED_SETTING_ID)) {
			return false; // opted out
		}

		if (this.environmentService.skipWelcome) {
			return false; // `--skip-welcome`
		}

		if (this.lifecycleService.startupKind === StartupKind.ReloadedWindow) {
			return false; // a reload is not a new window
		}

		if (AuxiliaryBarMaximizedContext.getValue(this.contextKeyService)) {
			return false; // the maximized auxiliary bar (chat) owns the window
		}

		// If anything selects an upstream startup editor, that wins:
		// `StartupPageRunnerContribution` also runs in `AfterRestored` and would open
		// its page alongside ours. The *effective* value is what upstream's
		// `isStartupPageEnabled` tests, so it is what we must test too — a user or
		// workspace setting and an experiment treatment (applied as a default
		// override) all surface there, while our flipped default of 'none' does not.
		const startupEditor = this.configurationService.inspect<string>(UPSTREAM_STARTUP_EDITOR_SETTING_ID);
		if (startupEditor.value !== undefined && startupEditor.value !== 'none') {
			return false;
		}

		// Only when nothing was restored into the editor area. `openedDefaultEditors`
		// means the workbench itself opened the default editors, which upstream also
		// treats as "nothing of the user's was restored".
		if (this.editorService.activeEditor && !this.layoutService.openedDefaultEditors) {
			return false;
		}

		if (this.editorService.editors.some(editor => editor.typeId === PrimalStartInput.ID)) {
			return false; // never open it twice
		}

		return true;
	}

	/** Identical to upstream's `shouldPreserveFocus`: never steal focus from real work. */
	private shouldPreserveFocus(): boolean {
		const activeElement = getActiveElement();
		if (!activeElement || activeElement === mainWindow.document.body || this.layoutService.hasFocus(Parts.EDITOR_PART)) {
			return false; // steal focus if nothing meaningful is focused or the editor area has focus
		}

		return true; // do not steal focus
	}
}

registerWorkbenchContribution2(PrimalStartRunnerContribution.ID, PrimalStartRunnerContribution, WorkbenchPhase.AfterRestored);
