/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IPrimalMediaService = createDecorator<IPrimalMediaService>('primalMediaService');

export type PrimalPlayerState = 'playing' | 'paused' | 'stopped';

/**
 * What a media player on this machine reports it is doing right now. Only ever
 * built from a real player's answer — never a placeholder.
 */
export interface IPrimalNowPlaying {
	/** Player identifier, e.g. `spotify` or `music`. */
	readonly app: string;
	/** Human name of the player, e.g. "Spotify". */
	readonly appLabel: string;
	readonly title: string;
	readonly artist: string;
	readonly album?: string;
	readonly state: PrimalPlayerState;
	/** Playback position in seconds, when the player reports one. */
	readonly position?: number;
	/** Track length in seconds, when the player reports one. */
	readonly duration?: number;
	/** Artwork URL as reported by the player. Absent means show no artwork. */
	readonly artworkUrl?: string;
}

export interface IPrimalMediaCapabilities {
	/** False on platforms with no implementation; consumers omit the panel entirely. */
	readonly supported: boolean;
	/** Player identifiers this platform knows how to read. */
	readonly players: readonly string[];
}

/**
 * Now-playing information for The Deck, read in the main process.
 *
 * Polling a player means talking to another application, so it only happens
 * while a lease is held — the same lease/renew/release contract as
 * {@link IPrimalTelemetryService}. Implementations MUST NOT launch a player
 * that is not already running: on macOS, addressing an application by name
 * starts it, so every query is guarded by an "is running" check first.
 */
export interface IPrimalMediaService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the reported track or state changes while leased. `undefined`
	 * means no supported player is playing or paused.
	 */
	readonly onDidChangeNowPlaying: Event<IPrimalNowPlaying | undefined>;

	getCapabilities(): Promise<IPrimalMediaCapabilities>;

	/** Last known state, or `undefined`; does not poll. */
	getNowPlaying(): Promise<IPrimalNowPlaying | undefined>;

	acquireLease(): Promise<string>;
	renewLease(leaseId: string): Promise<void>;
	releaseLease(leaseId: string): Promise<void>;
}

/** How often a live consumer renews its lease. */
export const MEDIA_LEASE_RENEW_INTERVAL_MS = 5_000;

/** A lease not renewed within this window is dropped by the main process. */
export const MEDIA_LEASE_EXPIRY_MS = 15_000;

/** Player polling interval while leased. */
export const MEDIA_POLL_INTERVAL_MS = 2_000;
