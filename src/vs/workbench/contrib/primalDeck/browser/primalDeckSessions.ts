/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { fromNow } from '../../../../base/common/date.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentSessionsModel } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { openSession } from '../../chat/browser/agentSessions/agentSessionsOpener.js';
// Same read-only use of the provider-internal service The Rig makes; see the
// layering note in primalRigEditor.ts.
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../chat/browser/chat.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IRigSessionRow, agentSessionRows, liveSessionRows, mergeSessionRows } from '../../primalRig/browser/primalRigSessions.js';
import { deckStatusPresentation } from './primalDeckStatus.js';

const $ = DOM.$;

/** How many sessions the panel lists. */
const MAX_ROWS = 8;

/** Coalescing window for live chat model churn; one streaming response fires many events. */
const REFRESH_DELAY_MS = 500;

/**
 * Agent sessions: The Rig's rows, unchanged. The row mapping and both of its
 * truthfulness gates (a live model wins on status; an agent-sessions row gets
 * a chip only once its own provider has resolved) are imported from
 * primalRigSessions.ts, not re-implemented.
 *
 * Nothing runs while deactivated: listeners, the refresh timer and the
 * deferred agent-sessions load all exist only between `activate()` and
 * `deactivate()`.
 */
export class PrimalDeckSessionsPanel extends Disposable {

	private readonly section: HTMLElement;
	private readonly list: HTMLElement;
	private readonly liveListeners = this._register(new DisposableStore());
	private readonly modelListeners = this._register(new DisposableMap<string>());
	private readonly rowListeners = this._register(new DisposableStore());
	private readonly deferredLoad = this._register(new MutableDisposable());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => this.render(), REFRESH_DELAY_MS));

	/**
	 * Set only by the deferred load. Reading `IAgentSessionsService.model`
	 * builds the model and resolves every provider (extension host RPC and
	 * network), so it happens in an idle callback after first paint and never
	 * while the Deck is hidden.
	 */
	private agentSessionsModel: IAgentSessionsModel | undefined;
	private readonly resolvedProviders = new Set<string>();
	private signature: string | undefined;
	private active = false;

	constructor(
		container: HTMLElement,
		private readonly targetWindow: Window,
		@IChatService private readonly chatService: IChatService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.section = DOM.append(container, $('.primal-deck-panel.primal-deck-sessions.empty'));
		DOM.append(this.section, $('h2.primal-deck-panel-label', undefined, localize('primalDeck.sessions', "Agent Sessions")));
		this.list = DOM.append(this.section, $('.primal-deck-session-list'));
		DOM.append(this.section, $('.primal-deck-panel-status', undefined, localize('primalDeck.sessions.empty', "No agent sessions yet.")));
	}

	activate(): void {
		if (this.active) {
			return;
		}
		this.active = true;

		this.liveListeners.add(this.chatService.onDidCreateModel(() => this.onDidChangeModels()));
		this.liveListeners.add(this.chatService.onDidDisposeSession(() => this.onDidChangeModels()));
		this.attachModelListeners();

		const model = this.agentSessionsModel;
		if (model) {
			this.subscribeAgentSessions(model);
		} else if (!this.deferredLoad.value) {
			this.deferredLoad.value = DOM.runWhenWindowIdle(this.targetWindow, () => {
				const loaded = this.agentSessionsService.model;
				this.agentSessionsModel = loaded;
				if (this.active) {
					this.subscribeAgentSessions(loaded);
					this.render();
				}
			});
		}

		this.render();
	}

	deactivate(): void {
		if (!this.active) {
			return;
		}
		this.active = false;
		this.liveListeners.clear();
		this.modelListeners.clearAndDisposeAll();
		this.refreshScheduler.cancel();
		this.deferredLoad.clear();
	}

	private onDidChangeModels(): void {
		this.attachModelListeners();
		this.refreshScheduler.schedule();
	}

	private subscribeAgentSessions(model: IAgentSessionsModel): void {
		this.liveListeners.add(model.onDidResolve(provider => {
			this.resolvedProviders.add(provider);
			this.refreshScheduler.schedule();
		}));
		this.liveListeners.add(model.onDidChangeSessions(() => this.refreshScheduler.schedule()));
	}

	/** Keeps exactly one change listener per live chat model. */
	private attachModelListeners(): void {
		const alive = new Set<string>();
		for (const model of this.chatService.chatModels.get()) {
			const key = model.sessionResource.toString();
			alive.add(key);
			if (!this.modelListeners.has(key)) {
				this.modelListeners.set(key, model.onDidChange(() => this.refreshScheduler.schedule()));
			}
		}
		for (const key of Array.from(this.modelListeners.keys())) {
			if (!alive.has(key)) {
				this.modelListeners.deleteAndDispose(key);
			}
		}
	}

	private render(): void {
		const model = this.agentSessionsModel;
		const rows = mergeSessionRows(
			liveSessionRows(this.chatService.chatModels.get()),
			model ? agentSessionRows(model.sessions, this.resolvedProviders) : [],
			MAX_ROWS
		);

		// Serialized rather than concatenated so no label can forge a row boundary.
		const signature = JSON.stringify(rows.map(row => [row.resource.toString(), row.label, row.status ?? '', this.relativeTime(row.timestamp) ?? '']));
		if (signature === this.signature) {
			return; // nothing the user can see changed; leave focus where it is
		}
		this.signature = signature;

		this.rowListeners.clear();
		DOM.clearNode(this.list);
		this.section.classList.toggle('empty', rows.length === 0);
		for (const row of rows) {
			this.renderRow(row);
		}
	}

	private renderRow(session: IRigSessionRow): void {
		const row = DOM.append(this.list, $('button.primal-deck-session-row')) as HTMLButtonElement;
		row.type = 'button';
		row.title = session.label;

		// Status is marked by glyph AND word, never by hue alone.
		const status = deckStatusPresentation(session.status);
		const chip = DOM.append(row, $('span.primal-deck-session-status'));
		if (status) {
			DOM.append(chip, $('span.primal-deck-session-status-icon' + ThemeIcon.asCSSSelector(status.icon)));
			DOM.append(chip, $('span.primal-deck-session-status-label', undefined, status.label));
		}
		DOM.append(row, $('span.primal-deck-session-name', undefined, session.label));

		const relative = this.relativeTime(session.timestamp);
		if (relative) {
			DOM.append(row, $('span.primal-deck-session-time', undefined, relative));
		}

		row.setAttribute('aria-label', status
			? localize('primalDeck.openSessionStatusAria', "Open agent session {0}, {1}", session.label, status.label)
			: localize('primalDeck.openSessionAria', "Open agent session {0}", session.label));

		this.rowListeners.add(DOM.addDisposableListener(row, 'click', () => {
			this.openAgentSession(session).catch(onUnexpectedError);
		}));
	}

	/** Same two paths as The Rig: the session opener when the row is backed by an agent session, else the chat view. */
	private async openAgentSession(row: IRigSessionRow): Promise<void> {
		if (row.session) {
			await this.instantiationService.invokeFunction(openSession, row.session);
			return;
		}
		await this.chatWidgetService.openSession(row.resource, ChatViewPaneTarget, { revealIfOpened: true });
	}

	private relativeTime(timestamp: number | undefined): string | undefined {
		return typeof timestamp === 'number' ? fromNow(timestamp, true) : undefined;
	}
}
