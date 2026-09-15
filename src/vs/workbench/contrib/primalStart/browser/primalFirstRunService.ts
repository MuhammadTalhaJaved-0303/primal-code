/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TimeoutTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { PRIMAL_HARNESS_PROVIDER_SETTING_ID } from '../../../../platform/agentHost/common/primalProviders.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { SessionType } from '../../chat/common/chatSessionsService.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IPrimalVibeService } from '../../primalVibes/browser/primalVibes.js';
import { IFirstRunState, INITIAL_FIRST_RUN_STATE, parseFirstRunState, PRIMAL_FIRST_RUN_STORAGE_KEY, serializeFirstRunState, withFirstRunState } from '../common/primalFirstRunState.js';
import { computeFirstRunGuide, IFirstRunGuide } from '../common/primalFirstRunSteps.js';
import { detectConfiguredProviderIds, hasClaudeAgentModels, inferClaudeLogin, isProviderSecretKey } from './primalFirstRunDetection.js';

export const IPrimalFirstRunService = createDecorator<IPrimalFirstRunService>('primalFirstRunService');

/**
 * Tracks the three first-run steps for the whole application and detects,
 * live, whether a model is connected. One instance per window; progress is
 * shared through APPLICATION-scope storage, so a folder opened in a second
 * window ticks the "Start" step on the first window's Start page too.
 */
export interface IPrimalFirstRunService {
	readonly _serviceBrand: undefined;

	/** Fires whenever {@link guide} or {@link isGuideVisible} may have changed. */
	readonly onDidChange: Event<void>;

	/** The steps as they stand right now: stored progress plus live detection. */
	readonly guide: IFirstRunGuide;

	/** True until the guide has been completed once, and again after {@link reset}. */
	readonly isGuideVisible: boolean;

	/** Records that the user looked at the vibes and kept the one they have. */
	keepCurrentVibe(): void;

	/**
	 * Whether the one-line "You're set" is owed. True at most once per
	 * completion: the call records that the line was shown.
	 */
	takeCompletionNotice(): boolean;

	/** Forgets all progress so the guide shows again. Detection is unaffected. */
	reset(): void;

	/** Re-reads secrets and the model catalogue. Resolves when the guide reflects them. */
	refreshDetection(): Promise<void>;
}

/** What detection last found. Held as one immutable record so a stale pass can be discarded whole. */
interface IModelDetection {
	/** The Claude coding agent has published models: the agent host has connected and answered. */
	readonly claudeModelsPresent: boolean;
	readonly claudeLoginDetected: boolean;
	readonly configuredProviderIds: readonly string[];
}

const NOTHING_DETECTED: IModelDetection = Object.freeze({ claudeModelsPresent: false, claudeLoginDetected: false, configuredProviderIds: [] });

/**
 * How long the first look waits for the agent host to publish Claude models
 * before the model step stops saying it is looking. On a dev build the host
 * was seen to publish 30-50 seconds after launch; a host that is downloading
 * its SDK or failing to start must not hold the guide on "looking" for ever.
 * While looking, adding a provider is offered all the same.
 */
export const FIRST_LOOK_TIMEOUT_MS = 60_000;

