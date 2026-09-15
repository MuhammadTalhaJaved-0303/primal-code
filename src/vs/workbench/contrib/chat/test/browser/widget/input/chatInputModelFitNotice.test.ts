/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../../../base/common/event.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../../base/common/observable.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ICommandEvent, ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { ExtensionIdentifier } from '../../../../../../../platform/extensions/common/extensions.js';
import { SyncDescriptor } from '../../../../../../../platform/instantiation/common/descriptors.js';
import { getSingletonServiceDescriptors } from '../../../../../../../platform/instantiation/common/extensions.js';
import { ServiceCollection } from '../../../../../../../platform/instantiation/common/serviceCollection.js';
import { ITelemetryService } from '../../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../../../platform/telemetry/common/telemetryUtils.js';
import { workbenchInstantiationService } from '../../../../../../test/browser/workbenchTestServices.js';
import { ChatInputModelFitNotice, IChatInputModelFitNoticeScope, ReloadSessionModelsCommandId } from '../../../../browser/widget/input/chatInputModelFitNotice.js';
import { ModelSessionFitKind } from '../../../../browser/widget/input/chatInputModelSessionFit.js';
import { IChatInputNotificationService } from '../../../../browser/widget/input/chatInputNotificationService.js';
import { ChatInputNotificationWidget } from '../../../../browser/widget/input/chatInputNotificationWidget.js';
import { SessionType } from '../../../../common/chatSessionsService.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier } from '../../../../common/languageModels.js';

class TestCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;
	readonly onWillExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly onDidExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly executed: { readonly id: string; readonly args: readonly unknown[] }[] = [];
	async executeCommand(id: string, ...args: unknown[]): Promise<undefined> {
		this.executed.push({ id, args });
		return undefined;
	}
}

function createModel(identifier: string, name: string, overrides?: Partial<ILanguageModelChatMetadata>): ILanguageModelChatMetadataAndIdentifier {
	const metadata: ILanguageModelChatMetadata = {
		extension: new ExtensionIdentifier('test.ext'),
		id: identifier,
		name,
		vendor: 'test',
		version: '1.0',
		family: identifier,
		maxInputTokens: 1,
		maxOutputTokens: 1,
		isDefaultForLocation: {},
		...overrides,
	};
	return { identifier, metadata };
}

const claudeOpus = createModel('agent-host-claude:claude-opus-4', 'Claude Opus 4', { targetChatSessionType: SessionType.AgentHostClaude });
const byokSonnet = createModel('anthropic/claude-sonnet-4', 'Claude Sonnet 4', { isBYOK: true });
const codexGpt = createModel('agent-host-codex:gpt-5', 'GPT-5', { targetChatSessionType: SessionType.AgentHostCodex });

