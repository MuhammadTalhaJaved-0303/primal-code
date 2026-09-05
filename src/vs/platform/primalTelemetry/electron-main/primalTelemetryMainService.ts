/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IPrimalTelemetryInfo, IPrimalTelemetrySample, IPrimalTelemetryService } from '../common/primalTelemetry.js';
import { IPrimalTelemetryHost, PrimalTelemetrySampler } from './primalTelemetrySampler.js';

/** The real machine: every reader is the matching `os` call, nothing cached or estimated. */
function createOsTelemetryHost(): IPrimalTelemetryHost {
	return {
		now: () => Date.now(),
		cpus: () => os.cpus(),
		availableParallelism: () => os.availableParallelism(),
		totalMemory: () => os.totalmem(),
		freeMemory: () => os.freemem(),
		loadAverage: () => os.loadavg(),
		uptime: () => os.uptime(),
		platform: process.platform,
		arch: process.arch,
	};
}

/**
 * Main-process implementation of {@link IPrimalTelemetryService}, exposed to
 * the renderer through `ProxyChannel.fromService`: `onDidSample` is an
 * enumerable instance property so the proxy discovers it, and every method
 * returns a promise. The engine — leases, expiry, and the `os.cpus()` delta
 * math — lives in {@link PrimalTelemetrySampler}.
 */
export class PrimalTelemetryMainService extends Disposable implements IPrimalTelemetryService {

	declare readonly _serviceBrand: undefined;

	private readonly sampler: PrimalTelemetrySampler;

	readonly onDidSample: Event<IPrimalTelemetrySample>;

	constructor(
		@ILogService logService: ILogService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
	) {
		super();

		this.sampler = this._register(new PrimalTelemetrySampler(createOsTelemetryHost(), logService));
		this.onDidSample = this.sampler.onDidSample;

		// A quitting app must not keep an interval alive; its leases die with it.
		this._register(lifecycleMainService.onWillShutdown(() => this.sampler.dispose()));
	}

	async getInfo(): Promise<IPrimalTelemetryInfo> {
		return this.sampler.getInfo();
	}

	async acquireLease(): Promise<string> {
		return this.sampler.acquireLease();
	}

	async renewLease(leaseId: string): Promise<void> {
		this.sampler.renewLease(leaseId);
	}

	async releaseLease(leaseId: string): Promise<void> {
		this.sampler.releaseLease(leaseId);
	}
}
