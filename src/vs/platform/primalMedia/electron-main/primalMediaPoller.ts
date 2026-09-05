/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { IPrimalNowPlaying, MEDIA_LEASE_EXPIRY_MS, MEDIA_POLL_INTERVAL_MS } from '../common/primalMedia.js';

/**
 * Reads the players of one platform. `read` resolves `undefined` when no player is
 * playing or paused, and treats every failure as "no data" rather than rejecting.
 */
export interface INowPlayingReader {
	/** Player identifiers this reader knows, reported as `IPrimalMediaCapabilities.players`. */
	readonly players: readonly string[];
	read(): Promise<IPrimalNowPlaying | undefined>;
}

export interface IPrimalMediaPollerOptions {
	/** Clock used for lease bookkeeping; injectable for tests. */
	readonly now?: () => number;
	readonly pollIntervalMs?: number;
	readonly leaseExpiryMs?: number;
	readonly pausedStaleMs?: number;
}

/** A track that has sat paused at the same position for this long is reported as nothing playing. */
export const MEDIA_PAUSED_STALE_MS = 10 * 60_000;

/**
 * Lease registry and poll loop behind the main-process media service, kept free of
 * process-wide dependencies so tests can drive it with a fake reader and clock.
 *
 * Polling runs only while at least one lease is live. A lease that is not renewed
 * within the expiry window is dropped on the next tick; when the last lease goes, the
 * timer stops, the cached reading is forgotten and a final `undefined` is published, so
 * nothing downstream keeps a dead track on screen. A consumer that comes back therefore
 * never sees a stale track — it gets a fresh first poll, which runs immediately on
 * acquire. Otherwise the change event fires only when the reading differs from the last
 * one published.
 */
export class PrimalMediaPoller extends Disposable {

	private readonly _onDidChangeNowPlaying = this._register(new Emitter<IPrimalNowPlaying | undefined>());
	readonly onDidChangeNowPlaying = this._onDidChangeNowPlaying.event;

	private readonly now: () => number;
	private readonly pollIntervalMs: number;
	private readonly leaseExpiryMs: number;
	private readonly pausedStaleMs: number;

	/** Lease id → time of acquisition or last renewal. */
	private readonly leases = new Map<string, number>();
	private readonly timer = this._register(new IntervalTimer());
	private polling = false;
	private inFlight = false;

	private nowPlaying: IPrimalNowPlaying | undefined;
	private lastPublishedKey: string | undefined;
	private pausedSince: { readonly key: string; readonly since: number } | undefined;

	constructor(
		private readonly reader: INowPlayingReader | undefined,
		private readonly logService: ILogService,
		options: IPrimalMediaPollerOptions = {},
	) {
		super();
		this.now = options.now ?? (() => Date.now());
		this.pollIntervalMs = options.pollIntervalMs ?? MEDIA_POLL_INTERVAL_MS;
		this.leaseExpiryMs = options.leaseExpiryMs ?? MEDIA_LEASE_EXPIRY_MS;
		this.pausedStaleMs = options.pausedStaleMs ?? MEDIA_PAUSED_STALE_MS;
	}

	get isPolling(): boolean {
		return this.polling;
	}

	get leaseCount(): number {
		return this.leases.size;
	}

	/** Last published reading; `undefined` whenever nothing is polling. */
	getNowPlaying(): IPrimalNowPlaying | undefined {
		return this.nowPlaying;
	}

	acquireLease(): string {
		const leaseId = generateUuid();
		if (!this.reader) {
			return leaseId; // nothing to poll on this platform, so nothing to track either
		}
		this.leases.set(leaseId, this.now());
		if (!this.polling) {
			this.startPolling();
		}
		return leaseId;
	}

	/** Unknown or expired ids are ignored, as the contract specifies. */
	renewLease(leaseId: string): void {
		if (!this.leases.has(leaseId)) {
			this.logService.trace(`[PrimalMedia] renewLease: ignoring unknown or expired lease ${leaseId}`);
			return;
		}
		this.leases.set(leaseId, this.now());
	}

	releaseLease(leaseId: string): void {
		if (this.leases.delete(leaseId) && this.leases.size === 0) {
			this.stopPolling('last lease released');
		}
	}

	/** Drops every lease and stops polling; used on shutdown. */
	stop(): void {
		this.leases.clear();
		this.stopPolling('stopped');
	}

	private startPolling(): void {
		this.polling = true;
		this.logService.trace(`[PrimalMedia] polling every ${this.pollIntervalMs} ms`);
		this.timer.cancelAndSet(() => { void this.tick(); }, this.pollIntervalMs);
		void this.tick();
	}

	private stopPolling(reason: string): void {
		if (!this.polling) {
			return;
		}
		this.polling = false;
		this.timer.cancel();
		const hadReading = this.nowPlaying !== undefined;
		this.nowPlaying = undefined;
		this.lastPublishedKey = undefined;
		this.pausedSince = undefined;
		this.logService.trace(`[PrimalMedia] polling stopped: ${reason}`);

		// Nobody is reading a player any more - the last lease went, or it
		// expired because its renderer stalled. Say so, so that no consumer can
		// go on presenting the track it last heard about as if it were live.
		if (hadReading) {
			this._onDidChangeNowPlaying.fire(undefined);
		}
	}

	private async tick(): Promise<void> {
		this.sweepExpiredLeases();
		if (!this.polling || this.inFlight || !this.reader) {
			return; // a read that has not returned yet is never overlapped by another
		}
		this.inFlight = true;
		try {
			this.publish(await this.reader.read());
		} catch (error) {
			this.logService.trace('[PrimalMedia] reader failed', error);
		} finally {
			this.inFlight = false;
		}
	}

	private sweepExpiredLeases(): void {
		const now = this.now();
		for (const [leaseId, lastRenewed] of this.leases) {
			if (now - lastRenewed > this.leaseExpiryMs) {
				this.leases.delete(leaseId);
				this.logService.trace(`[PrimalMedia] lease ${leaseId} expired`);
			}
		}
		if (this.leases.size === 0) {
			this.stopPolling('all leases expired');
		}
	}

	private publish(reading: IPrimalNowPlaying | undefined): void {
		if (!this.polling) {
			return; // the last lease went while the read was in flight
		}
		const effective = this.withoutStalePause(reading);
		const key = effective ? JSON.stringify(effective) : '';
		if (key === this.lastPublishedKey) {
			return;
		}
		this.lastPublishedKey = key;
		this.nowPlaying = effective;
		this._onDidChangeNowPlaying.fire(effective);
	}

	/** A track paused at the same position for longer than the stale window counts as nothing playing. */
	private withoutStalePause(reading: IPrimalNowPlaying | undefined): IPrimalNowPlaying | undefined {
		if (reading?.state !== 'paused') {
			this.pausedSince = undefined;
			return reading;
		}
		const key = `${reading.app}\n${reading.title}\n${reading.artist}\n${reading.position ?? ''}`;
		const now = this.now();
		if (this.pausedSince?.key !== key) {
			this.pausedSince = { key, since: now };
			return reading;
		}
		return now - this.pausedSince.since >= this.pausedStaleMs ? undefined : reading;
	}
}
