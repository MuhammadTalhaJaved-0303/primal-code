/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalRig.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { splitRecentLabel } from '../../../../base/common/labels.js';
import { DisposableMap, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWindowOpenable } from '../../../../platform/window/common/window.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder } from '../../../../platform/workspaces/common/workspaces.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ACTION_ID_NEW_CHAT, CHAT_OPEN_ACTION_ID } from '../../chat/browser/actions/chatActions.js';
import { IAgentSessionsModel } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { openSession } from '../../chat/browser/agentSessions/agentSessionsOpener.js';
// Layering note: `IAgentSessionsService` is provider-internal to the Agents
// window, and eslint.config.js restricts it inside `src/vs/sessions/**`. That
// rule does not cover workbench contribs, and the main workbench already
// consumes it this way (agentsVoice/browser/agentsVoiceSessionsPicker.ts). The
// Rig only reads from it; it never drives the agent sessions model.
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';
import { IChatDetail, IChatService } from '../../chat/common/chatService/chatService.js';
import { IPrimalMotifService, PRIMAL_MOTIF_STAGE_CLASS } from '../../primalMotif/browser/primalMotif.js';
import { IPrimalVibe, IPrimalVibeService, PRIMAL_VIBE_CYCLE_COMMAND_ID, PRIMAL_VIBE_PICK_COMMAND_ID } from '../../primalVibes/browser/primalVibes.js';
import { PrimalRigInput } from './primalRigInput.js';
import { IRigSessionRow, agentSessionRows, countSessionsToday, liveSessionRows, mergeSessionRows } from './primalRigSessions.js';

const $ = DOM.$;

/** How many recent projects the Projects section lists. */
const MAX_PROJECT_ENTRIES = 6;

/** How many sessions the Agent activity section lists. */
const MAX_SESSION_ENTRIES = 6;

/** Coalescing window for live chat model churn; one streaming response fires many events. */
const LIVE_REFRESH_DELAY = 500;

/** Below this editor width the page drops to a single-column, tighter layout. */
const NARROW_WIDTH_THRESHOLD = 640;

/** One shortcut hint in the footer row. */
interface IShortcutHint {
	readonly commandId: string;
	readonly text: string;
}

/** A status the page can actually source, as a glyph and a word. */
interface IStatusPresentation {
	readonly icon: ThemeIcon;
	readonly label: string;
}

/**
 * The Rig - the home console: projects, agent activity and today, painted from
 * theme tokens so every vibe restyles it.
 *
 * Every claim on this page is read off recorded state. Where a datum does not
 * exist (a recent project's last-opened time, its git branch, agent spend) the
 * page shows nothing at all rather than a placeholder - see
 * `primal/design/rig-spec.md`, "Truthfulness rule".
 *
 * Startup contract: `createEditor` is fully synchronous. Recents, the agent
 * sessions model and today's count all land afterwards, into sections that are
 * already on screen in an honest empty state.
 */
