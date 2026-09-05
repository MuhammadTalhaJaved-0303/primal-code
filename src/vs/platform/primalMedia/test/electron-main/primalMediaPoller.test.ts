/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IPrimalNowPlaying, MEDIA_LEASE_EXPIRY_MS, MEDIA_LEASE_RENEW_INTERVAL_MS, MEDIA_POLL_INTERVAL_MS } from '../../common/primalMedia.js';
import { INowPlayingReader, IPrimalMediaPollerOptions, PrimalMediaPoller } from '../../electron-main/primalMediaPoller.js';

class FakeReader implements INowPlayingReader {
	readonly players = ['fake'];
	reads = 0;
	next: IPrimalNowPlaying | undefined = undefined;
	/** When set, a read resolves only once the gate is completed. */
	gate: DeferredPromise<void> | undefined;

	async read(): Promise<IPrimalNowPlaying | undefined> {
		this.reads++;
		await this.gate?.p;
		return this.next;
	}
}

const TRACK_A: IPrimalNowPlaying = { app: 'fake', appLabel: 'Fake', title: 'A', artist: 'Someone', state: 'playing', position: 10, duration: 200 };
const TRACK_B: IPrimalNowPlaying = { ...TRACK_A, title: 'B' };
const PAUSED_A: IPrimalNowPlaying = { ...TRACK_A, state: 'paused' };

const FAKED_TIMERS = { useFakeTimers: true, maxTaskCount: 10_000 };