suite('ChatInputModelFitNotice', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const sessionResource = URI.parse('vscode-chat-session://agent-host-codex/session-1');
	const scope: IChatInputModelFitNoticeScope = { sessionResource, sessionType: SessionType.AgentHostCodex, newSessionPosition: 'sidebar' };

	function setup() {
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IChatInputNotificationService)?.[1];
		assert.ok(descriptor);
		const commandService = new TestCommandService();
		const instantiationService = store.add(workbenchInstantiationService(undefined, store));
		instantiationService.stub(ICommandService, commandService);
		instantiationService.stub(ITelemetryService, NullTelemetryService);
		const childInstantiationService = store.add(instantiationService.createChild(new ServiceCollection(
			[IChatInputNotificationService, new SyncDescriptor(descriptor.ctor, descriptor.staticArguments)]
		)));
		const notificationService = childInstantiationService.get(IChatInputNotificationService);
		store.add(notificationService as IChatInputNotificationService & IDisposable);

		let modelPickerOpened = 0;
		const widget = store.add(childInstantiationService.createInstance(ChatInputNotificationWidget, {
			modelTargetChatSessionType: observableValue<string | undefined>('sessionType', SessionType.AgentHostCodex),
			sessionResource: observableValue<URI | undefined>('sessionResource', sessionResource),
			openModelPicker: () => { modelPickerOpened++; },
		}));
		const notice = store.add(childInstantiationService.createInstance(ChatInputModelFitNotice));
		const rendered = () => ({
			title: widget.domNode.querySelector('.chat-input-notification-title')?.textContent ?? undefined,
			description: widget.domNode.querySelector('.chat-input-notification-description')?.textContent ?? undefined,
			actions: [...widget.domNode.querySelectorAll('.chat-input-notification-action-button')].map(button => button.textContent),
		});
		const clickAction = (label: string) => {
			const button = [...widget.domNode.querySelectorAll('.chat-input-notification-action-button')].find(candidate => candidate.textContent === label);
			assert.ok(button, `expected an action labelled '${label}'`);
			(button as HTMLElement).click();
		};
		return { commandService, notice, rendered, clickAction, modelPickerOpened: () => modelPickerOpened };
	}

	test('a model that runs in another session is explained in words, with a one-click switch', () => {
		const { commandService, notice, rendered, clickAction } = setup();

		notice.update({ kind: ModelSessionFitKind.SwitchSession, rejectedModel: claudeOpus, targetSessionType: SessionType.AgentHostClaude }, scope);

		assert.deepStrictEqual(rendered(), {
			title: 'Claude Opus 4 runs in a Claude session, not this Codex session.',
			description: 'Switch to a Claude session to use it, or choose a model this session can run.',
			actions: ['Choose another model', 'Switch to Claude session'],
		});

		clickAction('Switch to Claude session');
		assert.deepStrictEqual(commandService.executed, [{ id: `workbench.action.chat.openNewChatSessionInPlace.${SessionType.AgentHostClaude}`, args: ['sidebar'] }]);
	});

	test('the packaged-build case is worded: no session model loaded yet, with a retry', () => {
		const { commandService, notice, rendered, clickAction, modelPickerOpened } = setup();

		notice.update({ kind: ModelSessionFitKind.AwaitingSessionModels, rejectedModel: byokSonnet }, scope);

		assert.deepStrictEqual(rendered(), {
			title: 'No Codex model has loaded yet, so this session can\'t send.',
			description: 'Claude Sonnet 4 can\'t answer here. Sending is blocked until a Codex model is available.',
			actions: ['Choose model', 'Retry loading models'],
		});

		clickAction('Retry loading models');
		assert.deepStrictEqual(commandService.executed, [{ id: ReloadSessionModelsCommandId, args: [sessionResource] }]);
		assert.strictEqual(modelPickerOpened(), 0);
	});

	test('a fallback to the session default is stated and stays until the user acts', () => {
		const { notice, rendered } = setup();

		notice.update({ kind: ModelSessionFitKind.UseSessionDefault, rejectedModel: claudeOpus, defaultModel: codexGpt, runsInSessionType: SessionType.AgentHostClaude }, scope);
		assert.deepStrictEqual(rendered(), {
			title: 'Claude Opus 4 can\'t answer in this Codex session.',
			description: 'GPT-5 will answer instead.',
			actions: ['Choose model', 'Switch to Claude session'],
		});

		// The fallback has been applied, so the next check reports a fit; the explanation must not
		// vanish before the user has seen it.
		notice.update({ kind: ModelSessionFitKind.Fits }, scope);
		assert.strictEqual(rendered().title, 'Claude Opus 4 can\'t answer in this Codex session.');

		notice.clear();
		assert.deepStrictEqual(rendered(), { title: undefined, description: undefined, actions: [] });
	});

	test('a fit clears any other notice, and the notice follows the session it was raised for', () => {
		const { notice, rendered } = setup();

		notice.update({ kind: ModelSessionFitKind.NoModelAvailable, rejectedModel: undefined }, scope);
		assert.deepStrictEqual(rendered(), {
			title: 'No model can answer in this Codex session.',
			description: 'Add a model in Settings, or switch to another session.',
			actions: ['Choose model', 'Open Settings'],
		});

		notice.update({ kind: ModelSessionFitKind.Fits }, scope);
		assert.deepStrictEqual(rendered(), { title: undefined, description: undefined, actions: [] });

		// Raised for another session: this input's widget must not show it.
		const otherScope: IChatInputModelFitNoticeScope = { ...scope, sessionResource: URI.parse('vscode-chat-session://agent-host-codex/session-2') };
		notice.update({ kind: ModelSessionFitKind.NoModelAvailable, rejectedModel: undefined }, otherScope);
		assert.deepStrictEqual(rendered(), { title: undefined, description: undefined, actions: [] });
	});
});
