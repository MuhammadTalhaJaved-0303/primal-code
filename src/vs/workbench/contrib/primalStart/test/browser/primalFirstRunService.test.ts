/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, providerSecretKey } from '../../../../../platform/agentHost/common/primalProviders.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IChatRequestSubmittedEvent, IChatService } from '../../../chat/common/chatService/chatService.js';
import { SessionType } from '../../../chat/common/chatSessionsService.js';
import { ILanguageModelChatMetadata, ILanguageModelChatSelector, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IPrimalVibe, IPrimalVibeService, PRIMAL_VIBES } from '../../../primalVibes/browser/primalVibes.js';
import { FIRST_LOOK_TIMEOUT_MS, PrimalFirstRunService } from '../../browser/primalFirstRunService.js';
import { PRIMAL_FIRST_RUN_STORAGE_KEY, parseFirstRunState } from '../../common/primalFirstRunState.js';
import { FirstRunStepId, FirstRunStepStatus } from '../../common/primalFirstRunSteps.js';

class TestVibeService implements Partial<IPrimalVibeService> {
	private readonly _onDidChangeVibe = new Emitter<IPrimalVibe | undefined>();
	readonly onDidChangeVibe = this._onDidChangeVibe.event;
	currentVibe: IPrimalVibe | undefined = PRIMAL_VIBES[1];

	changeVibe(vibe: IPrimalVibe | undefined): void {
		this.currentVibe = vibe;
		this._onDidChangeVibe.fire(vibe);
	}

	dispose(): void {
		this._onDidChangeVibe.dispose();
	}
}

class TestLanguageModelsService implements Partial<ILanguageModelsService> {
	private readonly _onDidChangeLanguageModels = new Emitter<string>();
	readonly onDidChangeLanguageModels = this._onDidChangeLanguageModels.event;
	private models = new Map<string, ILanguageModelChatMetadata>();
	readonly selections: ILanguageModelChatSelector[] = [];
	/** The agent host answering the Claude model pull; the test decides when. */
	private readonly pull = new DeferredPromise<string[]>();

	publish(identifier: string, vendor: string): void {
		this.models = new Map([...this.models, [identifier, { id: identifier, vendor, name: identifier } as unknown as ILanguageModelChatMetadata]]);
		this._onDidChangeLanguageModels.fire(vendor);
	}

	getLanguageModelIds(): string[] {
		return [...this.models.keys()];
	}

	lookupLanguageModel(identifier: string): ILanguageModelChatMetadata | undefined {
		return this.models.get(identifier);
	}

	selectLanguageModels(selector: ILanguageModelChatSelector): Promise<string[]> {
		this.selections.push(selector);
		return this.pull.p;
	}

	settlePull(): void {
		if (!this.pull.isSettled) {
			this.pull.complete([]);
		}
	}

	failPull(): void {
		if (!this.pull.isSettled) {
			this.pull.error(new Error('agent host not running'));
		}
	}

	dispose(): void {
		this._onDidChangeLanguageModels.dispose();
	}
}

class TestChatService implements Partial<IChatService> {
	private readonly _onDidSubmitRequest = new Emitter<IChatRequestSubmittedEvent>();
	readonly onDidSubmitRequest = this._onDidSubmitRequest.event;

	submit(): void {
		this._onDidSubmitRequest.fire({ chatSessionResource: URI.parse('test:session') });
	}

	dispose(): void {
		this._onDidSubmitRequest.dispose();
	}
}

/** The two members the service reads; the real service fires the event when folders change. */
class TestWorkspaceContext implements Partial<IWorkspaceContextService> {
	private readonly _onDidChangeWorkbenchState = new Emitter<WorkbenchState>();
	readonly onDidChangeWorkbenchState = this._onDidChangeWorkbenchState.event;

	constructor(private state: WorkbenchState) { }

	getWorkbenchState(): WorkbenchState {
		return this.state;
	}

	open(state: WorkbenchState): void {
		this.state = state;
		this._onDidChangeWorkbenchState.fire(state);
	}

	dispose(): void {
		this._onDidChangeWorkbenchState.dispose();
	}
}

