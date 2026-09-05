/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, ISettableObservable, autorun, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ChatViewId, IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatViewPane } from '../../chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';
import { IChatService, IChatToolInvocation, IChatToolInvocationSerialized } from '../../chat/common/chatService/chatService.js';
import { IChatModel, IChatProgressResponseContent, IChatRequestModel, IChatResponseModel } from '../../chat/common/model/chatModel.js';
import { IRigSessionRow, liveSessionRows, liveSessionStatus } from '../../primalRig/browser/primalRigSessions.js';
import { firstLineOf, formatElapsed, tailOf } from './primalDeckFormat.js';
import { deckStatusPresentation } from './primalDeckStatus.js';
import { StreamRateMeter, TEXT_TAIL_CHARS, compareSessionRows, editKindWord, formatDiff, isNestedPart, primaryArgument, thinkingLength, thinkingText } from './primalDeckStreamParts.js';

/** The log never holds more lines than this; the oldest go first. */
export const MAX_STREAM_LINES = 500;

/** Coalescing window between a model event and the DOM flush. */
const FLUSH_DELAY_MS = 250;

/** Trailing parts of a response shown when the Deck binds to it mid-flight. */
const BACKFILL_PARTS = 24;

/** Hard cap on entries queued between two flushes. */
const MAX_PENDING = 2000;

/** Seen tool-call ids are forgotten past this many, so the set stays bounded. */
const MAX_SEEN_TOOL_CALLS = 1000;

export type DeckLineKind = 'text' | 'thinking' | 'tool' | 'edit' | 'status' | 'session';

/**
 * One line of the log. Immutable: an in-place text update is a new record
 * carrying the same id, and the view swaps the old one for it.
 */
export interface IDeckLine {
	readonly id: number;
	readonly kind: DeckLineKind;
	/**
	 * Epoch ms of arrival at the Deck. `undefined` for a line restored from a
	 * response that streamed before the Deck was watching - such a line has no
	 * truthful arrival time and shows none.
	 */
	readonly at: number | undefined;
	readonly glyph: string;
	readonly label: string;
	readonly detail: string;
	/** A tool call made by a subagent, shown indented. */
	readonly nested: boolean;
}

/** One coalesced batch of changes for the view: apply `evicted`, then `appended`, then `updated`. */
export interface IDeckFlush {
	/** The log was reset (the Deck bound a different session); drop everything first. */
	readonly cleared: boolean;
	/** How many of the oldest lines fell out of the buffer. */
	readonly evicted: number;
	readonly appended: readonly IDeckLine[];
	readonly updated: readonly IDeckLine[];
}

interface IPendingPart {
	readonly type: 'part';
	readonly response: IChatResponseModel;
	readonly index: number;
	readonly at: number | undefined;
}

interface IPendingLine {
	readonly type: 'line';
	readonly line: IDeckLine;
}

type PendingEntry = IPendingPart | IPendingLine;

/**
 * Where the Deck is in one response's live parts array. Numbers only: the
 * chat model mutates that array in place (a merged markdown part is replaced
 * at its index, edit groups grow, `clearToPreviousToolInvocation` shrinks it),
 * so no part object is ever kept from one event to the next. Mutated in place
 * on purpose - this is the per-token hot path and must not allocate.
 */
interface IResponseCursor {
	readonly response: IChatResponseModel;
	partsLen: number;
	/** Index of the markdown part still being merged into, or -1. */
	textIndex: number;
	textLen: number;
	textLineId: number | undefined;
	textDirty: boolean;
	/** Index of the thinking part still being merged into, or -1. */
	thinkIndex: number;
	thinkLen: number;
	thinkLineId: number | undefined;
	thinkDirty: boolean;
}

interface ICursorSnapshot {
	readonly responseId: string;
	readonly partsLen: number;
}

/**
 * The stream model: which chat session the Deck watches, the bounded line
 * log built from that session's real response parts, and the agent's output
 * rate.
 *
 * Nothing runs while detached. `attach()` (on show) subscribes and binds;
 * `detach()` (on hide) drops every listener, the flush timer and the rate
 * buckets. The chat model keeps its own history, so nothing is lost.
 *
 * The per-event listener on the live response is O(new parts) and allocates
 * nothing but a queue entry: it updates counters and schedules one coalesced
 * flush, where lines are materialized and the view is told what changed.
 */
