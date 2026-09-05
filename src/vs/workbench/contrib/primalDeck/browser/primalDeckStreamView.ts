/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createClockFormatter } from './primalDeckFormat.js';
import { IDeckFlush, IDeckLine, PrimalDeckStream } from './primalDeckStream.js';

const $ = DOM.$;

/** How far above the bottom (px) still counts as following the stream. */
const FOLLOW_SLACK_PX = 4;

interface ILineNodes {
	readonly root: HTMLElement;
	readonly detail: HTMLElement;
}

/**
 * The stream's DOM: append-only. A flush removes the evicted oldest nodes,
 * appends the new ones and patches the text of updated ones; the log is never
 * rebuilt. Follows the bottom until the user scrolls up, then offers a
 * "jump to live" chip that resumes following.
 */
export class PrimalDeckStreamView extends Disposable {

	private readonly log: HTMLElement;
	private readonly list: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly jump: HTMLButtonElement;
	private readonly nodes = new Map<number, ILineNodes>();
	/** Line ids in DOM order, so eviction can drop the oldest map entries. */
	private readonly order: number[] = [];
	private readonly clock = createClockFormatter();
	private readonly restoredTitle = localize('primalDeck.line.restoredTitle', "Streamed before the Deck was watching; no arrival time");
	private following = true;

	constructor(container: HTMLElement, private readonly stream: PrimalDeckStream) {
		super();

		const panel = DOM.append(container, $('.primal-deck-panel.primal-deck-stream'));
		DOM.append(panel, $('h2.primal-deck-panel-label', undefined, localize('primalDeck.stream', "The Stream")));

		const host = DOM.append(panel, $('.primal-deck-log-host'));
		this.log = DOM.append(host, $('.primal-deck-log', { role: 'log', 'aria-live': 'off', tabindex: '0' }));
		this.log.setAttribute('aria-label', localize('primalDeck.stream.aria', "Live agent output"));
		this.list = DOM.append(this.log, $('.primal-deck-log-lines'));
		this.empty = DOM.append(this.log, $('.primal-deck-log-empty'));

		this.jump = DOM.append(host, $('button.primal-deck-jump')) as HTMLButtonElement;
		this.jump.type = 'button';
		DOM.append(this.jump, $('span.primal-deck-jump-glyph', { 'aria-hidden': 'true' }, '↓'));
		DOM.append(this.jump, $('span', undefined, localize('primalDeck.jumpToLive', "jump to live")));

		this._register(DOM.addDisposableListener(this.log, 'scroll', () => this.onScroll()));
		this._register(DOM.addDisposableListener(this.jump, 'click', () => this.jumpToLive()));
		this._register(stream.onDidFlush(flush => this.applyFlush(flush)));
		this._register(stream.onDidChangeSession(() => this.updateEmpty()));

		this.updateEmpty();
	}

	focus(): void {
		this.log.focus();
	}

	private onScroll(): void {
		const log = this.log;
		this.setFollowing(log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_SLACK_PX);
	}

	private setFollowing(following: boolean): void {
		if (this.following === following) {
			return;
		}
		this.following = following;
		this.jump.classList.toggle('active', !following);
	}

	private jumpToLive(): void {
		this.setFollowing(true);
		this.scrollToBottom();
		this.log.focus();
	}

	private scrollToBottom(): void {
		this.log.scrollTop = this.log.scrollHeight;
	}

	private applyFlush(flush: IDeckFlush): void {
		if (flush.cleared) {
			DOM.clearNode(this.list);
			this.nodes.clear();
			this.order.length = 0;
		}

		for (let count = 0; count < flush.evicted; count++) {
			const id = this.order.shift();
			if (id === undefined) {
				break;
			}
			this.nodes.get(id)?.root.remove();
			this.nodes.delete(id);
		}

		for (const line of flush.appended) {
			const nodes = this.render(line);
			this.list.appendChild(nodes.root);
			this.nodes.set(line.id, nodes);
			this.order.push(line.id);
		}

		for (const line of flush.updated) {
			const nodes = this.nodes.get(line.id);
			if (nodes) {
				nodes.detail.textContent = line.detail;
			}
		}

		this.updateEmpty();
		if (this.following) {
			this.scrollToBottom();
		}
	}

	private render(line: IDeckLine): ILineNodes {
		const root = $(`.primal-deck-line.kind-${line.kind}`);
		if (line.at === undefined) {
			root.classList.add('restored');
		}
		if (line.nested) {
			root.classList.add('nested');
		}

		const time = DOM.append(root, $('span.primal-deck-line-time', undefined, line.at === undefined ? '—' : this.clock.value.format(line.at)));
		if (line.at === undefined) {
			time.title = this.restoredTitle;
		}
		DOM.append(root, $('span.primal-deck-line-glyph', { 'aria-hidden': 'true' }, line.glyph));
		if (line.label) {
			DOM.append(root, $('span.primal-deck-line-label', undefined, line.label));
		}
		const detail = DOM.append(root, $('span.primal-deck-line-detail', undefined, line.detail));

		return { root, detail };
	}

	/** The honest empty state: no session, or a session that has not streamed anything yet. */
	private updateEmpty(): void {
		const isEmpty = this.order.length === 0;
		this.empty.classList.toggle('active', isEmpty);
		if (!isEmpty) {
			return;
		}
		const session = this.stream.session;
		this.empty.textContent = session
			? localize('primalDeck.stream.quiet', "Watching {0} — nothing has streamed yet.", session.title)
			: localize('primalDeck.stream.empty', "No agent running — start one in chat.");
	}
}
