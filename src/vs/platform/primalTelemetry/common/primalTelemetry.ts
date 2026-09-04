/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IPrimalTelemetryService = createDecorator<IPrimalTelemetryService>('primalTelemetryService');

/**
 * One reading of the machine, taken in the main process. Every field is a raw
 * operating-system number; nothing here is smoothed, estimated or invented.
 */
export interface IPrimalTelemetrySample {
	/** Wall-clock time of the sample, epoch milliseconds. */
	readonly timestamp: number;
	/** Busy fraction per logical core over the interval since the previous sample, 0..1. */
	readonly cores: readonly number[];
	/** Busy fraction across all cores over the same interval, 0..1. */
	readonly cpuTotal: number;
	/** Bytes of memory in use (`os.totalmem() - os.freemem()`). */
	readonly memoryUsed: number;
	/** Bytes of physical memory. */
	readonly memoryTotal: number;
	/** 1, 5 and 15 minute load averages (`os.loadavg()`; all zero on Windows). */
	readonly loadAverage: readonly [number, number, number];
	/** Seconds since boot (`os.uptime()`). */
	readonly uptime: number;
}

/** Static facts about the machine, read once. */
export interface IPrimalTelemetryInfo {
	readonly cpuModel: string;
	readonly coreCount: number;
	readonly platform: string;
	readonly arch: string;
	/** Whether `loadAverage` carries real values on this platform. */
	readonly hasLoadAverage: boolean;
}

/**
 * Live machine telemetry for The Deck, sampled in the main process and streamed
 * to the renderer.
 *
 * Sampling costs CPU itself, so it only runs while a lease is held. A lease is
 * acquired by a consumer that is on screen, renewed every few seconds while it
 * stays on screen, and released when it goes away. Leases that are not renewed
 * expire, so a window that dies mid-session cannot leave the main process
 * sampling forever.
 */
export interface IPrimalTelemetryService {
	readonly _serviceBrand: undefined;

	/** Fires once per sampling interval while at least one lease is live. */
	readonly onDidSample: Event<IPrimalTelemetrySample>;

	getInfo(): Promise<IPrimalTelemetryInfo>;

	/**
	 * Start (or keep) sampling. Returns a lease id the caller must renew with
	 * {@link renewLease} at least every {@link LEASE_RENEW_INTERVAL_MS} and hand
	 * back to {@link releaseLease} when done.
	 */
	acquireLease(): Promise<string>;

	/** Keeps a lease alive. Unknown or expired ids are ignored. */
	renewLease(leaseId: string): Promise<void>;

	/** Ends a lease. Sampling stops when the last live lease is released. */
	releaseLease(leaseId: string): Promise<void>;
}

/** How often a live consumer renews its lease. */
export const LEASE_RENEW_INTERVAL_MS = 5_000;

/** A lease not renewed within this window is dropped by the main process. */
export const LEASE_EXPIRY_MS = 15_000;

/** Sampling interval while leased. */
export const SAMPLE_INTERVAL_MS = 1_000;
