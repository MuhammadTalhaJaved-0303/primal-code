/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IPrimalTelemetrySample, LEASE_EXPIRY_MS, LEASE_RENEW_INTERVAL_MS, SAMPLE_INTERVAL_MS } from '../../common/primalTelemetry.js';
import { computeCpuBusy, IPrimalCpuInfo, IPrimalCpuTimes, IPrimalTelemetryHost, PrimalTelemetrySampler } from '../../electron-main/primalTelemetrySampler.js';

const GIB = 1024 ** 3;

function cpuTimes(user: number, sys: number, idle: number): IPrimalCpuTimes {
	return { user, nice: 0, sys, idle, irq: 0 };
}

interface ICoreDelta {
	readonly busy: number;
	readonly idle: number;
}

/**
 * A scripted machine and clock: the test decides what every reader answers,
 * and `burn` advances the cumulative CPU counters the way a real tick would.
 */
class TestTelemetryHost implements IPrimalTelemetryHost {

	time = 0;
	platform = 'darwin';
	readonly arch = 'arm64';
	cores: readonly IPrimalCpuTimes[] = [cpuTimes(100, 50, 850), cpuTimes(200, 0, 800)];
	memoryTotal = 32 * GIB;
	memoryFree = 8 * GIB;
	load: readonly number[] = [1.5, 1.25, 1];
	secondsUp = 3600;

	now(): number {
		return this.time;
	}

	cpus(): readonly IPrimalCpuInfo[] {
		return this.cores.map(times => ({ model: 'Test CPU', times }));
	}

	availableParallelism(): number {
		return 8;
	}

	totalMemory(): number {
		return this.memoryTotal;
	}

	freeMemory(): number {
		return this.memoryFree;
	}

	loadAverage(): readonly number[] {
		return this.load;
	}

	uptime(): number {
		return this.secondsUp;
	}

	burn(deltas: readonly ICoreDelta[]): void {
		this.cores = this.cores.map((times, i) => ({ ...times, user: times.user + deltas[i].busy, idle: times.idle + deltas[i].idle }));
	}
}