export class PrimalDeckStream extends Disposable {

	private readonly _onDidFlush = this._register(new Emitter<IDeckFlush>());
	readonly onDidFlush = this._onDidFlush.event;

	private readonly _onDidChangeSession = this._register(new Emitter<IChatModel | undefined>());
	readonly onDidChangeSession = this._onDidChangeSession.event;

	private readonly _onDidChangeTitle = this._register(new Emitter<string>());
	readonly onDidChangeTitle = this._onDidChangeTitle.event;

	private readonly _streamRate: ISettableObservable<number> = observableValue(this, 0);
	/** Chars/s of agent text over the last ~2 s; refreshed on every coalesced flush and decaying to 0. */
	readonly streamRate: IObservable<number> = this._streamRate;

	private readonly lines: IDeckLine[] = [];
	private nextLineId = 1;
	private pending: PendingEntry[] = [];
	private readonly rate = new StreamRateMeter();
	private readonly flushScheduler = this._register(new RunOnceScheduler(() => this.flush(), FLUSH_DELAY_MS));

	/** Subscriptions that live while attached. */
	private readonly attachListeners = this._register(new DisposableStore());
	private readonly paneListener = this._register(new MutableDisposable());
	/** Subscriptions on the bound model; cleared on every rebind. */
	private readonly modelListeners = this._register(new DisposableStore());
	private readonly responseListener = this._register(new MutableDisposable());

	private attached = false;
	private boundPane: ChatViewPane | undefined;
	private model: IChatModel | undefined;
	/** The model bound before the last unbind, so a re-show of the same session keeps its log. */
	private previousModel: IChatModel | undefined;
	private previousCursor: ICursorSnapshot | undefined;
	/** Set while a model's own dispose event is being handled, so it is never re-resolved. */
	private disposingModel: IChatModel | undefined;
	private cursor: IResponseCursor | undefined;
	private lastStatusKey: string | undefined;
	private readonly seenToolCalls = new Set<string>();

	constructor(
		@IViewsService private readonly viewsService: IViewsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatService private readonly chatService: IChatService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
	}

	/** The session being watched, if any. */
	get session(): IChatModel | undefined {
		return this.model;
	}

	get lineCount(): number {
		return this.lines.length;
	}

	//#region Session binding

	attach(): void {
		if (this.attached) {
			return;
		}
		this.attached = true;

		this.attachListeners.add(this.viewsService.onDidChangeViewVisibility(e => {
			if (e.id === ChatViewId) {
				this.rebind();
			}
		}));
		this.attachListeners.add(this.chatWidgetService.onDidChangeFocusedSession(() => this.rebind()));
		this.attachListeners.add(this.chatService.onDidCreateModel(() => this.rebind()));
		this.attachListeners.add(this.chatService.onDidDisposeSession(() => this.rebind()));

		this.rebind();
	}

	detach(): void {
		if (!this.attached) {
			return;
		}
		this.attached = false;
		this.flush();

		this.attachListeners.clear();
		this.paneListener.clear();
		this.boundPane = undefined;
		this.unbindModel();

		this.flushScheduler.cancel();
		this.pending = [];
		this.rate.reset();
		this._streamRate.set(0, undefined);
	}

	private rebind(): void {
		if (!this.attached) {
			return;
		}
		this.syncPaneListener();
		const next = this.resolveModel();
		if (next !== this.model) {
			this.bindModel(next);
		}
	}

	/** Follows the auxiliary-bar chat view's widget, which is the authoritative signal for a session switch. */
	private syncPaneListener(): void {
		const pane = this.viewsService.getActiveViewWithId<ChatViewPane>(ChatViewId) ?? undefined;
		if (pane === this.boundPane) {
			return;
		}
		this.boundPane = pane;
		const widget = pane?.widget;
		this.paneListener.value = widget?.onDidChangeViewModel(() => this.rebind());
	}

