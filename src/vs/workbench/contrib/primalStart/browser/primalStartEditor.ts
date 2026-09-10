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
import { IDisposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ACTION_ID_NEW_CHAT, CHAT_OPEN_ACTION_ID } from '../../chat/browser/actions/chatActions.js';
import { IPrimalMotifService, PRIMAL_MOTIF_STAGE_CLASS } from '../../primalMotif/browser/primalMotif.js';
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

	//#region Motif stage

	/**
	 * The element this pane offers the motif layer as a host, and the workbench
	 * container it was found in. The pane owns the element; the motif service
	 * only mounts its one surface into it.
	 */
	private stage: HTMLElement | undefined;
	private workbenchContainer: HTMLElement | undefined;
	private targetWindow: Window | undefined;

	/**
	 * The live offer, or nothing while this pane is not on screen.
	 *
	 * A `MutableDisposable` because the offer is withdrawn and remade every time
	 * the pane is shown and hidden, which is often, and it must never be possible
	 * to hold two.
	 */
	private readonly stageRegistration = this._register(new MutableDisposable<IDisposable>());

	/** The last size `layout` was given, so a layout that changed nothing costs nothing. */
	private stageWidth = 0;
	private stageHeight = 0;

	//#endregion

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
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPrimalMotifService private readonly motifService: IPrimalMotifService,
	) {
		super(PrimalStartEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.vibeCards.clear();

		// The offer names an element, so it cannot outlive the element it named.
		this.stageRegistration.clear();

		// The pane is the stacking context the stage and the page are ordered
		// inside. Without it, `.editor-instance` is statically positioned (it is
		// given nothing but `height: 100%` by editorgroupview.css) and an
		// `inset: 0` layer would size itself to the nearest positioned ancestor -
		// `.split-view-view`, which includes the tab strip - and escape this
		// pane's own clip. `isolation: isolate` in primalStart.css is what makes
		// the z-index pair below a guarantee rather than an accident against the
		// editor part's own pseudo-elements at 10 and the sashes at 35.
		parent.classList.add('primal-start-pane');

		this.targetWindow = DOM.getWindow(parent);
		this.workbenchContainer = this.layoutService.getContainer(this.targetWindow);

		// Before the scroll container and as its sibling, never inside it:
		// `.primal-start-editor` is `overflow-y: auto`, so a stage within it
		// would scroll away from the page it is the ground for.
		this.stage = DOM.append(parent, $('.' + PRIMAL_MOTIF_STAGE_CLASS, { 'aria-hidden': 'true' }));

		// The document going hidden is as good as the pane going hidden: a loop
		// rendering into a canvas nobody can see costs exactly what a visible one
		// costs. This mirrors the rule primalDeckEditor.ts uses.
		this.editorDisposables.add(DOM.addDisposableListener(this.targetWindow.document, 'visibilitychange', () => this.updateStage()));

		this.scrollContainer = DOM.append(parent, $('.primal-start-editor'));
		const page = DOM.append(this.scrollContainer, $('.primal-start-page'));

		this.renderHero(page);
		this.renderActions(page);
		this.renderVibeStrip(page);
		this.renderRecents(page);
		this.renderFooter(page);

		// A no-op unless this pane is already the visible one, which is the case
		// `setInput` would otherwise be the first to notice.
		this.updateStage();
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

	//#region Motif stage

	/**
	 * The single decision: this pane offers itself as the motif's host exactly
	 * while it is the visible pane in a visible document.
	 *
	 * `setEditorVisible` and not `Composite.setVisible` is the hook, because
	 * `EditorPanes` removes `.editor-instance` from the DOM on an editor switch
	 * while this object survives, and `requestAnimationFrame` fires per window
	 * rather than per element - so a stage left registered from a detached pane
	 * would keep the window's whole loop pointed at a canvas nobody can see.
	 * Withdrawing the offer hands the surface to whichever other code-free pane
	 * in this window is still offering itself, or back to the wallpaper layer,
	 * which is visible - so nothing is lost by it either way.
	 *
	 * The early return may safely be read off this pane's own registration: the
	 * scheduler keeps every live offer rather than only the newest, so a handle
	 * this pane holds is always an offer the scheduler still knows about. It
	 * would be a latch if a second pane could supersede it silently.
	 */
	private updateStage(): void {
		const stage = this.stage;
		const container = this.workbenchContainer;
		const shouldHost = !!stage && !!container && this.isVisible() && this.targetWindow?.document.visibilityState === 'visible';

		if (shouldHost === !!this.stageRegistration.value) {
			return;
		}

		if (!shouldHost) {
			this.stageRegistration.clear();
			return;
		}

		this.stageRegistration.value = this.motifService.registerStage(container, stage);
	}

	//#endregion

	override async setInput(input: PrimalStartInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.updateStage();

		// Recents may have changed while the page sat in the background.
		await this.updateRecents();
	}

	override clearInput(): void {
		super.clearInput();
		this.updateStage();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.updateStage();
	}

	override focus(): void {
		super.focus();
		this.firstActionButton?.focus();
	}

	override layout(dimension: Dimension): void {
		this.scrollContainer?.classList.toggle('narrow', dimension.width < NARROW_WIDTH_THRESHOLD);

		// The motif's own `onDidLayoutContainer` hook fires on *container* layout,
		// and an editor resize is not one of those, so the surface would keep the
		// size it was built at and draw the globe as an ellipse. Only a size that
		// actually changed is forwarded: a sash drag is a great many layouts.
		if (dimension.width === this.stageWidth && dimension.height === this.stageHeight) {
			return;
		}

		this.stageWidth = dimension.width;
		this.stageHeight = dimension.height;

		// `relayout` and NOT `trigger`. A trigger is what the owner did something
		// for: it re-resolves the whole ladder and re-arms the frame chain at
		// `now`, which throws away the plan's frame-rate ceiling until the next
		// pass. `EditorGroupView` calls this once per mouse-move of a sash drag,
		// so triggering here would render the globe at the display's cadence
		// rather than at the 30fps the ladder chose, synchronously inside the
		// workbench's own layout pass, for as long as the drag lasted. A resize
		// asks for none of that; it asks to be re-measured.
		if (this.stageRegistration.value && this.workbenchContainer) {
			this.motifService.relayout(this.workbenchContainer);
		}
	}
}
