/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { clamp } from '../../../base/common/numbers.js';
import { isString } from '../../../base/common/types.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { IPrimalTelemetryInfo, IPrimalTelemetrySample, LEASE_EXPIRY_MS, SAMPLE_INTERVAL_MS } from '../common/primalTelemetry.js';

/**
 * Cumulative CPU time of one logical core in milliseconds since boot — the
 * shape of `os.cpus()[i].times`.
 */
export interface IPrimalCpuTimes {
	readonly user: number;
	readonly nice: number;
	readonly sys: number;
	readonly idle: number;
	readonly irq: number;
}

/** One logical core as `os.cpus()` reports it. */
export interface IPrimalCpuInfo {
	readonly model: string;
	readonly times: IPrimalCpuTimes;
}

/**
 * Everything the sampler reads from the machine and the clock, so a test can
 * script both. Production binds every member to the matching `os` call.
 */
export interface IPrimalTelemetryHost {
	/** Epoch milliseconds. */
	now(): number;
	/** One entry per logical core; empty when the OS exposes no CPU information. */
	cpus(): readonly IPrimalCpuInfo[];
	availableParallelism(): number;
	totalMemory(): number;
	freeMemory(): number;
	/** 1, 5 and 15 minute load averages; all zero on Windows. */
	loadAverage(): readonly number[];
	/** Seconds since boot. */
	uptime(): number;
	readonly platform: string;
	readonly arch: string;
}

/** Busy fractions derived from two cumulative CPU readings. */
export interface IPrimalCpuBusy {
	readonly cores: readonly number[];
	readonly cpuTotal: number;
}

/** `os.loadavg()` is documented to return zeros on this platform. */
const PLATFORM_WITHOUT_LOAD_AVERAGE = 'win32';

/**
 * Busy fraction of every core over the interval between two cumulative
 * readings: `1 - idleDelta / totalDelta`, clamped to 0..1. The total is taken
 * from the summed deltas rather than the mean of the fractions, so each core
 * weighs its own elapsed time. A core count change between the readings (CPU
 * hot-plug) yields `undefined` because the deltas would pair up different
 * cores; the caller re-baselines.
 */
export function computeCpuBusy(previous: readonly IPrimalCpuTimes[], current: readonly IPrimalCpuTimes[]): IPrimalCpuBusy | undefined {
	if (previous.length !== current.length) {
		return undefined;
	}

	const cores: number[] = [];
	let idleSum = 0;
	let totalSum = 0;
	for (let i = 0; i < current.length; i++) {
		const idleDelta = current[i].idle - previous[i].idle;
		const totalDelta = sumOfTimes(current[i]) - sumOfTimes(previous[i]);
		idleSum += idleDelta;
		totalSum += totalDelta;
		cores.push(busyFraction(idleDelta, totalDelta));
	}

	return { cores, cpuTotal: busyFraction(idleSum, totalSum) };
}

function sumOfTimes(times: IPrimalCpuTimes): number {
	return times.user + times.nice + times.sys + times.idle + times.irq;
}

/** No elapsed time, or a non-finite counter, reads as idle rather than as a division artefact. */
function busyFraction(idleDelta: number, totalDelta: number): number {
	if (!Number.isFinite(idleDelta) || !Number.isFinite(totalDelta) || totalDelta <= 0) {
		return 0;
	}

	return clamp(1 - idleDelta / totalDelta, 0, 1);
}

/**
 * The engine behind the main-process telemetry service: a lease registry and
 * a sampler that ticks every {@link SAMPLE_INTERVAL_MS} only while at least
 * one lease is live.
 *
 * Lease semantics:
 * - `acquireLease` registers a fresh id stamped with the host clock. The
 *   0 → 1 transition takes a *silent* baseline reading of the CPU counters and
 *   starts the interval; the first `onDidSample` fires one interval later, so
 *   every emitted busy fraction is a delta over a real, recent interval and
 *   never a boot-cumulative figure.
 * - `renewLease` restamps a known id; unknown ids are ignored.
 * - `releaseLease` drops an id; the 1 → 0 transition stops the interval and
 *   discards the baseline.
 * - Every tick first sweeps leases not renewed within {@link LEASE_EXPIRY_MS};
 *   when the sweep empties the registry the tick stops sampling instead of
 *   emitting.
 * - A later re-acquire takes a new baseline, so a delta never spans an idle
 *   gap.
 */
export class PrimalTelemetrySampler extends Disposable {

	private readonly _onDidSample = this._register(new Emitter<IPrimalTelemetrySample>());
	readonly onDidSample = this._onDidSample.event;