	/**
	 * The chat view's session first; otherwise the most recently active live
	 * chat session, read through The Rig's row mapping so the same
	 * truthfulness rules apply. Never acquires a reference: the Deck observes
	 * without extending any session's lifetime.
	 */
	private resolveModel(): IChatModel | undefined {
		const widget = this.boundPane?.widget;
		const fromPane = widget?.viewModel?.model;
		if (fromPane && fromPane !== this.disposingModel) {
			return fromPane;
		}

		let best: IRigSessionRow | undefined;
		for (const row of liveSessionRows(this.chatService.chatModels.get())) {
			if (!best || compareSessionRows(row, best) > 0) {
				best = row;
			}
		}
		const model = best ? this.chatService.getSession(best.resource) : undefined;
		return model === this.disposingModel ? undefined : model;
	}

	private unbindModel(): void {
		if (this.model) {
			this.previousModel = this.model;
			this.previousCursor = this.cursor ? { responseId: this.cursor.response.id, partsLen: this.cursor.partsLen } : undefined;
		}
		this.model = undefined;
		this.cursor = undefined;
		this.responseListener.clear();
		this.modelListeners.clear();
	}

	private bindModel(next: IChatModel | undefined): void {
		this.unbindModel();

		if (!next) {
			if (this.previousModel) {
				this.previousModel = undefined;
				this.previousCursor = undefined;
				this.resetLog();
				this._onDidChangeSession.fire(undefined);
			}
			return;
		}

		const continuing = next === this.previousModel;
		this.previousModel = undefined;
		if (!continuing) {
			this.resetLog();
		}
		this.model = next;

		this.modelListeners.add(next.onDidDispose(() => {
			this.disposingModel = next;
			this.rebind();
			this.disposingModel = undefined;
		}));
		this.modelListeners.add(next.onDidChange(event => {
			if (event.kind === 'addRequest') {
				this.trackRequest(event.request, 'live');
			} else if (event.kind === 'setCustomTitle') {
				this._onDidChangeTitle.fire(event.title);
			}
		}));

		const now = Date.now();
		if (continuing) {
			const skipped = this.trackRequest(next.lastRequest, 'seed');
			const detail = skipped > 0 ? localize('primalDeck.line.skipped', "{0} parts of this turn arrived while the Deck was hidden", skipped) : '';
			this.enqueue({ type: 'line', line: this.createLine('session', now, '◆', localize('primalDeck.line.resumed', "resumed"), detail, false) });
		} else {
			this.enqueue({ type: 'line', line: this.createLine('session', now, '◆', localize('primalDeck.line.watching', "watching"), next.title, false) });
			this.trackRequest(next.lastRequest, 'backfill');
		}

		// Runs once now, for the current status, and again on every flip of the two observables.
		this.modelListeners.add(autorun(reader => {
			next.requestInProgress.read(reader);
			next.requestNeedsInput.read(reader);
			this.updateStatus();
		}));

		this._onDidChangeSession.fire(next);
		this.flush();
	}

	//#endregion

	//#region Response tracking

	/**
	 * Points the cursor at a request's response and, unless the response is
	 * already complete, listens to it.
	 *
	 * - `live`: a request that just started; its parts (normally none) are live.
	 * - `backfill`: the Deck just bound this session; the trailing parts are
	 *   shown as restored lines with no arrival time.
	 * - `seed`: the Deck re-bound the session it was already showing; nothing
	 *   is replayed, and the number of parts that arrived meanwhile is returned.
	 */
	private trackRequest(request: IChatRequestModel | undefined, mode: 'live' | 'backfill' | 'seed'): number {
		this.responseListener.clear();
		this.cursor = undefined;

		const response = request?.response;
		if (!response) {
			this.previousCursor = undefined;
			return 0;
		}

		const parts = response.entireResponse.value;
		const cursor: IResponseCursor = {
			response,
			partsLen: parts.length,
			textIndex: -1, textLen: 0, textLineId: undefined, textDirty: false,
			thinkIndex: -1, thinkLen: 0, thinkLineId: undefined, thinkDirty: false
		};
		this.cursor = cursor;

		let skipped = 0;
		if (mode === 'seed') {
			const previous = this.previousCursor;
			skipped = previous?.responseId === response.id ? Math.max(0, parts.length - previous.partsLen) : parts.length;
			for (let index = Math.max(0, parts.length - BACKFILL_PARTS); index < parts.length; index++) {
				this.notePart(parts[index], index, cursor, undefined);
			}
		} else {
			const at = mode === 'live' ? Date.now() : undefined;
			const from = mode === 'backfill' ? Math.max(0, parts.length - BACKFILL_PARTS) : 0;
			for (let index = from; index < parts.length; index++) {
				this.notePart(parts[index], index, cursor, at);
				this.enqueue({ type: 'part', response, index, at });
			}
		}
		this.previousCursor = undefined;

		if (!response.isComplete) {
			this.responseListener.value = response.onDidChange(() => this.onResponseChange(cursor));
		}
		return skipped;
	}

