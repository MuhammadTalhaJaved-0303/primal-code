/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../../../platform/extensions/common/extensions.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier } from '../../../../common/languageModels.js';
import { SessionType } from '../../../../common/chatSessionsService.js';
import { ModelSessionFitKind, resolveModelSessionFit } from '../../../../browser/widget/input/chatInputModelSessionFit.js';

function createModel(identifier: string, id: string, name: string, overrides?: Partial<ILanguageModelChatMetadata>): ILanguageModelChatMetadataAndIdentifier {
	const metadata: ILanguageModelChatMetadata = {
		extension: new ExtensionIdentifier('test.ext'),
		id,
		name,
		vendor: identifier.split(/[/:]/)[0],
		version: '1.0',
		family: id,
		maxInputTokens: 128000,
		maxOutputTokens: 4096,
		isDefaultForLocation: {},
		isUserSelectable: true,
		capabilities: { toolCalling: true, agentMode: true },
		...overrides,
	};
	return { identifier, metadata };
}

/** A BYOK chat model published by an extension: general pool, no session target. */
const byokSonnet = createModel('anthropic/claude-sonnet-4', 'claude-sonnet-4', 'Claude Sonnet 4', { isBYOK: true });
/** The agent host's copy of the same BYOK model, targeted at the Codex session type. */
const codexSonnet = createModel(`${SessionType.AgentHostCodex}:claude-sonnet-4`, 'claude-sonnet-4', 'Claude Sonnet 4', { targetChatSessionType: SessionType.AgentHostCodex });
const codexGpt = createModel(`${SessionType.AgentHostCodex}:gpt-5`, 'gpt-5', 'GPT-5', { targetChatSessionType: SessionType.AgentHostCodex });
/** A model that only the Claude agent host can run. */
const claudeOpus = createModel(`${SessionType.AgentHostClaude}:claude-opus-4`, 'claude-opus-4', 'Claude Opus 4', { targetChatSessionType: SessionType.AgentHostClaude });

suite('resolveModelSessionFit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a model that is in the session pool fits', () => {
		const fit = resolveModelSessionFit({
			selectedModel: codexGpt,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [codexSonnet, codexGpt],
			defaultModel: codexGpt,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, { kind: ModelSessionFitKind.Fits });
	});

	test('no selection with a non-empty pool fits: the session default is sent', () => {
		const fit = resolveModelSessionFit({
			selectedModel: undefined,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [codexGpt],
			defaultModel: codexGpt,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, { kind: ModelSessionFitKind.Fits });
	});

	test('a BYOK chat model whose agent-host copy has landed is routed to that copy', () => {
		const fit = resolveModelSessionFit({
			selectedModel: byokSonnet,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [codexSonnet, codexGpt],
			defaultModel: codexGpt,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, { kind: ModelSessionFitKind.UseMatchingModel, model: codexSonnet });
	});

	test('a model with no counterpart in the pool falls back to the session default and names the session that runs it', () => {
		const fit = resolveModelSessionFit({
			selectedModel: claudeOpus,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [codexGpt],
			defaultModel: codexGpt,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, {
			kind: ModelSessionFitKind.UseSessionDefault,
			rejectedModel: claudeOpus,
			defaultModel: codexGpt,
			runsInSessionType: SessionType.AgentHostClaude,
		});
	});

	test('a general-pool model with no counterpart falls back to the default without naming another session', () => {
		const fit = resolveModelSessionFit({
			selectedModel: byokSonnet,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [codexGpt],
			defaultModel: codexGpt,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, {
			kind: ModelSessionFitKind.UseSessionDefault,
			rejectedModel: byokSonnet,
			defaultModel: codexGpt,
			runsInSessionType: undefined,
		});
	});

	test('an empty pool with a model that targets another session type offers to switch session', () => {
		const fit = resolveModelSessionFit({
			selectedModel: claudeOpus,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [],
			defaultModel: undefined,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, {
			kind: ModelSessionFitKind.SwitchSession,
			rejectedModel: claudeOpus,
			targetSessionType: SessionType.AgentHostClaude,
		});
	});

	test('the packaged-build case: BYOK chat model selected, agent-host pool not published yet, no Auto model', () => {
		// This is the state in which Enter used to be a silent no-op: the submit precondition is
		// false (no model available, no Auto fallback) and nothing said why.
		const fit = resolveModelSessionFit({
			selectedModel: byokSonnet,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [],
			defaultModel: undefined,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, { kind: ModelSessionFitKind.AwaitingSessionModels, rejectedModel: byokSonnet });
	});

	test('an empty owned pool with nothing selected is still awaiting models', () => {
		const fit = resolveModelSessionFit({
			selectedModel: undefined,
			sessionType: SessionType.AgentHostCodex,
			sessionPool: [],
			defaultModel: undefined,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, { kind: ModelSessionFitKind.AwaitingSessionModels, rejectedModel: undefined });
	});

	test('an empty pool that the session cannot fill and no Auto model means no model is available', () => {
		const fit = resolveModelSessionFit({
			selectedModel: byokSonnet,
			sessionType: SessionType.Local,
			sessionPool: [],
			defaultModel: undefined,
			sessionRequiresCustomModels: false,
			sessionSupportsAutoModel: false,
		});
		assert.deepStrictEqual(fit, { kind: ModelSessionFitKind.NoModelAvailable, rejectedModel: byokSonnet });
	});

	test('an empty pool with an Auto model and a foreign selection runs on the session default and says so', () => {
		// The agent host drops a foreign model identifier and answers with its own default; the
		// picker must not keep showing a model that will not be the one answering.
		const fit = resolveModelSessionFit({
			selectedModel: byokSonnet,
			sessionType: SessionType.AgentHostCopilot,
			sessionPool: [],
			defaultModel: undefined,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: true,
		});
		assert.deepStrictEqual(fit, {
			kind: ModelSessionFitKind.UseSessionDefault,
			rejectedModel: byokSonnet,
			defaultModel: undefined,
			runsInSessionType: undefined,
		});
	});

	test('an empty pool with an Auto model and nothing selected fits', () => {
		const fit = resolveModelSessionFit({
			selectedModel: undefined,
			sessionType: SessionType.AgentHostCopilot,
			sessionPool: [],
			defaultModel: undefined,
			sessionRequiresCustomModels: true,
			sessionSupportsAutoModel: true,
		});
		assert.deepStrictEqual(fit, { kind: ModelSessionFitKind.Fits });
	});
});
