/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IPrimalNowPlaying } from '../../../../platform/primalMedia/common/primalMedia.js';
import { formatPlaybackTime } from './primalDeckFormat.js';

const $ = DOM.$;

interface IReportedTrack {
	readonly nowPlaying: IPrimalNowPlaying;
	/** Epoch ms when the player reported this; the position readout advances from here while playing. */
	readonly reportedAt: number;
}

/**
 * Now Playing: only ever built from a real player's answer. The panel exists
 * only when `getCapabilities()` reported support; on other platforms it is
 * never created, so nothing fake is ever shown.
 */
export class PrimalDeckNowPlayingPanel extends Disposable {

	private readonly panel: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly track: HTMLElement;
	private readonly art: HTMLImageElement;
	private readonly title: HTMLElement;
	private readonly artist: HTMLElement;
	private readonly transportGlyph: HTMLElement;
	private readonly transportWord: HTMLElement;
	private readonly position: HTMLElement;
	private readonly app: HTMLElement;
	private current: IReportedTrack | undefined;

	constructor(container: HTMLElement) {
		super();

		this.panel = $('.primal-deck-panel.primal-deck-now-playing');
		// Above the sessions panel, which is rendered synchronously before the capability answer arrives.
		container.prepend(this.panel);
		DOM.append(this.panel, $('h2.primal-deck-panel-label', undefined, localize('primalDeck.nowPlaying', "Now Playing")));

		this.empty = DOM.append(this.panel, $('.primal-deck-panel-status', undefined, localize('primalDeck.nowPlaying.nothing', "Nothing playing")));
		this.track = DOM.append(this.panel, $('.primal-deck-track'));

		this.art = DOM.append(this.track, $('img.primal-deck-art', { alt: '' })) as HTMLImageElement;
		this._register(DOM.addDisposableListener(this.art, 'error', () => this.art.classList.remove('active')));

		const text = DOM.append(this.track, $('.primal-deck-track-text'));
		this.title = DOM.append(text, $('.primal-deck-track-title'));
		this.artist = DOM.append(text, $('.primal-deck-track-artist'));
		const transport = DOM.append(text, $('.primal-deck-transport'));
		this.transportGlyph = DOM.append(transport, $('span.primal-deck-transport-glyph', { 'aria-hidden': 'true' }));
		this.transportWord = DOM.append(transport, $('span.primal-deck-transport-word'));
		this.position = DOM.append(transport, $('span.primal-deck-transport-position'));
		this.app = DOM.append(transport, $('span.primal-deck-transport-app'));
	}

	update(nowPlaying: IPrimalNowPlaying | undefined, reportedAt: number): void {
		this.current = nowPlaying ? { nowPlaying, reportedAt } : undefined;
		this.track.classList.toggle('active', !!nowPlaying);
		this.empty.textContent = nowPlaying ? '' : localize('primalDeck.nowPlaying.nothing', "Nothing playing");
		if (!nowPlaying) {
			this.art.classList.remove('active');
			return;
		}

		this.title.textContent = nowPlaying.title;
		this.title.title = nowPlaying.title;
		this.artist.textContent = nowPlaying.album ? localize('primalDeck.nowPlaying.artistAlbum', "{0} · {1}", nowPlaying.artist, nowPlaying.album) : nowPlaying.artist;
		this.app.textContent = nowPlaying.appLabel;

		switch (nowPlaying.state) {
			case 'playing':
				// allow-any-unicode-next-line
				this.transportGlyph.textContent = '▶';
				this.transportWord.textContent = localize('primalDeck.nowPlaying.playing', "playing");
				break;
			case 'paused':
				// allow-any-unicode-next-line
				this.transportGlyph.textContent = '‖';
				this.transportWord.textContent = localize('primalDeck.nowPlaying.paused', "paused");
				break;
			default:
				// allow-any-unicode-next-line
				this.transportGlyph.textContent = '■';
				this.transportWord.textContent = localize('primalDeck.nowPlaying.stopped', "stopped");
		}

		// Artwork only from a real URL the player handed over, and only over https.
		const artworkUrl = nowPlaying.artworkUrl;
		if (artworkUrl && artworkUrl.startsWith('https://')) {
			if (this.art.src !== artworkUrl) {
				this.art.src = artworkUrl;
			}
			this.art.classList.add('active');
		} else {
			this.art.removeAttribute('src');
			this.art.classList.remove('active');
		}

		this.tick(reportedAt);
	}

	/**
	 * Advances the position readout by the wall-clock time since the player's
	 * report, while it reported itself playing. The player's own numbers are
	 * shown untouched the moment the next report lands.
	 */
	tick(now: number): void {
		const current = this.current;
		const position = current?.nowPlaying.position;
		if (!current || typeof position !== 'number') {
			this.position.textContent = '';
			return;
		}
		const duration = current.nowPlaying.duration;
		const elapsed = current.nowPlaying.state === 'playing' ? Math.max(0, (now - current.reportedAt) / 1000) : 0;
		const shown = typeof duration === 'number' ? Math.min(duration, position + elapsed) : position + elapsed;
		this.position.textContent = typeof duration === 'number'
			? localize('primalDeck.nowPlaying.position', "{0} / {1}", formatPlaybackTime(shown), formatPlaybackTime(duration))
			: formatPlaybackTime(shown);
	}

	/** The lease could not be held: the panel says so rather than sitting on a stale track. */
	setUnavailable(): void {
		this.current = undefined;
		this.track.classList.remove('active');
		this.art.classList.remove('active');
		this.empty.textContent = localize('primalDeck.nowPlaying.unavailable', "Now Playing unavailable.");
	}
}