	/** Records a part the cursor has now seen. Counts its text toward the rate only when it is live (`at` known). */
	private notePart(part: IChatProgressResponseContent, index: number, cursor: IResponseCursor, at: number | undefined): void {
		if (part.kind === 'markdownContent') {
			if (isNestedPart(part)) {
				return;
			}
			cursor.textIndex = index;
			cursor.textLen = part.content.value.length;
			cursor.textLineId = undefined;
			cursor.textDirty = false;
			if (at !== undefined && cursor.textLen > 0) {
				this.rate.add(cursor.textLen, at);
			}
		} else if (part.kind === 'thinking') {
			cursor.thinkIndex = index;
			cursor.thinkLen = thinkingLength(part);
			cursor.thinkLineId = undefined;
			cursor.thinkDirty = false;
		}
	}

	/**
	 * The hot path: fires synchronously inside the agent host's observable
	 * graph, potentially per token, and again on every tool state change.
	 * Counters and one queue entry per new part, then one coalesced flush.
	 */
	private onResponseChange(cursor: IResponseCursor): void {
		if (cursor !== this.cursor) {
			return;
		}
		const parts = cursor.response.entireResponse.value;
		const now = Date.now();

		if (parts.length < cursor.partsLen) {
			// `clearToPreviousToolInvocation` truncated the response: re-seed at the new tail and log nothing.
			cursor.partsLen = parts.length;
			cursor.textIndex = -1;
			cursor.textLineId = undefined;
			cursor.textDirty = false;
			cursor.thinkIndex = -1;
			cursor.thinkLineId = undefined;
			cursor.thinkDirty = false;
			return;
		}

		// The merge target is replaced at the same index on every delta, so re-read it.
		if (cursor.textIndex >= 0) {
			const part = parts[cursor.textIndex];
			if (part?.kind === 'markdownContent') {
				const length = part.content.value.length;
				if (length > cursor.textLen) {
					this.rate.add(length - cursor.textLen, now);
					cursor.textLen = length;
					cursor.textDirty = true;
				}
			} else {
				cursor.textIndex = -1;
			}
		}
		if (cursor.thinkIndex >= 0) {
			const part = parts[cursor.thinkIndex];
			if (part?.kind === 'thinking') {
				const length = thinkingLength(part);
				if (length > cursor.thinkLen) {
					cursor.thinkLen = length;
					cursor.thinkDirty = true;
				}
			} else {
				cursor.thinkIndex = -1;
			}
		}

		for (let index = cursor.partsLen; index < parts.length; index++) {
			this.notePart(parts[index], index, cursor, now);
			this.enqueue({ type: 'part', response: cursor.response, index, at: now });
		}
		cursor.partsLen = parts.length;

		this.scheduleFlush();
	}

	/**
	 * A session status line whenever the status the Rig would show for this
	 * model actually changes. Keyed by request as well, so a new turn's
	 * "running" is a new line but a repeated observation of the same state
	 * is not.
	 */
	private updateStatus(): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const status = liveSessionStatus(model);
		const response = model.lastRequest?.response;
		const key = `${status ?? 'none'}:${response?.id ?? ''}:${response?.isCanceled ? 'stopped' : ''}`;
		if (key === this.lastStatusKey) {
			return;
		}
		this.lastStatusKey = key;

		const presentation = deckStatusPresentation(status);
		if (!presentation) {
			return; // nothing truthful to say
		}

