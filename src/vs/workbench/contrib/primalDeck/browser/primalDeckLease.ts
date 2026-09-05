/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

/** The lease half shared by the telemetry and media contracts. */
export interface ILeaseSource {
	acquireLease(): Promise<string>;
	renewLease(leaseId: string): Promise<void>;
	releaseLease(leaseId: string): Promise<void>;
}

/**
 * Holds one main-process lease while started: acquires it, renews it on the
 * interval the contract names, and releases it on `stop()` or dispose.
 *
 * Every transition is guarded by a generation counter, so a `stop()` that
 * lands while the acquire round trip is still in flight hands the lease back
 * the moment it arrives instead of leaving it to expire in the main process.
 * Nothing here runs while stopped: the renew timer only exists between a
 * successful acquire and the next `stop()`.
 */
export class PrimalDeckLease extends Disposable {

	private readonly renewTimer = this._register(new IntervalTimer());

	private readonly _onDidFail = this._register(new Emitter<unknown>());
	/** Fires when an acquire or renew round trip rejects; the lease is then not held. */
	readonly onDidFail = this._onDidFail.event;

	private generation = 0;
	private active = false;
	private leaseId: string | undefined;

	constructor(
		private readonly source: ILeaseSource,
		private readonly renewIntervalMs: number
	) {
		super();
	}

	get isActive(): boolean {
		return this.active;
	}

	start(): void {
		if (this.active) {
			return;
		}
		this.active = true;
		const generation = ++this.generation;

		this.source.acquireLease().then(leaseId => {
			if (generation !== this.generation) {
				// Stopped while the acquire was in flight: give it straight back.
				this.source.releaseLease(leaseId).catch(error => this._onDidFail.fire(error));
				return;
			}
			this.leaseId = leaseId;
			this.renewTimer.cancelAndSet(() => this.renew(leaseId, generation), this.renewIntervalMs);
		}, error => {
			if (generation === this.generation) {
				this.active = false;
				this._onDidFail.fire(error);
			}
		});
	}

	private renew(leaseId: string, generation: number): void {
		this.source.renewLease(leaseId).catch(error => {
			if (generation === this.generation) {
				this._onDidFail.fire(error);
			}
		});
	}

	stop(): void {
		if (!this.active) {
			return;
		}
		this.active = false;
		this.generation++;
		this.renewTimer.cancel();

		const leaseId = this.leaseId;
		this.leaseId = undefined;
		if (leaseId !== undefined) {
			this.source.releaseLease(leaseId).catch(error => this._onDidFail.fire(error));
		}
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