suite('PrimalFirstRunService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let storage: TestStorageService;
	let secrets: TestSecretStorageService;
	let vibes: TestVibeService;
	let languageModels: TestLanguageModelsService;
	let chat: TestChatService;
	let context: TestWorkspaceContext;
	let configuration: TestConfigurationService;

	setup(() => {
		storage = disposables.add(new TestStorageService());
		secrets = disposables.add(new TestSecretStorageService());
		vibes = disposables.add(new TestVibeService());
		languageModels = disposables.add(new TestLanguageModelsService());
		chat = disposables.add(new TestChatService());
		context = disposables.add(new TestWorkspaceContext(WorkbenchState.EMPTY));
		configuration = new TestConfigurationService();
	});

	function constructService(): PrimalFirstRunService {
		return disposables.add(new PrimalFirstRunService(
			storage,
			secrets,
			vibes as unknown as IPrimalVibeService,
			languageModels as unknown as ILanguageModelsService,
			chat as unknown as IChatService,
			context as unknown as IWorkspaceContextService,
			configuration,
			new NullLogService(),
		));
	}

	/** A service whose first look at the world is over: the fixture's agent host is not running, so the model pull fails at once. */
	async function createService(): Promise<PrimalFirstRunService> {
		const service = constructService();
		languageModels.failPull();
		await service.refreshDetection();
		await timeout(0);
		return service;
	}

	function stored() {
		return parseFirstRunState(storage.get(PRIMAL_FIRST_RUN_STORAGE_KEY, StorageScope.APPLICATION));
	}

	function status(service: PrimalFirstRunService, id: FirstRunStepId): FirstRunStepStatus | undefined {
		return service.guide.steps.find(step => step.id === id)?.status;
	}

	function countChanges(service: PrimalFirstRunService): { readonly count: number } {
		const counter = { count: 0 };
		disposables.add(service.onDidChange(() => counter.count++));
		return counter;
	}

	test('a fresh install: vibe is current, nothing detected, guide visible', async () => {
		const service = await createService();
		assert.strictEqual(status(service, FirstRunStepId.Vibe), FirstRunStepStatus.Current);
		assert.deepStrictEqual(service.guide.modelSource, { kind: 'none' });
		assert.strictEqual(service.guide.complete, false);
		assert.strictEqual(service.isGuideVisible, true);
		assert.strictEqual(service.takeCompletionNotice(), false);
	});

	test('construction pulls the Claude agent models so the catalogue can be read', async () => {
		await createService();
		assert.ok(languageModels.selections.some(selector => selector.vendor === SessionType.AgentHostClaude));
	});

	test('changing the vibe marks the vibe step done and persists it', async () => {
		const service = await createService();
		const changes = countChanges(service);
		vibes.changeVibe(PRIMAL_VIBES[2]);
		assert.strictEqual(status(service, FirstRunStepId.Vibe), FirstRunStepStatus.Done);
		assert.strictEqual(stored().vibeChosen, true);
		assert.ok(changes.count >= 1);
	});

	test('keeping the current vibe counts as choosing it', async () => {
		const service = await createService();
		service.keepCurrentVibe();
		assert.strictEqual(status(service, FirstRunStepId.Vibe), FirstRunStepStatus.Done);
		assert.strictEqual(stored().vibeChosen, true);
	});

	test('submitting a chat request marks the start step done', async () => {
		const service = await createService();
		chat.submit();
		assert.strictEqual(status(service, FirstRunStepId.Start), FirstRunStepStatus.Done);
		assert.strictEqual(stored().started, true);
	});

	test('a window with a folder open marks the start step done at once', async () => {
		context = disposables.add(new TestWorkspaceContext(WorkbenchState.FOLDER));
		const service = await createService();
		assert.strictEqual(status(service, FirstRunStepId.Start), FirstRunStepStatus.Done);
		assert.strictEqual(stored().started, true);
	});

	test('an empty window that later opens a folder marks the start step done', async () => {
		const service = await createService();
		assert.strictEqual(status(service, FirstRunStepId.Start), FirstRunStepStatus.Next);
		context.open(WorkbenchState.FOLDER);
		assert.strictEqual(status(service, FirstRunStepId.Start), FirstRunStepStatus.Done);
	});

	suite('model detection', () => {

		test('a stored provider key is reported by provider id', async () => {
			await secrets.set(providerSecretKey('openai'), 'sk-test');
			const service = await createService();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'keys', providerIds: ['openai'], claudeLogin: false });
			assert.strictEqual(status(service, FirstRunStepId.Model), FirstRunStepStatus.Done);
		});

		test('the legacy Anthropic key counts as the anthropic provider', async () => {
			await secrets.set(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, 'sk-ant-old');
			const service = await createService();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'keys', providerIds: ['anthropic'], claudeLogin: false });
		});

		test('keys in registry order, each provider once, blanks ignored', async () => {
			await secrets.set(providerSecretKey('deepseek'), 'sk-d');
			await secrets.set(providerSecretKey('anthropic'), 'sk-ant-a');
			await secrets.set(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, 'sk-ant-old');
			await secrets.set(providerSecretKey('openai'), '   ');
			const service = await createService();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'keys', providerIds: ['anthropic', 'deepseek'], claudeLogin: false });
		});

		test('a key saved or removed later is picked up without a restart', async () => {
			const service = await createService();
			const changes = countChanges(service);
			await secrets.set(providerSecretKey('google'), 'g-key');
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'keys', providerIds: ['google'], claudeLogin: false });
			await secrets.delete(providerSecretKey('google'));
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'none' });
			assert.ok(changes.count >= 2);
		});

		test('an unrelated secret changing does not count as a key', async () => {
			const service = await createService();
			await secrets.set('someOtherExtension.token', 'x');
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'none' });
		});

		test('Claude agent models with no harness key means an existing Claude login', async () => {
			const service = await createService();
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'claudeLogin' });
			assert.strictEqual(status(service, FirstRunStepId.Model), FirstRunStepStatus.Done);
		});

		test('Claude agent models with an Anthropic key are attributed to the key, not a login', async () => {
			await secrets.set(providerSecretKey('anthropic'), 'sk-ant-a');
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			const service = await createService();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'keys', providerIds: ['anthropic'], claudeLogin: false });
		});

		test('Claude agent models alongside a key that cannot drive the Claude harness means a login plus that key', async () => {
			await secrets.set(providerSecretKey('openai'), 'sk-o');
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			const service = await createService();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'keys', providerIds: ['openai'], claudeLogin: true });
		});

		test('models from other vendors are not a Claude login', async () => {
			const service = await createService();
			languageModels.publish('gpt-5', SessionType.AgentHostCodex);
			languageModels.publish('gemini', 'primal');
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'none' });
		});
	});

	suite('first look', () => {

		test('until the agent host has answered, the model step reads as checking', async () => {
			const service = constructService();
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'checking' });
			assert.strictEqual(status(service, FirstRunStepId.Model), FirstRunStepStatus.Next);
		});

		test('a pull answered with no models keeps the first look open: the host may not have connected yet', async () => {
			const service = constructService();
			await service.refreshDetection();
			languageModels.settlePull();
			await timeout(0);
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'checking' });
		});

		test('Claude models arriving end the first look with the login found', async () => {
			const service = constructService();
			await service.refreshDetection();
			const changes = countChanges(service);
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'claudeLogin' });
			assert.ok(changes.count >= 1);
		});

		test('a pull the agent host fails also ends the first look', async () => {
			const service = constructService();
			await service.refreshDetection();
			languageModels.failPull();
			await timeout(0);
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'none' });
		});

		test('an agent host that never answers ends the first look after the settle timeout', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
			const service = constructService();
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'checking' });
			await timeout(FIRST_LOOK_TIMEOUT_MS);
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'none' });
		}));

		test('a key or a login found before the pull settles is reported at once', async () => {
			await secrets.set(providerSecretKey('openai'), 'sk-o');
			const service = constructService();
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'keys', providerIds: ['openai'], claudeLogin: false });
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			await secrets.delete(providerSecretKey('openai'));
			await service.refreshDetection();
			assert.deepStrictEqual(service.guide.modelSource, { kind: 'claudeLogin' });
		});
	});

	suite('completion', () => {

		test('once all three are done the guide is complete, persisted and hidden', async () => {
			const service = await createService();
			service.keepCurrentVibe();
			chat.submit();
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			await service.refreshDetection();
			assert.strictEqual(service.guide.complete, true);
			assert.strictEqual(service.isGuideVisible, false);
			assert.strictEqual(stored().complete, true);
		});

		test('the completion notice is owed exactly once', async () => {
			const service = await createService();
			service.keepCurrentVibe();
			chat.submit();
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			await service.refreshDetection();
			assert.strictEqual(service.takeCompletionNotice(), true);
			assert.strictEqual(service.takeCompletionNotice(), false);
			assert.strictEqual(stored().completeNoticeShown, true);
		});

		test('taking the completion notice is a quiet write: no change event, so the line is not torn down by its own render', async () => {
			const service = await createService();
			service.keepCurrentVibe();
			chat.submit();
			languageModels.publish('claude-sonnet', SessionType.AgentHostClaude);
			await service.refreshDetection();
			const changes = countChanges(service);
			assert.strictEqual(service.takeCompletionNotice(), true);
			assert.strictEqual(changes.count, 0);
		});

		test('a completed guide stays hidden when a key is removed later', async () => {
			await secrets.set(providerSecretKey('openai'), 'sk-o');
			const service = await createService();
			service.keepCurrentVibe();
			chat.submit();
			assert.strictEqual(service.isGuideVisible, false);
			await secrets.delete(providerSecretKey('openai'));
			await service.refreshDetection();
			assert.strictEqual(service.isGuideVisible, false);
		});

		test('completion survives a new service instance (a relaunch)', async () => {
			await secrets.set(providerSecretKey('openai'), 'sk-o');
			const first = await createService();
			first.keepCurrentVibe();
			chat.submit();
			first.takeCompletionNotice();
			const second = await createService();
			assert.strictEqual(second.isGuideVisible, false);
			assert.strictEqual(second.takeCompletionNotice(), false);
		});
	});

	test('reset clears every remembered step and shows the guide again', async () => {
		await secrets.set(providerSecretKey('openai'), 'sk-o');
		const service = await createService();
		service.keepCurrentVibe();
		chat.submit();
		service.takeCompletionNotice();
		const changes = countChanges(service);
		service.reset();
		assert.strictEqual(service.isGuideVisible, true);
		assert.strictEqual(status(service, FirstRunStepId.Vibe), FirstRunStepStatus.Current);
		assert.strictEqual(status(service, FirstRunStepId.Start), FirstRunStepStatus.Next);
		// Detection is live, so the key is still there after a reset.
		assert.strictEqual(status(service, FirstRunStepId.Model), FirstRunStepStatus.Done);
		assert.deepStrictEqual(stored(), { vibeChosen: false, started: false, complete: false, completeNoticeShown: false });
		assert.ok(changes.count >= 1);
	});

	test('reset in a window with a folder open keeps the start step done: the folder is still open', async () => {
		context = disposables.add(new TestWorkspaceContext(WorkbenchState.FOLDER));
		const service = await createService();
		service.keepCurrentVibe();
		service.reset();
		assert.strictEqual(status(service, FirstRunStepId.Vibe), FirstRunStepStatus.Current);
		assert.strictEqual(status(service, FirstRunStepId.Start), FirstRunStepStatus.Done);
		assert.strictEqual(stored().started, true);
		assert.strictEqual(stored().vibeChosen, false);
	});

	test('progress written by another window is picked up through storage', async () => {
		const service = await createService();
		const changes = countChanges(service);
		storage.store(PRIMAL_FIRST_RUN_STORAGE_KEY, JSON.stringify({ vibeChosen: false, started: true, complete: false, completeNoticeShown: false }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(status(service, FirstRunStepId.Start), FirstRunStepStatus.Done);
		assert.ok(changes.count >= 1);
	});

	test('a corrupt stored record reads as a fresh install rather than throwing', async () => {
		storage.store(PRIMAL_FIRST_RUN_STORAGE_KEY, '{not json', StorageScope.APPLICATION, StorageTarget.MACHINE);
		const service = await createService();
		assert.strictEqual(service.isGuideVisible, true);
		assert.strictEqual(status(service, FirstRunStepId.Vibe), FirstRunStepStatus.Current);
	});

	test('the service does not fire a change for a storage write that changed nothing', async () => {
		const service = await createService();
		service.keepCurrentVibe();
		const changes = countChanges(service);
		service.keepCurrentVibe();
		assert.strictEqual(changes.count, 0);
	});

	test('the vibe event is also honoured when the vibe becomes custom', async () => {
		const service = await createService();
		vibes.changeVibe(undefined);
		assert.strictEqual(status(service, FirstRunStepId.Vibe), FirstRunStepStatus.Done);
	});

	test('a disposed service stops listening', async () => {
		const service = await createService();
		const changes = countChanges(service);
		service.dispose();
		vibes.changeVibe(PRIMAL_VIBES[0]);
		chat.submit();
		assert.strictEqual(changes.count, 0);
		assert.strictEqual(stored().vibeChosen, false);
	});

	test('unrelated storage keys are ignored', async () => {
		const service = await createService();
		const changes = countChanges(service);
		storage.store('primalCode.somethingElse', 'x', StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(changes.count, 0);
		assert.strictEqual(service.isGuideVisible, true);
	});
});