suite('Primal Media - poller', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createPoller(reader: INowPlayingReader | undefined, options?: IPrimalMediaPollerOptions): { poller: PrimalMediaPoller; events: (IPrimalNowPlaying | undefined)[] } {
		const poller = store.add(new PrimalMediaPoller(reader, new NullLogService(), options));
		const events: (IPrimalNowPlaying | undefined)[] = [];
		store.add(poller.onDidChangeNowPlaying(reading => events.push(reading)));
		return { poller, events };
	}

	/** Lets an in-flight read settle and its result be published. */
	const settle = () => timeout(1);

	/** Waits until just after the n-th poll tick from now, so assertions never race a tick. */
	const afterTicks = (n: number) => timeout(n * MEDIA_POLL_INTERVAL_MS + 1);

	test('unsupported platform: leases are handed out but nothing polls', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const { poller, events } = createPoller(undefined);

		const leaseId = poller.acquireLease();
		await afterTicks(5);

		assert.strictEqual(typeof leaseId, 'string');
		assert.deepStrictEqual({ polling: poller.isPolling, leases: poller.leaseCount, nowPlaying: poller.getNowPlaying(), events }, { polling: false, leases: 0, nowPlaying: undefined, events: [] });
		poller.stop();
	}));

	test('acquiring polls immediately and then once per interval', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		const { poller } = createPoller(reader);

		poller.acquireLease();
		assert.strictEqual(reader.reads, 1);
		await afterTicks(3);
		assert.strictEqual(reader.reads, 4);
		assert.strictEqual(poller.isPolling, true);
		poller.stop();
	}));

	test('publishes the first reading and afterwards only changes, including going away once', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		reader.next = TRACK_A;
		const { poller, events } = createPoller(reader);

		poller.acquireLease();
		await settle();
		assert.deepStrictEqual(events, [TRACK_A]);
		assert.deepStrictEqual(poller.getNowPlaying(), TRACK_A);

		await afterTicks(2);
		assert.deepStrictEqual(events, [TRACK_A], 'an unchanged reading is not published again');

		reader.next = TRACK_B;
		await afterTicks(1);
		reader.next = undefined;
		await afterTicks(2);
		assert.deepStrictEqual(events, [TRACK_A, TRACK_B, undefined]);
		assert.strictEqual(poller.getNowPlaying(), undefined);
		poller.stop();
	}));

	test('an unrenewed lease expires and polling stops', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		reader.next = TRACK_A;
		const { poller } = createPoller(reader);

		poller.acquireLease();
		await afterTicks(MEDIA_LEASE_EXPIRY_MS / MEDIA_POLL_INTERVAL_MS + 2);
		assert.deepStrictEqual({ polling: poller.isPolling, leases: poller.leaseCount, nowPlaying: poller.getNowPlaying() }, { polling: false, leases: 0, nowPlaying: undefined });

		const readsWhenStopped = reader.reads;
		await afterTicks(5);
		assert.strictEqual(reader.reads, readsWhenStopped, 'no read may happen after the last lease expired');
	}));

	test('renewing on schedule keeps polling alive past the expiry window', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		const { poller } = createPoller(reader);

		const leaseId = poller.acquireLease();
		for (let elapsed = 0; elapsed < MEDIA_LEASE_EXPIRY_MS * 2; elapsed += MEDIA_LEASE_RENEW_INTERVAL_MS) {
			await timeout(MEDIA_LEASE_RENEW_INTERVAL_MS);
			poller.renewLease(leaseId);
		}
		assert.strictEqual(poller.isPolling, true);
		assert.ok(reader.reads > MEDIA_LEASE_EXPIRY_MS / MEDIA_POLL_INTERVAL_MS, `expected steady polling, got ${reader.reads} reads`);
		poller.stop();
	}));

	test('renewing an unknown id is ignored', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const { poller } = createPoller(new FakeReader());

		poller.renewLease('not-a-lease');
		assert.deepStrictEqual({ polling: poller.isPolling, leases: poller.leaseCount }, { polling: false, leases: 0 });
	}));

	test('releasing the last lease stops polling and forgets the reading; re-acquiring publishes afresh', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		reader.next = TRACK_A;
		const { poller, events } = createPoller(reader);

		const first = poller.acquireLease();
		const second = poller.acquireLease();
		await settle();
		poller.releaseLease(first);
		assert.strictEqual(poller.isPolling, true, 'one live lease remains');

		poller.releaseLease(second);
		assert.deepStrictEqual({ polling: poller.isPolling, nowPlaying: poller.getNowPlaying(), events }, { polling: false, nowPlaying: undefined, events: [TRACK_A, undefined] });

		poller.acquireLease();
		await settle();
		assert.deepStrictEqual(events, [TRACK_A, undefined, TRACK_A], 'a consumer that comes back gets a fresh reading even if nothing changed');
		poller.stop();
	}));

	test('a lease that expires publishes nothing-playing, so no consumer keeps a dead track', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		reader.next = TRACK_A;
		const { poller, events } = createPoller(reader);

		poller.acquireLease();
		await settle();
		assert.deepStrictEqual(events, [TRACK_A]);

		await afterTicks(MEDIA_LEASE_EXPIRY_MS / MEDIA_POLL_INTERVAL_MS + 2);
		assert.deepStrictEqual({ polling: poller.isPolling, events }, { polling: false, events: [TRACK_A, undefined] });
	}));

	test('a read that has not returned is never overlapped by the next tick', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		reader.gate = new DeferredPromise<void>();
		const { poller } = createPoller(reader);

		poller.acquireLease();
		await afterTicks(2);
		assert.strictEqual(reader.reads, 1, 'ticks during an in-flight read are skipped');

		reader.gate.complete();
		await settle();
		await afterTicks(1);
		assert.strictEqual(reader.reads, 2, 'polling resumes once the read returned');
		poller.stop();
	}));

	test('a reading that arrives after the last lease went is dropped', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		reader.next = TRACK_A;
		reader.gate = new DeferredPromise<void>();
		const { poller, events } = createPoller(reader);

		const leaseId = poller.acquireLease();
		poller.releaseLease(leaseId);
		reader.gate.complete();
		await settle();
		assert.deepStrictEqual({ events, nowPlaying: poller.getNowPlaying() }, { events: [], nowPlaying: undefined });
	}));

	test('a track paused at the same position for too long counts as nothing playing', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const pausedStaleMs = MEDIA_POLL_INTERVAL_MS * 4;
		const reader = new FakeReader();
		reader.next = PAUSED_A;
		const { poller, events } = createPoller(reader, { pausedStaleMs });

		const leaseId = poller.acquireLease();
		await settle();
		assert.deepStrictEqual(events, [PAUSED_A]);

		await afterTicks(pausedStaleMs / MEDIA_POLL_INTERVAL_MS + 1);
		poller.renewLease(leaseId);
		assert.deepStrictEqual(events, [PAUSED_A, undefined], 'a long pause is reported as gone');

		const resumedPause = { ...PAUSED_A, position: 11 };
		reader.next = resumedPause;
		await afterTicks(1);
		assert.deepStrictEqual(events, [PAUSED_A, undefined, resumedPause], 'a pause at a new position is a fresh pause');
		poller.stop();
	}));

	test('stop drops every lease and stops polling', () => runWithFakedTimers(FAKED_TIMERS, async () => {
		const reader = new FakeReader();
		const { poller } = createPoller(reader);

		poller.acquireLease();
		poller.acquireLease();
		poller.stop();
		const readsWhenStopped = reader.reads;
		await afterTicks(3);
		assert.deepStrictEqual({ polling: poller.isPolling, leases: poller.leaseCount, reads: reader.reads }, { polling: false, leases: 0, reads: readsWhenStopped });
	}));
});
