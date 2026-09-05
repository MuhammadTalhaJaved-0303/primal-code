/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { EditorCloseContext, IEditorIdentifier } from '../../../common/editor.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ChatViewId } from '../../chat/browser/chat.js';
import { IPrimalDeckService } from './primalDeck.js';
import { PrimalDeckInput } from './primalDeckInput.js';

/**
 * Workspace-scoped record of the parts the Deck hid, kept on disk until the
 * Deck restores them - the same idea as zen mode's exit info, so a reload
 * while the Deck is open cannot strand the parts hidden.
 */
const PARTS_SNAPSHOT_STORAGE_KEY = 'primalCode.deck.hiddenParts';

/** Which of the two parts the Deck hides were visible when it opened, i.e. must come back. */
interface IDeckPartsSnapshot {
	readonly sideBar: boolean;
	readonly panel: boolean;
}

function isDeckPartsSnapshot(value: unknown): value is IDeckPartsSnapshot {
	return typeof value === 'object' && value !== null
		&& typeof (value as IDeckPartsSnapshot).sideBar === 'boolean'
		&& typeof (value as IDeckPartsSnapshot).panel === 'boolean';
}

/**
 * Enter: snapshot, hide, keep chat, open the pane. Leave: close the pane, and
 * the close - however it happened - puts back exactly the parts that were
 * visible. The auxiliary bar is never touched: the chat is the agent.
 */
export class PrimalDeckService extends Disposable implements IPrimalDeckService {

	declare readonly _serviceBrand: undefined;

	/** Listeners that live only while a Deck tab is open. */
	private readonly openListeners = this._register(new DisposableStore());
	private snapshot: IDeckPartsSnapshot | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	get isOpen(): boolean {
		return this.findOpenInput() !== undefined;
	}

	private findOpenInput(): PrimalDeckInput | undefined {
		return this.editorService.editors.find((editor): editor is PrimalDeckInput => editor instanceof PrimalDeckInput);
	}

	async toggle(): Promise<void> {
		if (this.isOpen) {
			await this.leave();
		} else {
			await this.enter();
		}
	}

	async enter(): Promise<void> {
		const existing = this.findOpenInput();
		if (existing) {
			await this.editorService.openEditor(existing, { pinned: true }); // reveal the open tab
			return;
		}

		const snapshot = this.captureSnapshot();
		this.snapshot = snapshot;
		this.storageService.store(PARTS_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		// Hide before opening the pane: hiding the side bar moves focus
		// (layout.ts focusPanelOrEditor), and the pane must end up with it.
		if (snapshot.sideBar) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		}
		if (snapshot.panel) {
			this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		}

		// The chat IS the agent: make sure its view is on screen. Opening the
		// view un-hides its part itself (paneCompositePart.doOpenPaneComposite);
		// `focus: false` leaves focus for the Deck.
		try {
			await this.viewsService.openView(ChatViewId, false);
		} catch (error) {
			this.logService.warn('[PrimalDeck] could not open the chat view', error);
		}

		const input = new PrimalDeckInput();
		this.watch(input);
		const pane = await this.editorService.openEditor(input, { pinned: true });
		if (!pane) {
			// Nothing will ever dispose an input no group took; put the parts back now.
			this.logService.warn('[PrimalDeck] the Deck pane could not be opened');
			input.dispose();
			this.restoreParts();
		}
	}

	async leave(): Promise<void> {
		const input = this.findOpenInput();
		if (!input) {
			this.restoreParts(); // nothing open, but a remembered layout may still be pending
			return;
		}

		const identifiers: IEditorIdentifier[] = [];
		for (const group of this.editorGroupsService.groups) {
			if (group.contains(input)) {
				identifiers.push({ groupId: group.id, editor: input });
			}
		}
		await this.editorService.closeEditors(identifiers);

		// The close disposes the input, which restores the parts. If it did not
		// (the Deck is never dirty, so a veto is not expected), restore anyway.
		if (!this.isOpen) {
			this.restoreParts();
		}
	}

	adoptRestoredDeck(): void {
		const existing = this.findOpenInput();
		if (existing) {
			this.snapshot = this.readStoredSnapshot();
			this.watch(existing);
			return;
		}
		if (this.readStoredSnapshot()) {
			this.restoreParts();
		}
	}

	/**
	 * A part counts as "ours to hide" only when it is visible now and does not
	 * host the chat view: if the user moved chat into the side bar or panel,
	 * hiding that part would hide the agent, so it is left alone (and, being
	 * left alone, is not restored either).
	 */
	private captureSnapshot(): IDeckPartsSnapshot {
		const chatLocation = this.viewDescriptorService.getViewLocationById(ChatViewId);
		return {
			sideBar: chatLocation !== ViewContainerLocation.Sidebar && this.layoutService.isVisible(Parts.SIDEBAR_PART),
			panel: chatLocation !== ViewContainerLocation.Panel && this.layoutService.isVisible(Parts.PANEL_PART),
		};
	}

	/**
	 * `onWillDispose` fires exactly when the last group closes the input and
	 * never on a move between groups (the group keeps a singleton alive while
	 * another group still shows it). The close event is belt and braces for a
	 * close that did not dispose.
	 */
	private watch(input: PrimalDeckInput): void {
		this.openListeners.clear();
		this.openListeners.add(Event.once(input.onWillDispose)(() => this.restoreParts()));
		this.openListeners.add(this.editorService.onDidCloseEditor(event => {
			if (event.editor === input && event.context !== EditorCloseContext.MOVE && !this.isOpen) {
				this.restoreParts();
			}
		}));
	}

	/** Idempotent: the first call after a snapshot restores; later calls find nothing to do. */
	private restoreParts(): void {
		const snapshot = this.snapshot ?? this.readStoredSnapshot();
		this.snapshot = undefined;
		this.openListeners.clear();
		this.storageService.remove(PARTS_SNAPSHOT_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!snapshot) {
			return;
		}
		if (snapshot.sideBar) {
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		}
		if (snapshot.panel) {
			this.layoutService.setPartHidden(false, Parts.PANEL_PART);
		}
	}

	private readStoredSnapshot(): IDeckPartsSnapshot | undefined {
		const raw = this.storageService.get(PARTS_SNAPSHOT_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return isDeckPartsSnapshot(parsed) ? parsed : undefined;
		} catch (error) {
			this.logService.warn('[PrimalDeck] discarding an unreadable layout snapshot', error);
			return undefined;
		}
	}
}