suite('PrimalTelemetrySampler', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let clock: sinon.SinonFakeTimers;
	let host: TestTelemetryHost;
	let sampler: PrimalTelemetrySampler;
	let samples: IPrimalTelemetrySample[];

	setup(() => {
		clock = sinon.useFakeTimers();
		host = new TestTelemetryHost();
		samples = [];
		sampler = store.add(new PrimalTelemetrySampler(host, store.add(new NullLogService())));
		store.add(sampler.onDidSample(sample => samples.push(sample)));
	});

	teardown(() => {
		clock.restore();
	});

	/** Moves the scripted clock and the timer queue forward together, one sampling interval at a time. */
	async function advanceIntervals(count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			host.time += SAMPLE_INTERVAL_MS;
			await clock.tickAsync(SAMPLE_INTERVAL_MS);
		}
	}

	test('computeCpuBusy: per-core busy fraction and time-weighted total', () => {
		const previous = [cpuTimes(0, 0, 0), cpuTimes(0, 0, 0)];
		const current = [cpuTimes(300, 200, 500), cpuTimes(0, 0, 1000)];

		assert.deepStrictEqual(computeCpuBusy(previous, current), { cores: [0.5, 0], cpuTotal: 0.25 });
	});

	test('computeCpuBusy: no elapsed time reads idle, wrapped counters clamp, a core count change yields nothing', () => {
		const stalled = [cpuTimes(100, 0, 900)];

		assert.deepStrictEqual({
			stalled: computeCpuBusy(stalled, stalled),
			overshoot: computeCpuBusy([cpuTimes(100, 0, 900)], [cpuTimes(350, 0, 850)]),
			undershoot: computeCpuBusy([cpuTimes(100, 0, 900)], [cpuTimes(50, 0, 1200)]),
			hotPlug: computeCpuBusy([cpuTimes(100, 0, 900)], [cpuTimes(100, 0, 900), cpuTimes(0, 0, 0)]),
		}, {
			stalled: { cores: [0], cpuTotal: 0 },
			overshoot: { cores: [1], cpuTotal: 1 },
			undershoot: { cores: [0], cpuTotal: 0 },
			hotPlug: undefined,
		});
	});

	test('acquire takes a silent baseline; the first sample is the delta one interval later', async () => {
		sampler.acquireLease();
		assert.deepStrictEqual({ sampling: sampler.isSampling, samples }, { sampling: true, samples: [] });

		host.burn([{ busy: 500, idle: 500 }, { busy: 250, idle: 750 }]);
		await advanceIntervals(1);

		assert.deepStrictEqual(samples, [{
			timestamp: SAMPLE_INTERVAL_MS,
			cores: [0.5, 0.25],
			cpuTotal: 0.375,
			memoryUsed: 24 * GIB,
			memoryTotal: 32 * GIB,
			loadAverage: [1.5, 1.25, 1],
			uptime: 3600,
		}]);
	});

	test('a renewed lease keeps sampling alive; an abandoned one expires and sampling stops', async () => {
		const leaseId = sampler.acquireLease();

		// Renew on the contract cadence for twice the expiry window: sampling never pauses.
		const renewedIntervals = (2 * LEASE_EXPIRY_MS) / SAMPLE_INTERVAL_MS;
		for (let i = 1; i <= renewedIntervals; i++) {
			await advanceIntervals(1);
			if ((i * SAMPLE_INTERVAL_MS) % LEASE_RENEW_INTERVAL_MS === 0) {
				sampler.renewLease(leaseId);
			}
		}
		assert.deepStrictEqual({ samples: samples.length, sampling: sampler.isSampling }, { samples: renewedIntervals, sampling: true });

		// Stop renewing: ticks inside the expiry window still sample, the first tick past it sweeps the lease and stops.
		const expiryIntervals = LEASE_EXPIRY_MS / SAMPLE_INTERVAL_MS + 1;
		await advanceIntervals(expiryIntervals);
		const emittedAtExpiry = samples.length;
		await advanceIntervals(5);

		assert.deepStrictEqual(
			{ emittedAtExpiry, emittedLater: samples.length, sampling: sampler.isSampling, leases: sampler.leaseCount },
			{ emittedAtExpiry: renewedIntervals + expiryIntervals - 1, emittedLater: renewedIntervals + expiryIntervals - 1, sampling: false, leases: 0 });
	});

	test('sampling stops when the last lease is released; unknown ids are ignored', async () => {
		const first = sampler.acquireLease();
		const second = sampler.acquireLease();
		sampler.renewLease('not-a-lease');
		sampler.releaseLease('not-a-lease');
		await advanceIntervals(2);

		sampler.releaseLease(first);
		await advanceIntervals(1);
		const samplingWithOneLeft = sampler.isSampling;

		sampler.releaseLease(second);
		await advanceIntervals(3);

		assert.deepStrictEqual(
			{ samplingWithOneLeft, samples: samples.length, sampling: sampler.isSampling, leases: sampler.leaseCount },
			{ samplingWithOneLeft: true, samples: 3, sampling: false, leases: 0 });
	});

	test('re-acquiring after a stop takes a fresh baseline instead of a delta across the gap', async () => {
		const first = sampler.acquireLease();
		await advanceIntervals(1);
		sampler.releaseLease(first);

		// The machine was flat out while nobody was watching; that history must not leak into the next sample.
		host.burn([{ busy: 60_000, idle: 0 }, { busy: 60_000, idle: 0 }]);
		host.time += 60_000;
		sampler.acquireLease();
		host.burn([{ busy: 0, idle: 1000 }, { busy: 250, idle: 750 }]);
		await advanceIntervals(1);

		assert.deepStrictEqual(samples.map(sample => sample.cores), [[0, 0], [0, 0.25]]);
	});

	test('a core count change re-baselines without emitting', async () => {
		sampler.acquireLease();
		host.cores = [...host.cores, cpuTimes(0, 0, 0)];
		await advanceIntervals(1);
		const emittedAfterChange = samples.length;

		host.burn([{ busy: 1000, idle: 0 }, { busy: 0, idle: 1000 }, { busy: 500, idle: 500 }]);
		await advanceIntervals(1);

		assert.deepStrictEqual({ emittedAfterChange, cores: samples.map(sample => sample.cores) }, { emittedAfterChange: 0, cores: [[1, 0, 0.5]] });
	});

	test('getInfo reports the machine; empty cpus() falls back to availableParallelism; Windows has no load average', () => {
		const darwin = sampler.getInfo();
		host.cores = [];
		host.platform = 'win32';
		const windowsWithoutCpuInfo = sampler.getInfo();

		assert.deepStrictEqual({ darwin, windowsWithoutCpuInfo }, {
			darwin: { cpuModel: 'Test CPU', coreCount: 2, platform: 'darwin', arch: 'arm64', hasLoadAverage: true },
			windowsWithoutCpuInfo: { cpuModel: '', coreCount: 8, platform: 'win32', arch: 'arm64', hasLoadAverage: false },
		});
	});

	test('dispose drops leases and stops the interval; a lease acquired afterwards never samples', async () => {
		sampler.acquireLease();
		await advanceIntervals(1);
		sampler.dispose();

		const late = sampler.acquireLease();
		await advanceIntervals(3);

		assert.deepStrictEqual(
			{ lateLeaseIsId: late.length > 0, samples: samples.length, sampling: sampler.isSampling, leases: sampler.leaseCount },
			{ lateLeaseIsId: true, samples: 1, sampling: false, leases: 0 });
	});
});
