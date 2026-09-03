/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, IPromptChoice, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { asJson, IRequestService, NO_FETCH_TELEMETRY } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IPrimalUpdateService, PRIMAL_UPDATE_DEFAULT_MODE, PRIMAL_UPDATE_MANIFEST_URL, PRIMAL_UPDATE_MODE_SETTING_ID, PRIMAL_UPDATE_REQUEST_TIMEOUT_MS, PRIMAL_UPDATE_SKIPPED_COMMIT_STORAGE_KEY, PrimalUpdateMode, PrimalUpdateTrigger } from './primalUpdate.js';
import { IPrimalUpdateManifest, parsePrimalUpdateManifest } from './primalUpdateManifest.js';
import { getPrimalDownloadPlatformKey } from './primalUpdatePlatform.js';

/**
 * Checks a static JSON manifest for a build newer than this one and, if there is
 * one, says so once.
 *
 * Three rules shape everything below:
 *
 * - **Commit is the identity.** The same version number is rebuilt repeatedly,
 *   so `IProductService.commit` is the only thing that tells two builds apart.
 *   A build without one is a development build and is left alone entirely.
 * - **The background check is silent.** Offline, a 404, a timeout, a truncated
 *   body, a manifest that fails validation -- all of it logs at trace and stops.
 *   No dialog, no error toast, no retry: the next attempt is the ordinary
 *   8-hour one. Only the explicit command reports failures.
 * - **Nothing about the user is sent.** One GET, no query string, no headers of
 *   ours, and `NO_FETCH_TELEMETRY` so the request itself is not reported either.
 */
export class PrimalUpdateService extends Disposable implements IPrimalUpdateService {

	declare readonly _serviceBrand: undefined;

	/** Cancels an in-flight manifest request when the window goes away. */
	private readonly requestCancellation = this._register(new MutableDisposable<CancellationTokenSource>());

	/** Guards against the timer firing on top of a check already running. */
	private checkInFlight = false;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IProductService private readonly productService: IProductService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	get isEnabled(): boolean {
		return this.mode !== 'off';
	}

	/** Read on every use so turning the setting off takes effect immediately. */
	private get mode(): PrimalUpdateMode {
		// Anything other than an explicit 'off' -- including a user who typed
		// nonsense into settings.json -- falls back to the default.
		const value = this.configurationService.getValue<string | undefined>(PRIMAL_UPDATE_MODE_SETTING_ID);
		return value === 'off' ? 'off' : PRIMAL_UPDATE_DEFAULT_MODE;
	}

	private get skippedCommit(): string | undefined {
		return this.storageService.get(PRIMAL_UPDATE_SKIPPED_COMMIT_STORAGE_KEY, StorageScope.APPLICATION);
	}

	async checkForUpdates(trigger: PrimalUpdateTrigger): Promise<void> {
		const explicit = trigger === PrimalUpdateTrigger.Explicit;

		if (!this.isEnabled) {
			this.logService.trace(`[primalUpdate] '${PRIMAL_UPDATE_MODE_SETTING_ID}' is 'off', not checking`);
			if (explicit) {
				this.notificationService.info(localize('primalUpdate.disabled', "Update checks are turned off. Set \"{0}\" to \"notify\" to turn them back on.", PRIMAL_UPDATE_MODE_SETTING_ID));
			}
			return;
		}

		const currentCommit = this.productService.commit;
		if (!currentCommit) {
			// Development build: there is no commit to compare a manifest against,
			// so there is nothing worth asking the network about.
			this.logService.trace('[primalUpdate] no product commit (development build), not checking');
			if (explicit) {
				this.notificationService.info(localize('primalUpdate.developmentBuild', "Update checks are not available in a development build."));
			}
			return;
		}

		if (this.checkInFlight && !explicit) {
			this.logService.trace('[primalUpdate] a check is already running, skipping this background one');
			return;
		}

		this.checkInFlight = true;
		try {
			const manifest = await this.fetchManifest();
			if (!manifest) {
				if (explicit) {
					this.notificationService.info(localize('primalUpdate.checkFailed', "Could not check for updates right now. Please check your internet connection and try again."));
				}
				return;
			}

			if (manifest.commit === currentCommit) {
				this.logService.trace('[primalUpdate] already on the latest build');
				if (explicit) {
					this.notificationService.info(localize('primalUpdate.upToDate', "Primal Code is up to date."));
				}
				return;
			}

			// "Skip This Build" silences the nagging, not an answer the user asked
			// for: an explicit check still reports the build it found.
			if (!explicit && manifest.commit === this.skippedCommit) {
				this.logService.trace(`[primalUpdate] build '${manifest.commit}' was skipped by the user`);
				return;
			}

			this.showUpdateAvailable(manifest);
		} finally {
			this.checkInFlight = false;
		}
	}

