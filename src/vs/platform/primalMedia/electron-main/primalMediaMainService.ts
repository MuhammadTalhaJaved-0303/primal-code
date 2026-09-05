/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IPrimalMediaCapabilities, IPrimalMediaService, IPrimalNowPlaying } from '../common/primalMedia.js';
import { DarwinNowPlayingReader } from './darwinNowPlaying.js';
import { INowPlayingReader, PrimalMediaPoller } from './primalMediaPoller.js';

/**
 * Main-process implementation of {@link IPrimalMediaService}.
 *
 * macOS reads Spotify and Music through `osascript`; darwinNowPlayingScript.ts holds
 * the running-guard that keeps the script from ever launching a player. Every other
 * platform reports `supported: false`: leases are still handed out so callers can stay
 * uniform, but nothing polls and nothing is tracked.
 *
 * Exposed to renderers with `ProxyChannel.fromService`: every method returns a Promise
 * and the only event follows the `onDidChange…` naming convention, so no hand-written
 * channel pair is needed. Renderers reach it via `registerMainProcessRemoteService`.
 */
export class PrimalMediaMainService extends Disposable implements IPrimalMediaService {

	declare readonly _serviceBrand: undefined;

	readonly onDidChangeNowPlaying: Event<IPrimalNowPlaying | undefined>;

	private readonly capabilities: IPrimalMediaCapabilities;
	private readonly poller: PrimalMediaPoller;

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService logService: ILogService,
	) {
		super();
		const reader = createNowPlayingReader(logService);
		this.capabilities = reader
			? { supported: true, players: reader.players }
			: { supported: false, players: [] };
		this.poller = this._register(new PrimalMediaPoller(reader, logService));
		this.onDidChangeNowPlaying = this.poller.onDidChangeNowPlaying;
		this._register(lifecycleMainService.onWillShutdown(() => this.poller.stop()));
		logService.trace(`[PrimalMedia] ${reader ? `players: ${reader.players.join(', ')}` : 'no player support on this platform'}`);
	}

	async getCapabilities(): Promise<IPrimalMediaCapabilities> {
		return this.capabilities;
	}

	async getNowPlaying(): Promise<IPrimalNowPlaying | undefined> {
		return this.poller.getNowPlaying();
	}

	async acquireLease(): Promise<string> {
		return this.poller.acquireLease();
	}

	async renewLease(leaseId: string): Promise<void> {
		if (typeof leaseId === 'string') {
			this.poller.renewLease(leaseId);
		}
	}

	async releaseLease(leaseId: string): Promise<void> {
		if (typeof leaseId === 'string') {
			this.poller.releaseLease(leaseId);
		}
	}
}

function createNowPlayingReader(logService: ILogService): INowPlayingReader | undefined {
	return isMacintosh ? new DarwinNowPlayingReader(logService) : undefined;
}
