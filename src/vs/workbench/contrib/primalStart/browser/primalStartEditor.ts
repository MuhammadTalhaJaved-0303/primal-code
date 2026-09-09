/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalStart.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { splitRecentLabel } from '../../../../base/common/labels.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isNative } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWindowOpenable } from '../../../../platform/window/common/window.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder } from '../../../../platform/workspaces/common/workspaces.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ACTION_ID_NEW_CHAT, CHAT_OPEN_ACTION_ID } from '../../chat/browser/actions/chatActions.js';
import { PRIMAL_THEME_GALLERY_COMMAND_ID } from '../../primalThemeGallery/common/primalThemeGallery.js';
import { IPrimalVibe, IPrimalVibeService, PRIMAL_VIBES, PRIMAL_VIBE_CYCLE_COMMAND_ID, PRIMAL_VIBE_PICK_COMMAND_ID } from '../../primalVibes/browser/primalVibes.js';
import { PrimalStartInput } from './primalStartInput.js';

const $ = DOM.$;

/** How many recent projects the page lists. */
const MAX_RECENT_ENTRIES = 6;

/** Below this editor width the page drops to a single-column, tighter layout. */
const NARROW_WIDTH_THRESHOLD = 640;

/** The platform-correct project picker, mirroring the entries the Get Started page
 * contributes (`gettingStartedContent.ts`: `topLevelOpenMac` for `!isWeb && isMac`,
 * `topLevelOpenFolder` otherwise). */
const OPEN_PROJECT_COMMAND_ID = isMacintosh && isNative
	? 'workbench.action.files.openFileFolder'
	: 'workbench.action.files.openFolder';

/** Contributed by the built-in Git extension (`extensions/git/package.json`). */
const GIT_CLONE_COMMAND_ID = 'git.clone';

/** One primary action slab. */
interface IStartAction {
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly keybindingCommandId: string;
	readonly run: () => Promise<unknown>;
}

/** Mini palette preview colors for one vibe card. */
interface IVibeSwatchColors {
	readonly editorBg: string;
	readonly chromeBg: string;
	readonly accent: string;
}

/**
 * Seed colors mirroring `primal/design/vibe-tokens.json`. The cards must
 * preview each vibe *before* its theme is applied, so the seeds are inlined
 * here; everything else on this page is painted from `--vscode-*` tokens and
 * therefore follows the active vibe.
 */
const VIBE_SWATCH_COLORS: ReadonlyMap<string, IVibeSwatchColors> = new Map([
	['ink', { editorBg: '#FAF9F6', chromeBg: '#EFECE6', accent: '#1C1A18' }],
	['basalt', { editorBg: '#131211', chromeBg: '#1C1A19', accent: '#E8E4DE' }],
	['tide', { editorBg: '#0E1621', chromeBg: '#152030', accent: '#7FB4E8' }],
	['dusk', { editorBg: '#191521', chromeBg: '#221D2E', accent: '#C4A9E0' }],
	['fern', { editorBg: '#121A15', chromeBg: '#18241C', accent: '#9CCDAA' }],
	['ridge', { editorBg: '#F8F3EC', chromeBg: '#EFE6D9', accent: '#4A3B2A' }]
]);

/** Vibe labels are product names ('Primal Ink'); the cards show the short half. */
function shortVibeName(vibe: IPrimalVibe): string {
	const prefix = 'Primal ';
	return vibe.label.startsWith(prefix) ? vibe.label.substring(prefix.length) : vibe.label;
}

/**
 * The Primal Start page: wordmark hero, the three primary actions (new agent
 * chat, open project, clone repository), the six-vibe strip, recent projects
 * and a keyboard-shortcut footer. Replaces the Getting Started welcome page as
 * the startup editor — see `primalStart.contribution.ts`.
 */