		let detail = '';
		if (status === ChatSessionStatus.NeedsInput) {
			detail = model.requestNeedsInput.get()?.detail ?? '';
		} else if (status === ChatSessionStatus.Completed && response) {
			const bits: string[] = [];
			if (response.isCanceled) {
				bits.push(localize('primalDeck.line.stopped', "stopped"));
			}
			if (typeof response.elapsedMs === 'number') {
				bits.push(formatElapsed(response.elapsedMs));
			}
			detail = bits.join(' · ');
		} else if (status === ChatSessionStatus.Failed) {
			detail = response?.result?.errorDetails?.message ?? '';
		}

		this.enqueue({ type: 'line', line: this.createLine('status', Date.now(), presentation.glyph, presentation.label, firstLineOf(detail, TEXT_TAIL_CHARS), false) });
		this.scheduleFlush();
	}

	//#endregion

	//#region Lines and flushing

	private createLine(kind: DeckLineKind, at: number | undefined, glyph: string, label: string, detail: string, nested: boolean): IDeckLine {
		return { id: this.nextLineId++, kind, at, glyph, label, detail, nested };
	}

	private enqueue(entry: PendingEntry): void {
		if (this.pending.length >= MAX_PENDING) {
			this.pending.shift();
		}
		this.pending.push(entry);
	}

	/** Throttled, not debounced: a stream that never pauses must still flush every window. */
	private scheduleFlush(): void {
		if (!this.flushScheduler.isScheduled()) {
			this.flushScheduler.schedule();
		}
	}

	private flush(): void {
		const entries = this.pending;
		this.pending = [];

		const appended: IDeckLine[] = [];
		for (const entry of entries) {
			const line = entry.type === 'line' ? entry.line : this.materialize(entry);
			if (line) {
				appended.push(line);
			}
		}

		const updated: IDeckLine[] = [];
		if (this.cursor) {
			this.refreshTracked(this.cursor, appended, updated);
		}

		const { kept, evicted } = this.appendLines(appended);
		for (const line of updated) {
			this.replaceLine(line);
		}

		const rate = this.rate.rateAt(Date.now());
		this._streamRate.set(rate, undefined);
		if (rate > 0 && this.attached) {
			this.scheduleFlush(); // keeps decaying to zero after the last delta
		}

		if (kept.length > 0 || updated.length > 0 || evicted > 0) {
			this._onDidFlush.fire({ cleared: false, evicted, appended: kept, updated });
		}
	}

	private materialize(entry: IPendingPart): IDeckLine | undefined {
		const part = entry.response.entireResponse.value[entry.index];
		if (!part) {
			return undefined; // truncated between the event and this flush
		}
		const cursor = this.cursor;

		switch (part.kind) {
			case 'markdownContent': {
				const text = part.content.value;
				if (!text) {
					return undefined; // created lazily once it has content
				}
				// allow-any-unicode-next-line
				const line = this.createLine('text', entry.at, '›', '', tailOf(text, TEXT_TAIL_CHARS), isNestedPart(part));
				if (cursor && cursor.response === entry.response && cursor.textIndex === entry.index) {
					cursor.textLineId = line.id;
					cursor.textDirty = false;
				}
				return line;
			}
			case 'thinking': {
				const text = thinkingText(part);
				if (!text) {
					return undefined;
				}
				const line = this.createLine('thinking', entry.at, '…', localize('primalDeck.line.thinking', "thinking"), tailOf(text, TEXT_TAIL_CHARS), false);
				if (cursor && cursor.response === entry.response && cursor.thinkIndex === entry.index) {
					cursor.thinkLineId = line.id;
					cursor.thinkDirty = false;
				}
				return line;
			}
			case 'toolInvocation':
			case 'toolInvocationSerialized':
				return this.toolLine(part, entry.at);
			case 'externalEdit':
				// allow-any-unicode-next-line
				return this.createLine('edit', entry.at, '✎', this.labelService.getUriLabel(part.uri, { relative: true }), part.diff ? formatDiff(part.diff.added, part.diff.removed) : editKindWord(part.editKind), false);
			case 'textEditGroup':
			case 'notebookEditGroup':
				return this.editGroupLine(part.uri, entry.response.session, entry.at);
			default:
				return undefined; // progress messages, references, confirmations: no line is invented for them
		}
	}

	private toolLine(part: IChatToolInvocation | IChatToolInvocationSerialized, at: number | undefined): IDeckLine | undefined {
		if (IChatToolInvocation.isEffectivelyHidden(part) || this.seenToolCalls.has(part.toolCallId)) {
			return undefined;
		}
		if (this.seenToolCalls.size >= MAX_SEEN_TOOL_CALLS) {
			this.seenToolCalls.clear();
		}
		this.seenToolCalls.add(part.toolCallId);
		// allow-any-unicode-next-line
		return this.createLine('tool', at, '▸', part.toolId, primaryArgument(part, this.labelService) ?? '', !!part.subAgentInvocationId);
	}

	/**
	 * A local editing-session edit. Line counts exist only once the editing
	 * session has an entry for the file; they are read once, here, and never
	 * observed, so the diff pipeline is not kept hot by the Deck.
	 */
	private editGroupLine(uri: URI, session: IChatModel, at: number | undefined): IDeckLine {
		const entry = session.editingSession?.getEntry(uri);
		const added = entry?.linesAdded?.get();
		const removed = entry?.linesRemoved?.get();
		const detail = typeof added === 'number' && typeof removed === 'number' && added + removed > 0 ? formatDiff(added, removed) : '';
		// allow-any-unicode-next-line
		return this.createLine('edit', at, '✎', this.labelService.getUriLabel(uri, { relative: true }), detail, false);
	}

	/** Re-reads the two merge targets once per flush and updates (or lazily creates) their lines. */
	private refreshTracked(cursor: IResponseCursor, appended: IDeckLine[], updated: IDeckLine[]): void {
		const parts = cursor.response.entireResponse.value;

		if (cursor.textDirty) {
			cursor.textDirty = false;
			const part = parts[cursor.textIndex];
			if (part?.kind === 'markdownContent' && part.content.value) {
				// allow-any-unicode-next-line
				cursor.textLineId = this.upsertLine(cursor.textLineId, 'text', '›', '', tailOf(part.content.value, TEXT_TAIL_CHARS), appended, updated);
			}
		}

		if (cursor.thinkDirty) {
			cursor.thinkDirty = false;
			const part = parts[cursor.thinkIndex];
			if (part?.kind === 'thinking') {
				const text = thinkingText(part);
				if (text) {
					cursor.thinkLineId = this.upsertLine(cursor.thinkLineId, 'thinking', '…', localize('primalDeck.line.thinking', "thinking"), tailOf(text, TEXT_TAIL_CHARS), appended, updated);
				}
			}
		}
	}

	/** Updates the line with `id` in place, or appends a fresh one when none exists or it was evicted. Returns the live id. */
	private upsertLine(id: number | undefined, kind: DeckLineKind, glyph: string, label: string, detail: string, appended: IDeckLine[], updated: IDeckLine[]): number {
		const existing = id === undefined ? undefined : this.findLine(id);
		if (existing) {
			updated.push({ ...existing, detail });
			return existing.id;
		}
		const line = this.createLine(kind, Date.now(), glyph, label, detail, false);
		appended.push(line);
		return line.id;
	}

	private appendLines(newLines: readonly IDeckLine[]): { readonly kept: readonly IDeckLine[]; readonly evicted: number } {
		const kept = newLines.length > MAX_STREAM_LINES ? newLines.slice(newLines.length - MAX_STREAM_LINES) : newLines;
		const overflow = Math.max(0, this.lines.length + kept.length - MAX_STREAM_LINES);
		if (overflow > 0) {
			this.lines.splice(0, overflow);
		}
		for (const line of kept) {
			this.lines.push(line);
		}
		return { kept, evicted: overflow };
	}

	private findLine(id: number): IDeckLine | undefined {
		for (let index = this.lines.length - 1; index >= 0; index--) {
			if (this.lines[index].id === id) {
				return this.lines[index];
			}
		}
		return undefined;
	}

	private replaceLine(line: IDeckLine): void {
		for (let index = this.lines.length - 1; index >= 0; index--) {
			if (this.lines[index].id === line.id) {
				this.lines[index] = line;
				return;
			}
		}
	}

	private resetLog(): void {
		this.lines.length = 0;
		this.pending = [];
		this.seenToolCalls.clear();
		this.lastStatusKey = undefined;
		this._onDidFlush.fire({ cleared: true, evicted: 0, appended: [], updated: [] });
	}

	//#endregion

	override dispose(): void {
		this.detach();
		super.dispose();
	}
}