	/**
	 * One GET, bounded by {@link PRIMAL_UPDATE_REQUEST_TIMEOUT_MS}. Every failure
	 * mode -- offline, non-200, timeout, unparseable body, a manifest that fails
	 * validation -- collapses to `undefined` and a trace line.
	 */
	private async fetchManifest(): Promise<IPrimalUpdateManifest | undefined> {
		const cancellation = new CancellationTokenSource();
		this.requestCancellation.value = cancellation;

		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: PRIMAL_UPDATE_MANIFEST_URL,
				timeout: PRIMAL_UPDATE_REQUEST_TIMEOUT_MS,
				disableCache: true,
				// No headers, no query string, no body: the request says nothing
				// about who is asking. NO_FETCH_TELEMETRY keeps the request itself
				// out of telemetry as well.
				callSite: NO_FETCH_TELEMETRY
			}, cancellation.token);

			if (context.res.statusCode !== 200) {
				this.logService.trace(`[primalUpdate] manifest request returned ${context.res.statusCode}`);
				return undefined;
			}

			const manifest = parsePrimalUpdateManifest(await asJson<unknown>(context));
			if (!manifest) {
				this.logService.trace('[primalUpdate] manifest failed validation, ignoring it');
				return undefined;
			}

			return manifest;
		} catch (error) {
			this.logService.trace('[primalUpdate] manifest request failed', error);
			return undefined;
		} finally {
			if (this.requestCancellation.value === cancellation) {
				this.requestCancellation.clear();
			}
		}
	}

	private showUpdateAvailable(manifest: IPrimalUpdateManifest): void {
		const choices: IPromptChoice[] = [];

		// No entry for this platform means we have nothing correct to offer, so
		// the button is left out rather than pointed at another platform's build.
		const platformKey = getPrimalDownloadPlatformKey();
		const download = platformKey ? manifest.downloads.get(platformKey) : undefined;
		if (download) {
			choices.push({
				label: localize('primalUpdate.download', "Download"),
				run: () => this.openExternal(download)
			});
		} else {
			this.logService.trace(`[primalUpdate] manifest has no download for '${platformKey ?? 'unknown platform'}'`);
		}

		if (manifest.notesUrl) {
			const notesUrl = manifest.notesUrl;
			choices.push({
				label: localize('primalUpdate.releaseNotes', "Release Notes"),
				run: () => this.openExternal(notesUrl)
			});
		}

		choices.push({
			label: localize('primalUpdate.skip', "Skip This Build"),
			run: () => this.skipBuild(manifest.commit)
		});

		const message = manifest.name
			? localize('primalUpdate.availableNamed', "Primal Code {0} is available — {1}", manifest.version, manifest.name)
			: localize('primalUpdate.available', "Primal Code {0} is available.", manifest.version);

		this.notificationService.prompt(Severity.Info, message, choices, {
			priority: NotificationPriority.OPTIONAL,
			sticky: true
		});
	}

	private skipBuild(commit: string): void {
		this.storageService.store(PRIMAL_UPDATE_SKIPPED_COMMIT_STORAGE_KEY, commit, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.logService.trace(`[primalUpdate] skipping build '${commit}'`);
	}

	/**
	 * `uri` has already been proven to be an `https:` URI by
	 * {@link parsePrimalUpdateManifest}; nothing unvalidated reaches the opener.
	 */
	private openExternal(uri: URI): void {
		this.openerService.open(uri, { openExternal: true }).then(undefined, error => {
			this.logService.warn('[primalUpdate] failed to open the update link', error);
			this.notificationService.error(localize('primalUpdate.openFailed', "Could not open {0}.", uri.toString(true)));
		});
	}

	override dispose(): void {
		// Abort a request that is still in the air; MutableDisposable would only
		// dispose the source, which does not cancel by default.
		this.requestCancellation.value?.cancel();
		super.dispose();
	}
}