export class PrimalStartEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.primalStart';

	private readonly editorDisposables = this._register(new DisposableStore());
	private readonly recentEntryDisposables = this._register(new DisposableStore());
	private readonly vibeCards = new Map<string, HTMLButtonElement>();
	private scrollContainer: HTMLElement | undefined;
	private firstActionButton: HTMLButtonElement | undefined;
	private recentsSection: HTMLElement | undefined;
	private recentsList: HTMLElement | undefined;
	private recentsRenderToken = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IHostService private readonly hostService: IHostService,
		@ILabelService private readonly labelService: ILabelService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(PrimalStartEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.vibeCards.clear();

		this.scrollContainer = DOM.append(parent, $('.primal-start-editor'));
		const page = DOM.append(this.scrollContainer, $('.primal-start-page'));

		this.renderHero(page);
		this.renderActions(page);
		this.renderVibeStrip(page);
		this.renderRecents(page);
		this.renderFooter(page);
	}

	//#region Hero

	private renderHero(page: HTMLElement): void {
		const hero = DOM.append(page, $('.primal-start-hero'));
		// Product name — deliberately not localized.
		DOM.append(hero, $('h1.primal-start-wordmark', undefined, 'Primal Code'));
		DOM.append(hero, $('p.primal-start-tagline', undefined, localize('primalStart.tagline', "The agent-native code editor")));
	}

	//#endregion

	//#region Primary actions

	private renderActions(page: HTMLElement): void {
		const actions = DOM.append(page, $('.primal-start-actions'));

		this.firstActionButton = this.renderActionButton(actions, {
			icon: Codicon.chatSparkle,
			label: localize('primalStart.newAgentChat', "New Agent Chat"),
			keybindingCommandId: CHAT_OPEN_ACTION_ID,
			run: async () => {
				// Reveal the chat surface first: on a fresh window no chat widget
				// exists yet and `ACTION_ID_NEW_CHAT` then no-ops (runNewChatAction
				// in chatNewActions.ts returns early when the resolved context has
				// no widget). Opening first guarantees a widget, so the follow-up
				// reliably starts a *new* session. Neither command needs a
				// workspace — both operate purely on the chat widget.
				await this.commandService.executeCommand(CHAT_OPEN_ACTION_ID);
				await this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
			}
		});

		this.renderActionButton(actions, {
			icon: Codicon.folderOpened,
			label: localize('primalStart.openProject', "Open Project..."),
			keybindingCommandId: OPEN_PROJECT_COMMAND_ID,
			run: () => this.commandService.executeCommand(OPEN_PROJECT_COMMAND_ID)
		});

		this.renderActionButton(actions, {
			icon: Codicon.repoClone,
			label: localize('primalStart.cloneRepository', "Clone Repository..."),
			keybindingCommandId: GIT_CLONE_COMMAND_ID,
			run: () => this.commandService.executeCommand(GIT_CLONE_COMMAND_ID)
		});
	}

	private renderActionButton(container: HTMLElement, action: IStartAction): HTMLButtonElement {
		const button = DOM.append(container, $('button.primal-start-action')) as HTMLButtonElement;
		button.type = 'button';
		DOM.append(button, $('span.primal-start-action-icon' + ThemeIcon.asCSSSelector(action.icon)));
		DOM.append(button, $('span.primal-start-action-label', undefined, action.label));

		const keybinding = this.keybindingLabel(action.keybindingCommandId);
		if (keybinding) {
			DOM.append(button, $('span.primal-start-kbd', undefined, keybinding));
		}

		this.editorDisposables.add(DOM.addDisposableListener(button, 'click', () => {
			action.run().catch(onUnexpectedError);
		}));

		return button;
	}

	//#endregion

	//#region Vibe strip

	private renderVibeStrip(page: HTMLElement): void {
		const section = DOM.append(page, $('.primal-start-section'));
		DOM.append(section, $('.primal-start-section-label', undefined, localize('primalStart.vibes', "Vibe")));
		const strip = DOM.append(section, $('.primal-start-vibes'));

		for (const vibe of PRIMAL_VIBES) {
			this.renderVibeCard(strip, vibe);
		}

		this.markCurrentVibe(this.vibeService.currentVibe);
		this.editorDisposables.add(this.vibeService.onDidChangeVibe(vibe => this.markCurrentVibe(vibe)));
	}

	private renderVibeCard(strip: HTMLElement, vibe: IPrimalVibe): void {
		const card = DOM.append(strip, $('button.primal-start-vibe-card')) as HTMLButtonElement;
		card.type = 'button';
		card.setAttribute('aria-label', localize('primalStart.applyVibe', "Apply the {0} vibe", vibe.label));

		// Mini palette preview in the Slab language: chrome ground, editor slab
		// with a top radius, accent mark.
		const colors = VIBE_SWATCH_COLORS.get(vibe.id);
		const swatch = DOM.append(card, $('.primal-start-vibe-swatch'));
		if (colors) {
			swatch.style.backgroundColor = colors.chromeBg;
			const slab = DOM.append(swatch, $('.primal-start-vibe-slab'));
			slab.style.backgroundColor = colors.editorBg;
			const accent = DOM.append(slab, $('.primal-start-vibe-accent'));
			accent.style.backgroundColor = colors.accent;
		}

		const nameRow = DOM.append(card, $('.primal-start-vibe-name'));
		// The active vibe is marked by shape (a check glyph) and border weight,
		// never by hue alone — see the color-blindness rule in vibe-tokens.json.
		DOM.append(nameRow, $('span.primal-start-vibe-check' + ThemeIcon.asCSSSelector(Codicon.check)));
		DOM.append(nameRow, $('span.primal-start-vibe-label', undefined, shortVibeName(vibe)));

		this.editorDisposables.add(DOM.addDisposableListener(card, 'click', () => {
			this.vibeService.applyVibe(vibe.id).catch(onUnexpectedError);
		}));

		this.vibeCards.set(vibe.id, card);
	}

	private markCurrentVibe(current: IPrimalVibe | undefined): void {
		for (const [id, card] of this.vibeCards) {
			const isCurrent = current?.id === id;
			card.classList.toggle('current', isCurrent);
			card.setAttribute('aria-pressed', String(isCurrent));
		}
	}

	//#endregion

	//#region Recent projects

	private renderRecents(page: HTMLElement): void {
		this.recentsSection = DOM.append(page, $('.primal-start-section.primal-start-recents-section.empty'));
		DOM.append(this.recentsSection, $('.primal-start-section-label', undefined, localize('primalStart.recent', "Recent")));
		this.recentsList = DOM.append(this.recentsSection, $('.primal-start-recents'));

		this.updateRecents().catch(onUnexpectedError);
		this.editorDisposables.add(this.workspacesService.onDidChangeRecentlyOpened(() => {
			this.updateRecents().catch(onUnexpectedError);
		}));
		// Remote and virtual-workspace label formatters are contributed by extensions
		// that activate after this pane first renders; without this the affected
		// recents keep showing raw URIs. Upstream's recents list does the same.
		this.editorDisposables.add(this.labelService.onDidChangeFormatters(() => {
			this.updateRecents().catch(onUnexpectedError);
		}));
	}

	private async updateRecents(): Promise<void> {
		const list = this.recentsList;
		const section = this.recentsSection;
		if (!list || !section) {
			return;
		}

		const token = ++this.recentsRenderToken;

		let entries: ReadonlyArray<IRecentWorkspace | IRecentFolder>;
		try {
			entries = (await this.workspacesService.getRecentlyOpened()).workspaces.slice(0, MAX_RECENT_ENTRIES);
		} catch (error) {
			onUnexpectedError(error);
			entries = [];
		}

		if (token !== this.recentsRenderToken) {
			return; // superseded by a newer render
		}

		this.recentEntryDisposables.clear();
		DOM.clearNode(list);
		section.classList.toggle('empty', entries.length === 0);

		for (const entry of entries) {
			this.renderRecentEntry(list, entry);
		}
	}

	private renderRecentEntry(list: HTMLElement, entry: IRecentWorkspace | IRecentFolder): void {
		let openable: IWindowOpenable;
		let fullPath: string;
		if (isRecentFolder(entry)) {
			openable = { folderUri: entry.folderUri };
			fullPath = entry.label || this.labelService.getWorkspaceLabel(entry.folderUri, { verbose: Verbosity.LONG });
		} else {
			openable = { workspaceUri: entry.workspace.configPath };
			fullPath = entry.label || this.labelService.getWorkspaceLabel(entry.workspace, { verbose: Verbosity.LONG });
		}

		const { name, parentPath } = splitRecentLabel(fullPath);

		const row = DOM.append(list, $('button.primal-start-recent')) as HTMLButtonElement;
		row.type = 'button';
		row.title = fullPath;
		row.setAttribute('aria-label', localize('primalStart.openRecentAria', "Open recent project {0} with path {1}", name, parentPath));
		DOM.append(row, $('span.primal-start-recent-name', undefined, name));
		DOM.append(row, $('span.primal-start-recent-path', undefined, parentPath));

		this.recentEntryDisposables.add(DOM.addDisposableListener(row, 'click', e => {
			// Same opening behavior as the Get Started page's recents list
			// (welcomeGettingStarted/browser/gettingStarted.ts, buildRecentlyOpenedList).
			this.hostService.openWindow([openable], {
				forceNewWindow: e.ctrlKey || e.metaKey,
				remoteAuthority: entry.remoteAuthority || null // local window if remoteAuthority is not set or can not be deducted from the openable
			}).catch(onUnexpectedError);
			e.preventDefault();
			e.stopPropagation();
		}));
	}

	//#endregion

	//#region Footer

	private renderFooter(page: HTMLElement): void {
		const footer = DOM.append(page, $('.primal-start-footer'));

		const hints: ReadonlyArray<{ readonly commandId: string; readonly text: string }> = [
			{ commandId: PRIMAL_VIBE_CYCLE_COMMAND_ID, text: localize('primalStart.hint.cycleVibes', "cycle vibes") },
			{ commandId: PRIMAL_VIBE_PICK_COMMAND_ID, text: localize('primalStart.hint.pickVibe', "pick vibe") },
			// The way out of the six-card strip and into the whole catalogue. It sits
			// in the footer rather than in the strip because the strip is a fixed
			// six-column grid: a seventh child would reflow it.
			{ commandId: PRIMAL_THEME_GALLERY_COMMAND_ID, text: localize('primalStart.hint.browseThemes', "browse themes") },
			{ commandId: CHAT_OPEN_ACTION_ID, text: localize('primalStart.hint.chat', "chat") }
		];

		let rendered = 0;
		for (const { commandId, text } of hints) {
			const keybinding = this.keybindingLabel(commandId);
			if (!keybinding) {
				continue; // unbound on this platform / profile: no hint to give
			}
			if (rendered > 0) {
				DOM.append(footer, $('span.primal-start-footer-separator', undefined, '·'));
			}
			const hint = DOM.append(footer, $('span.primal-start-footer-hint'));
			DOM.append(hint, $('span.primal-start-kbd', undefined, keybinding));
			DOM.append(hint, $('span.primal-start-footer-text', undefined, text));
			rendered++;
		}
	}

	//#endregion

	/** The user-facing keybinding label for a command, or `undefined` when unbound. */
	private keybindingLabel(commandId: string): string | undefined {
		return this.keybindingService.lookupKeybinding(commandId)?.getLabel() ?? undefined;
	}

	override async setInput(input: PrimalStartInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		// Recents may have changed while the page sat in the background.
		await this.updateRecents();
	}

	override focus(): void {
		super.focus();
		this.firstActionButton?.focus();
	}

	override layout(dimension: Dimension): void {
		this.scrollContainer?.classList.toggle('narrow', dimension.width < NARROW_WIDTH_THRESHOLD);
	}
}