export class PrimalRigEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.primalRig';

	/** Lives as long as the pane. */
	private readonly editorDisposables = this._register(new DisposableStore());
	/** Cleared on every Projects re-render. */
	private readonly projectEntryDisposables = this._register(new DisposableStore());
	/** Cleared on every Agent activity re-render. */
	private readonly sessionEntryDisposables = this._register(new DisposableStore());
	/** One `onDidChange` listener per live chat model, keyed by session resource. */
	private readonly liveModelListeners = this._register(new DisposableMap<string>());

	private scrollContainer: HTMLElement | undefined;
	private primaryActionButton: HTMLButtonElement | undefined;

	//#region Motif stage

	/**
	 * The mechanism is the Start page's, verbatim - see the same region in
	 * `primalStart/browser/primalStartEditor.ts` for why each piece is here.
	 *
	 * It is duplicated rather than shared because `primalCode.startPage.surface`
	 * is `'start' | 'rig' | 'none'`: whichever page got the stage alone, the
	 * feature would be invisible for the half of users who chose the other. Only
	 * one of the two is ever the visible pane, so the one-surface-per-window
	 * budget is unaffected.
	 */
	private stage: HTMLElement | undefined;
	private workbenchContainer: HTMLElement | undefined;
	private targetWindow: Window | undefined;
	private readonly stageRegistration = this._register(new MutableDisposable<IDisposable>());
	private stageWidth = 0;
	private stageHeight = 0;

	//#endregion
	private vibeChip: HTMLButtonElement | undefined;
	private vibeChipLabel: HTMLElement | undefined;

	private projectsSection: HTMLElement | undefined;
	private projectsList: HTMLElement | undefined;
	/** Guards against a slow recents resolve overwriting a newer render. */
	private projectsRenderToken = 0;

	private sessionsSection: HTMLElement | undefined;
	private sessionsList: HTMLElement | undefined;
	/** What the Agent activity list currently shows; skips no-op DOM rebuilds. */
	private sessionsSignature: string | undefined;

	private todaySection: HTMLElement | undefined;
	private todayValue: HTMLElement | undefined;
	private todayCaptionLabel: HTMLElement | undefined;
	/** Guards against a slow today resolve overwriting a newer render. */
	private todayRenderToken = 0;

	/**
	 * Set only once the pane has painted. Reading `IAgentSessionsService.model`
	 * builds the model and immediately resolves every registered provider
	 * (extension host RPC, and network for cloud providers), so it must never be
	 * touched on the render path.
	 */
	private agentSessionsModel: IAgentSessionsModel | undefined;

	/**
	 * The session providers whose resolve pass has completed, by
	 * `IAgentSession.providerType`. `IAgentSessionsModel.resolved` cannot stand
	 * in for this: it flips as soon as the FIRST provider resolves, while every
	 * other provider's sessions are still the cache-loaded ones - and the cache
	 * rewrites in-progress sessions to "completed" before storing them. Kept
	 * across a re-render because a provider that has reported stays reported for
	 * the model's lifetime, and the model outlives this pane's DOM.
	 */
	private readonly resolvedSessionProviders = new Set<string>();

	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => this.refreshLiveSections(), LIVE_REFRESH_DELAY));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IHostService private readonly hostService: IHostService,
		@ILabelService private readonly labelService: ILabelService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IChatService private readonly chatService: IChatService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPrimalMotifService private readonly motifService: IPrimalMotifService,
	) {
		super(PrimalRigEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.sessionsSignature = undefined; // the list DOM below is new; nothing is rendered yet

		// The offer names an element, so it cannot outlive the element it named.
		this.stageRegistration.clear();

		// The pane is the stacking context the stage and the page are ordered
		// inside. `.editor-instance` is given nothing but `height: 100%` by
		// editorgroupview.css, so without this an `inset: 0` layer would size
		// itself to the whole editor-group box - tab strip included - and escape
		// this pane's clip. See primalRig.css.
		parent.classList.add('primal-rig-pane');

		this.targetWindow = DOM.getWindow(parent);
		this.workbenchContainer = this.layoutService.getContainer(this.targetWindow);

		// Before the scroll container and as its sibling: `.primal-rig-editor` is
		// `overflow-y: auto`, so a stage inside it would scroll away.
		this.stage = DOM.append(parent, $('.' + PRIMAL_MOTIF_STAGE_CLASS, { 'aria-hidden': 'true' }));
		this.editorDisposables.add(DOM.addDisposableListener(this.targetWindow.document, 'visibilitychange', () => this.updateStage()));

		this.scrollContainer = DOM.append(parent, $('.primal-rig-editor'));
		const page = DOM.append(this.scrollContainer, $('.primal-rig-page'));

		this.renderHeader(page);
		this.renderProjects(page);
		this.renderAgentActivity(page);
		this.renderToday(page);
		this.renderFooter(page);

		this.scheduleDeferredLoad(parent);

		// A no-op unless this pane is already the visible one, which is the case
		// `setInput` would otherwise be the first to notice.
		this.updateStage();
	}

	//#region Header

	private renderHeader(page: HTMLElement): void {
		const header = DOM.append(page, $('.primal-rig-header'));

		// Product name - deliberately not localized.
		DOM.append(header, $('h1.primal-rig-wordmark', undefined, 'Primal Code'));

		const actions = DOM.append(header, $('.primal-rig-header-actions'));
		this.renderVibeChip(actions);
		this.primaryActionButton = this.renderPrimaryAction(actions);
	}

	private renderVibeChip(container: HTMLElement): void {
		const chip = DOM.append(container, $('button.primal-rig-vibe-chip')) as HTMLButtonElement;
		chip.type = 'button';
		this.vibeChip = chip;
		DOM.append(chip, $('span.primal-rig-vibe-icon' + ThemeIcon.asCSSSelector(Codicon.paintcan)));
		this.vibeChipLabel = DOM.append(chip, $('span.primal-rig-vibe-label'));

		this.updateVibeChip(this.vibeService.currentVibe);
		this.editorDisposables.add(this.vibeService.onDidChangeVibe(vibe => this.updateVibeChip(vibe)));

		this.editorDisposables.add(DOM.addDisposableListener(chip, 'click', () => {
			this.commandService.executeCommand(PRIMAL_VIBE_PICK_COMMAND_ID).catch(onUnexpectedError);
		}));
	}

	/**
	 * `undefined` is a real state - the user picked a theme outside every vibe -
	 * so it is labelled as such instead of guessing a vibe.
	 */
	private updateVibeChip(vibe: IPrimalVibe | undefined): void {
		const chip = this.vibeChip;
		const chipLabel = this.vibeChipLabel;
		if (!chip || !chipLabel) {
			return;
		}

		const label = vibe?.label ?? localize('primalRig.vibe.custom', "Custom");
		chipLabel.textContent = label;
		chip.setAttribute('aria-label', localize('primalRig.vibe.aria', "Vibe: {0}. Pick a vibe", label));
	}

	private renderPrimaryAction(container: HTMLElement): HTMLButtonElement {
		const button = DOM.append(container, $('button.primal-rig-primary')) as HTMLButtonElement;
		button.type = 'button';
		DOM.append(button, $('span.primal-rig-primary-icon' + ThemeIcon.asCSSSelector(Codicon.chatSparkle)));
		DOM.append(button, $('span.primal-rig-primary-label', undefined, localize('primalRig.newAgentChat', "New Agent Chat")));

		const keybinding = this.keybindingLabel(CHAT_OPEN_ACTION_ID);
		if (keybinding) {
			DOM.append(button, $('span.primal-rig-kbd', undefined, keybinding));
		}

		this.editorDisposables.add(DOM.addDisposableListener(button, 'click', () => {
			this.startNewAgentChat().catch(onUnexpectedError);
		}));

		return button;
	}

	private async startNewAgentChat(): Promise<void> {
		// Reveal the chat surface first: on a fresh window no chat widget exists
		// yet and `ACTION_ID_NEW_CHAT` then no-ops. Same order as Primal Start.
		await this.commandService.executeCommand(CHAT_OPEN_ACTION_ID);
		await this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
	}

	//#endregion

	//#region Projects

	private renderProjects(page: HTMLElement): void {
		const section = this.createSection(page, localize('primalRig.projects', "Projects"), localize('primalRig.projects.empty', "No recent projects yet."));
		this.projectsSection = section.root;
		this.projectsList = section.list;

		this.updateProjects().catch(onUnexpectedError);

		this.editorDisposables.add(this.workspacesService.onDidChangeRecentlyOpened(() => {
			this.updateProjects().catch(onUnexpectedError);
		}));
		// Remote and virtual-workspace label formatters are contributed by
		// extensions that activate after this pane first renders; without this the
		// affected rows keep showing raw URIs.
		this.editorDisposables.add(this.labelService.onDidChangeFormatters(() => {
			this.updateProjects().catch(onUnexpectedError);
		}));
	}

	private async updateProjects(): Promise<void> {
		const list = this.projectsList;
		const section = this.projectsSection;
		if (!list || !section) {
			return;
		}

		const token = ++this.projectsRenderToken;

		let entries: ReadonlyArray<IRecentWorkspace | IRecentFolder>;
		try {
			entries = (await this.workspacesService.getRecentlyOpened()).workspaces.slice(0, MAX_PROJECT_ENTRIES);
		} catch (error) {
			onUnexpectedError(error);
			entries = [];
		}

		if (token !== this.projectsRenderToken) {
			return; // superseded by a newer render
		}

		this.projectEntryDisposables.clear();
		DOM.clearNode(list);
		section.classList.toggle('empty', entries.length === 0);

		for (const entry of entries) {
			this.renderProjectRow(list, entry);
		}
	}

	/**
	 * A project row carries name, dimmed path and nothing else. The recents
	 * pipeline records no last-opened time and no branch, so recency is carried
	 * by list position - the most-recent-first order the main process keeps - and
	 * never by a relative-time string that would have to be invented.
	 */
	private renderProjectRow(list: HTMLElement, entry: IRecentWorkspace | IRecentFolder): void {
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

		const row = DOM.append(list, $('button.primal-rig-row.primal-rig-project')) as HTMLButtonElement;
		row.type = 'button';
		row.title = fullPath;
		row.setAttribute('aria-label', localize('primalRig.openProjectAria', "Open recent project {0} with path {1}", name, parentPath));
		DOM.append(row, $('span.primal-rig-project-name', undefined, name));
		DOM.append(row, $('span.primal-rig-project-path', undefined, parentPath));

		this.projectEntryDisposables.add(DOM.addDisposableListener(row, 'click', e => {
			this.hostService.openWindow([openable], {
				forceNewWindow: e.ctrlKey || e.metaKey,
				remoteAuthority: entry.remoteAuthority || null // local window when no authority can be deduced
			}).catch(onUnexpectedError);
			e.preventDefault();
			e.stopPropagation();
		}));
	}

	//#endregion

	//#region Agent activity

	private renderAgentActivity(page: HTMLElement): void {
		const section = this.createSection(page, localize('primalRig.agentActivity', "Agent activity"), localize('primalRig.agentActivity.empty', "No agent sessions yet."));
		this.sessionsSection = section.root;
		this.sessionsList = section.list;

		// Synchronous first paint from the live chat models of this window: the
		// one zero-RPC source of running/waiting state. On a fresh window this is
		// legitimately empty, and the section says exactly that.
		this.attachLiveModelListeners();
		this.updateAgentActivity();

		this.editorDisposables.add(this.chatService.onDidCreateModel(() => {
			this.attachLiveModelListeners();
			this.refreshScheduler.schedule();
		}));
		this.editorDisposables.add(this.chatService.onDidDisposeSession(() => {
			this.attachLiveModelListeners();
			this.refreshScheduler.schedule();
		}));
	}

	/** Keeps exactly one change listener per live chat model. */
	private attachLiveModelListeners(): void {
		const alive = new Set<string>();

		for (const model of this.chatService.chatModels.get()) {
			const key = model.sessionResource.toString();
			alive.add(key);
			if (!this.liveModelListeners.has(key)) {
				this.liveModelListeners.set(key, model.onDidChange(() => this.refreshScheduler.schedule()));
			}
		}

		for (const key of Array.from(this.liveModelListeners.keys())) {
			if (!alive.has(key)) {
				this.liveModelListeners.deleteAndDispose(key);
			}
		}
	}

	/**
	 * Both live sections in one coalesced pass: the activity list and today's
	 * count move for the same reasons - a request starting, a session ending.
	 * Only ever reached from an event, so never before first paint.
	 */
	private refreshLiveSections(): void {
		this.updateAgentActivity();
		this.updateToday().catch(onUnexpectedError);
	}

	private updateAgentActivity(): void {
		const list = this.sessionsList;
		const section = this.sessionsSection;
		if (!list || !section) {
			return;
		}

		const model = this.agentSessionsModel;
		const rows = mergeSessionRows(
			liveSessionRows(this.chatService.chatModels.get()),
			model ? agentSessionRows(model.sessions, this.resolvedSessionProviders) : [],
			MAX_SESSION_ENTRIES
		);

		// Serialized rather than concatenated so no label can forge a row boundary.
		const signature = JSON.stringify(rows.map(row => [row.resource.toString(), row.label, row.status ?? '', this.relativeTime(row.timestamp) ?? '']));
		if (signature === this.sessionsSignature) {
			return; // nothing the user can see changed; leave focus where it is
		}
		this.sessionsSignature = signature;

		this.sessionEntryDisposables.clear();
		DOM.clearNode(list);
		section.classList.toggle('empty', rows.length === 0);

		for (const row of rows) {
			this.renderSessionRow(list, row);
		}
	}

	private renderSessionRow(list: HTMLElement, session: IRigSessionRow): void {
		const row = DOM.append(list, $('button.primal-rig-row.primal-rig-session')) as HTMLButtonElement;
		row.type = 'button';
		row.title = session.label;
		DOM.append(row, $('span.primal-rig-session-name', undefined, session.label));

		const status = this.statusPresentation(session.status);
		if (status) {
			// Status is marked by glyph AND word, never by hue alone.
			const chip = DOM.append(row, $('span.primal-rig-session-status'));
			DOM.append(chip, $('span.primal-rig-session-status-icon' + ThemeIcon.asCSSSelector(status.icon)));
			DOM.append(chip, $('span.primal-rig-session-status-label', undefined, status.label));
		}

		const relative = this.relativeTime(session.timestamp);
		if (relative) {
			DOM.append(row, $('span.primal-rig-session-time', undefined, relative));
		}

		row.setAttribute('aria-label', status
			? localize('primalRig.openSessionStatusAria', "Open agent session {0}, {1}", session.label, status.label)
			: localize('primalRig.openSessionAria', "Open agent session {0}", session.label));

		this.sessionEntryDisposables.add(DOM.addDisposableListener(row, 'click', () => {
			this.openAgentSession(session).catch(onUnexpectedError);
		}));
	}

	/**
	 * A row backed by an agent session opens through the session opener, so
	 * provider activation and the registered opener participants still run.
	 *
	 * A live-model-only row deliberately does NOT go through
	 * `openSessionByResource`: that helper looks the resource up in the agent
	 * sessions model and throws when it is absent, which is exactly the case here
	 * - a session live in this window before the model has resolved. Opening the
	 * widget for the resource is the same primitive `openSessionDefault` ends at.
	 */
	private async openAgentSession(row: IRigSessionRow): Promise<void> {
		const session = row.session;
		if (session) {
			await this.instantiationService.invokeFunction(openSession, session);
			return;
		}

		await this.chatWidgetService.openSession(row.resource, ChatViewPaneTarget, { revealIfOpened: true });
	}

	private statusPresentation(status: ChatSessionStatus | undefined): IStatusPresentation | undefined {
		switch (status) {
			case ChatSessionStatus.InProgress:
				return { icon: Codicon.sync, label: localize('primalRig.status.running', "Running") };
			case ChatSessionStatus.NeedsInput:
				return { icon: Codicon.bell, label: localize('primalRig.status.waiting', "Waiting on You") };
			case ChatSessionStatus.Completed:
				return { icon: Codicon.check, label: localize('primalRig.status.done', "Done") };
			case ChatSessionStatus.Failed:
				return { icon: Codicon.error, label: localize('primalRig.status.failed', "Failed") };
			default:
				return undefined; // not knowable yet: no chip rather than a guess
		}
	}

	private relativeTime(timestamp: number | undefined): string | undefined {
		return typeof timestamp === 'number' ? fromNow(timestamp, true) : undefined;
	}

	//#endregion

	//#region Today

	private renderToday(page: HTMLElement): void {
		// Starts hidden: nothing is claimed until the count has actually been
		// read. It is filled by the deferred load, one idle tick after paint.
		const section = DOM.append(page, $('.primal-rig-section.primal-rig-today-section.pending'));
		this.todaySection = section;
		DOM.append(section, $('h2.primal-rig-section-label', undefined, localize('primalRig.today', "Today")));

		const stats = DOM.append(section, $('.primal-rig-stats'));
		const stat = DOM.append(stats, $('.primal-rig-stat'));
		this.todayValue = DOM.append(stat, $('.primal-rig-stat-value'));
		this.todayCaptionLabel = DOM.append(stat, $('.primal-rig-stat-caption', undefined, this.todayCaption()));
	}

	/**
	 * The chat session index is workspace-scoped, but a window with no folder
	 * open reads one `emptyWindowChatSessions` directory that every such window
	 * shares, past and present. The caption therefore names the scope it
	 * actually measured - which for an empty window is wider than this window,
	 * not narrower - rather than implying a figure across every project.
	 */
	private todayCaption(): string {
		return this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY
			? localize('primalRig.today.sessionsNoProject', "Chat sessions active today in windows with no project open")
			: localize('primalRig.today.sessionsWorkspace', "Chat sessions active today in this workspace");
	}

	private async updateToday(): Promise<void> {
		const section = this.todaySection;
		const value = this.todayValue;
		if (!section || !value) {
			return;
		}

		const token = ++this.todayRenderToken;

		let details: IChatDetail[];
		try {
			const [live, history] = await Promise.all([
				this.chatService.getLiveSessionItems(),
				this.chatService.getHistorySessionItems()
			]);
			details = [...live, ...history];
		} catch (error) {
			onUnexpectedError(error);
			return; // nothing was read, so nothing is claimed
		}

		if (token !== this.todayRenderToken) {
			return; // superseded by a newer render
		}

		// A real 0 is shown as 0; it is never swapped for a nicer number.
		value.textContent = String(countSessionsToday(details, Date.now()));
		// Re-stated on every read: a folder added to an empty window moves the
		// index from the shared empty-window store to a workspace-scoped one,
		// and the caption must follow.
		if (this.todayCaptionLabel) {
			this.todayCaptionLabel.textContent = this.todayCaption();
		}
		section.classList.remove('pending');
	}

	//#endregion

	//#region Footer

	private renderFooter(page: HTMLElement): void {
		const footer = DOM.append(page, $('.primal-rig-footer'));

		const hints: readonly IShortcutHint[] = [
			{ commandId: PRIMAL_VIBE_CYCLE_COMMAND_ID, text: localize('primalRig.hint.cycleVibes', "cycle vibes") },
			{ commandId: PRIMAL_VIBE_PICK_COMMAND_ID, text: localize('primalRig.hint.pickVibe', "pick vibe") },
			{ commandId: CHAT_OPEN_ACTION_ID, text: localize('primalRig.hint.chat', "chat") }
		];

		let rendered = 0;
		for (const { commandId, text } of hints) {
			const keybinding = this.keybindingLabel(commandId);
			if (!keybinding) {
				continue; // unbound on this platform / profile: no hint to give
			}
			if (rendered > 0) {
				DOM.append(footer, $('span.primal-rig-footer-separator', undefined, '·'));
			}
			const hint = DOM.append(footer, $('span.primal-rig-footer-hint'));
			DOM.append(hint, $('span.primal-rig-kbd', undefined, keybinding));
			DOM.append(hint, $('span.primal-rig-footer-text', undefined, text));
			rendered++;
		}
	}

	//#endregion

	/** A section shell: heading, list container and an honest empty line. */
	private createSection(page: HTMLElement, label: string, emptyText: string): { readonly root: HTMLElement; readonly list: HTMLElement } {
		const root = DOM.append(page, $('.primal-rig-section.empty'));
		DOM.append(root, $('h2.primal-rig-section-label', undefined, label));
		const list = DOM.append(root, $('.primal-rig-list'));
		DOM.append(root, $('.primal-rig-empty', undefined, emptyText));

		return { root, list };
	}

	/**
	 * Everything that must not run before the pane is on screen.
	 *
	 * Reading `IAgentSessionsService.model` builds the model and resolves every
	 * registered session provider, so it waits for an idle callback - the first
	 * point at which the browser has finished painting. The callback is owned by
	 * `editorDisposables`, so disposing the pane cancels it.
	 *
	 * The `onDidResolve` listener is attached in the same tick as that read, so
	 * it cannot miss a report from the resolve that read just started: each
	 * provider's resolve runs behind a throttled delayer and so cannot report
	 * synchronously. Where the model was already built and resolved by another
	 * consumer, this pane simply has no report to go on and withholds the status
	 * chip until the next resolve - the honest reading of "not knowable yet".
	 */
	private scheduleDeferredLoad(parent: HTMLElement): void {
		this.editorDisposables.add(DOM.runWhenWindowIdle(DOM.getWindow(parent), () => {
			const model = this.agentSessionsService.model;
			this.agentSessionsModel = model;
			this.editorDisposables.add(model.onDidResolve(provider => {
				this.resolvedSessionProviders.add(provider);
				this.refreshScheduler.schedule();
			}));
			this.editorDisposables.add(model.onDidChangeSessions(() => this.refreshScheduler.schedule()));
			this.updateAgentActivity();

			this.updateToday().catch(onUnexpectedError);
		}));
	}

	/** The user-facing keybinding label for a command, or `undefined` when unbound. */
	private keybindingLabel(commandId: string): string | undefined {
		return this.keybindingService.lookupKeybinding(commandId)?.getLabel() ?? undefined;
	}

	//#region Motif stage

	/**
	 * The single decision: this pane offers itself as the motif's host exactly
	 * while it is the visible pane in a visible document. `setEditorVisible` and
	 * not `Composite.setVisible`, for the reasons set out on the Start page's
	 * copy of this method.
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

	override async setInput(input: PrimalRigInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.updateStage();

		// State may have moved on while the page sat in the background.
		this.attachLiveModelListeners();
		this.updateAgentActivity();
		await Promise.all([this.updateProjects(), this.updateToday()]);
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
		this.primaryActionButton?.focus();
	}

	override layout(dimension: Dimension): void {
		this.scrollContainer?.classList.toggle('narrow', dimension.width < NARROW_WIDTH_THRESHOLD);

		// The motif's `onDidLayoutContainer` hook fires on *container* layout, and
		// an editor resize is not one, so the surface has to be told. Only a size
		// that actually changed: a sash drag is a great many layouts.
		if (dimension.width === this.stageWidth && dimension.height === this.stageHeight) {
			return;
		}

		this.stageWidth = dimension.width;
		this.stageHeight = dimension.height;

		// `relayout` and not `trigger`, for the reasons set out on the Start
		// page's copy of this method: a trigger re-arms the frame chain and would
		// defeat the plan's frame-rate ceiling for the whole of a sash drag.
		if (this.stageRegistration.value && this.workbenchContainer) {
			this.motifService.relayout(this.workbenchContainer);
		}
	}
}