export class PrimalFirstRunService extends Disposable implements IPrimalFirstRunService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private state: IFirstRunState;
	private detection: IModelDetection = NOTHING_DETECTED;

	/** The first look is over: the agent host answered the model pull, or the wait for it is up. */
	private detectionSettled = false;
	private readonly firstLookTimer = this._register(new TimeoutTimer());

	/** The newest detection pass wins; older passes that finish later are dropped. */
	private detectionSequence = 0;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IChatService private readonly chatService: IChatService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.state = this.readState();

		this.registerProgressListeners();
		this.registerDetectionListeners();

		this.noteWorkspaceState();
		this.pullClaudeModels();
		this.refreshDetection().catch(error => this.logService.error('[PrimalFirstRun] Initial detection failed', error));
	}

	get guide(): IFirstRunGuide {
		return computeFirstRunGuide({
			vibeChosen: this.state.vibeChosen,
			started: this.state.started,
			claudeLoginDetected: this.detection.claudeLoginDetected,
			configuredProviderIds: this.detection.configuredProviderIds,
			detectionSettled: this.detectionSettled,
		});
	}

	get isGuideVisible(): boolean {
		return !this.state.complete;
	}

	keepCurrentVibe(): void {
		this.commit(withFirstRunState(this.state, { vibeChosen: true }));
	}

	takeCompletionNotice(): boolean {
		if (!this.state.complete || this.state.completeNoticeShown) {
			return false;
		}
		// A quiet write: nothing the reader sees changes, and a change event here
		// would make the strip re-render and tear down the very line it just put up.
		this.persist(withFirstRunState(this.state, { completeNoticeShown: true }));
		return true;
	}

	reset(): void {
		this.commit(INITIAL_FIRST_RUN_STATE);
		// Progress is forgotten, reality is not: a window with a folder open has started.
		this.noteWorkspaceState();
	}

	//#region Progress

	private registerProgressListeners(): void {
		this._register(this.vibeService.onDidChangeVibe(() => this.commit(withFirstRunState(this.state, { vibeChosen: true }))));
		this._register(this.chatService.onDidSubmitRequest(() => this.commit(withFirstRunState(this.state, { started: true }))));
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.noteWorkspaceState()));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PRIMAL_FIRST_RUN_STORAGE_KEY, this._store)(() => this.adoptStoredState()));
	}

	/** A window with a folder or workspace open has, by definition, started. */
	private noteWorkspaceState(): void {
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			this.commit(withFirstRunState(this.state, { started: true }));
		}
	}

	private readState(): IFirstRunState {
		return parseFirstRunState(this.storageService.get(PRIMAL_FIRST_RUN_STORAGE_KEY, StorageScope.APPLICATION));
	}

	/** Another window (or this one, via storage) wrote progress; take it over if it differs. */
	private adoptStoredState(): void {
		const stored = this.readState();
		if (serializeFirstRunState(stored) === serializeFirstRunState(this.state)) {
			return;
		}
		this.state = stored;
		this.afterChange();
	}

	/** Writes a new state when it differs from the current one. True when something was written. */
	private persist(next: IFirstRunState): boolean {
		if (this._store.isDisposed) {
			return false;
		}
		const serialized = serializeFirstRunState(next);
		if (serialized === serializeFirstRunState(this.state)) {
			return false;
		}
		this.state = next;
		this.storageService.store(PRIMAL_FIRST_RUN_STORAGE_KEY, serialized, StorageScope.APPLICATION, StorageTarget.MACHINE);
		return true;
	}

	/** Persists a new state when it differs from the current one, then re-evaluates. */
	private commit(next: IFirstRunState): void {
		if (this.persist(next)) {
			this.afterChange();
		}
	}

	/** Records completion the first time all three steps are seen done, then tells listeners. */
	private afterChange(): void {
		if (!this.state.complete && this.guide.complete) {
			this.commit(withFirstRunState(this.state, { complete: true }));
			return; // the nested commit fired the event
		}
		this._onDidChange.fire();
	}

	//#endregion

	//#region Detection

	private registerDetectionListeners(): void {
		this._register(this.secretStorageService.onDidChangeSecret(key => {
			if (isProviderSecretKey(key)) {
				this.refreshDetection().catch(error => this.logService.error('[PrimalFirstRun] Detection after a secret change failed', error));
			}
		}));
		this._register(this.languageModelsService.onDidChangeLanguageModels(() => {
			this.refreshDetection().catch(error => this.logService.error('[PrimalFirstRun] Detection after a model change failed', error));
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PRIMAL_HARNESS_PROVIDER_SETTING_ID)) {
				this.refreshDetection().catch(error => this.logService.error('[PrimalFirstRun] Detection after a provider change failed', error));
			}
		}));
	}

	/**
	 * Wakes the Claude agent's model catalogue, the way the chat input does
	 * when it targets that agent. Until the host has published models - or
	 * the wait for it is up - the guide reports the look as still under way
	 * rather than claiming nothing is there. An answer with no models does NOT
	 * end the look: the pull resolves at once while the host's provider is not
	 * registered yet, which is the normal state in the first seconds after
	 * launch. A rejected pull is a host that answered with a failure and does
	 * end it; the catalogue change event re-runs detection whenever models do
	 * arrive later.
	 */
	private pullClaudeModels(): void {
		this.firstLookTimer.setIfNotSet(() => this.settleFirstLook(), FIRST_LOOK_TIMEOUT_MS);
		this.languageModelsService.selectLanguageModels({ vendor: SessionType.AgentHostClaude }).then(
			identifiers => {
				if (identifiers.length > 0) {
					this.settleFirstLook();
				}
			},
			error => {
				this.logService.trace('[PrimalFirstRun] Claude model pull did not complete', error);
				this.settleFirstLook();
			});
	}

	/** Ends the first look once. True when it was still open. */
	private endFirstLook(): boolean {
		if (this.detectionSettled || this._store.isDisposed) {
			return false;
		}
		this.detectionSettled = true;
		this.firstLookTimer.cancel();
		return true;
	}

	/** Ends the first look and publishes that together with a fresh read of the world. */
	private settleFirstLook(): void {
		if (this.endFirstLook()) {
			this.refreshDetection().catch(error => this.logService.error('[PrimalFirstRun] Detection after the first look failed', error));
		}
	}

	refreshDetection(): Promise<void> {
		const sequence = ++this.detectionSequence;
		return this.detect().then(found => {
			if (sequence !== this.detectionSequence || this._store.isDisposed) {
				return; // superseded, or gone
			}
			this.detection = found;
			if (found.claudeModelsPresent) {
				this.endFirstLook(); // the host has answered: nothing left to wait for
			}
			this.afterChange();
		});
	}

	private async detect(): Promise<IModelDetection> {
		const configuredProviderIds = await detectConfiguredProviderIds(this.secretStorageService);
		const claudeModelsPresent = hasClaudeAgentModels(this.languageModelsService);
		const claudeLoginDetected = inferClaudeLogin(claudeModelsPresent, configuredProviderIds);
		return { claudeModelsPresent, claudeLoginDetected, configuredProviderIds };
	}

	//#endregion
}