	/** Lease id → host time of the last acquire or renew. */
	private readonly leases = new Map<string, number>();
	private readonly timer = this._register(new IntervalTimer());
	/** CPU counters of the previous tick; `undefined` exactly while not sampling. */
	private baseline: readonly IPrimalCpuTimes[] | undefined;

	constructor(
		private readonly host: IPrimalTelemetryHost,
		private readonly logService: ILogService,
	) {
		super();
	}

	/** True while the interval runs, i.e. while at least one lease is live. */
	get isSampling(): boolean {
		return this.baseline !== undefined;
	}

	get leaseCount(): number {
		return this.leases.size;
	}

	getInfo(): IPrimalTelemetryInfo {
		const cpus = this.host.cpus();

		return {
			cpuModel: cpus[0]?.model ?? '',
			coreCount: cpus.length > 0 ? cpus.length : this.host.availableParallelism(),
			platform: this.host.platform,
			arch: this.host.arch,
			hasLoadAverage: this.host.platform !== PLATFORM_WITHOUT_LOAD_AVERAGE,
		};
	}

	acquireLease(): string {
		const leaseId = generateUuid();
		if (this._store.isDisposed) {
			this.logService.trace(`[PrimalTelemetry] lease ${leaseId} requested after shutdown; not sampling`);
			return leaseId;
		}

		this.leases.set(leaseId, this.host.now());
		this.logService.trace(`[PrimalTelemetry] lease ${leaseId} acquired (${this.leases.size} live)`);
		this.startSampling();

		return leaseId;
	}

	renewLease(leaseId: string): void {
		if (!isString(leaseId) || !this.leases.has(leaseId)) {
			this.logService.trace(`[PrimalTelemetry] renew ignored for unknown lease ${String(leaseId)}`);
			return;
		}

		this.leases.set(leaseId, this.host.now());
	}

	releaseLease(leaseId: string): void {
		if (!isString(leaseId) || !this.leases.delete(leaseId)) {
			this.logService.trace(`[PrimalTelemetry] release ignored for unknown lease ${String(leaseId)}`);
			return;
		}

		this.logService.trace(`[PrimalTelemetry] lease ${leaseId} released (${this.leases.size} live)`);
		this.stopSamplingWhenIdle();
	}

	override dispose(): void {
		this.leases.clear();
		this.stopSamplingWhenIdle();
		super.dispose();
	}

	private startSampling(): void {
		if (this.baseline !== undefined) {
			return; // already running
		}

		this.baseline = this.readCpuTimes();
		this.timer.cancelAndSet(() => this.tick(), SAMPLE_INTERVAL_MS);
		this.logService.trace('[PrimalTelemetry] sampling started');
	}

	private stopSamplingWhenIdle(): void {
		if (this.leases.size > 0 || this.baseline === undefined) {
			return;
		}

		this.timer.cancel();
		this.baseline = undefined;
		this.logService.trace('[PrimalTelemetry] sampling stopped');
	}

	private tick(): void {
		this.sweepExpiredLeases();
		if (this.baseline === undefined) {
			return; // the sweep emptied the registry
		}

		const current = this.readCpuTimes();
		const busy = computeCpuBusy(this.baseline, current);
		this.baseline = current;
		if (!busy) {
			this.logService.trace('[PrimalTelemetry] core count changed; re-baselined without a sample');
			return;
		}

		const sample = this.readSample(busy);
		this.logService.trace(`[PrimalTelemetry] sample cpu=${sample.cpuTotal.toFixed(3)} cores=${sample.cores.length}`);
		this._onDidSample.fire(sample);
	}

	private sweepExpiredLeases(): void {
		const now = this.host.now();
		const expired = [...this.leases]
			.filter(([, renewedAt]) => now - renewedAt > LEASE_EXPIRY_MS)
			.map(([leaseId]) => leaseId);

		for (const leaseId of expired) {
			this.leases.delete(leaseId);
			this.logService.trace(`[PrimalTelemetry] lease ${leaseId} expired (${this.leases.size} live)`);
		}

		this.stopSamplingWhenIdle();
	}

	private readCpuTimes(): readonly IPrimalCpuTimes[] {
		return this.host.cpus().map(cpu => cpu.times);
	}

	private readSample(busy: IPrimalCpuBusy): IPrimalTelemetrySample {
		const memoryTotal = this.host.totalMemory();
		const memoryUsed = Math.max(0, memoryTotal - this.host.freeMemory());
		const [one = 0, five = 0, fifteen = 0] = this.host.loadAverage();

		return {
			timestamp: this.host.now(),
			cores: busy.cores,
			cpuTotal: busy.cpuTotal,
			memoryUsed,
			memoryTotal,
			loadAverage: [one, five, fifteen],
			uptime: this.host.uptime(),
		};
	}
}
