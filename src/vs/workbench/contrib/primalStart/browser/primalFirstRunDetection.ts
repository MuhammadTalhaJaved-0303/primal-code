/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isFalsyOrWhitespace } from '../../../../base/common/strings.js';
import { PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, PRIMAL_PROVIDERS, providerById, providerSecretKey } from '../../../../platform/agentHost/common/primalProviders.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { SessionType } from '../../chat/common/chatSessionsService.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';

/**
 * How the first-run guide reads the world for its "Connect a model" step.
 *
 * Two facts are observed, never assumed:
 *
 * 1. Which providers have an API key in secret storage (names only - the key
 *    itself is never read into the guide, only whether one is there).
 * 2. Whether the Claude coding agent has models to offer. The agent host only
 *    publishes a Claude catalogue when `detectExistingClaudeSetup` found a
 *    usable local setup (an env credential, `~/.claude/settings.json`, or the
 *    Claude Code CLI's own stored login - on macOS the keychain entry
 *    "Claude Code-credentials"). That probe runs in the agent-host process; the
 *    renderer sees its result as models appearing under the Claude vendor.
 *
 * A Claude catalogue with no key that could have produced it is therefore the
 * honest signal for "your existing Claude Code login is being used".
 */

/** The provider id the legacy secret belongs to. */
const LEGACY_ANTHROPIC_PROVIDER_ID = 'anthropic';

const PROVIDER_SECRET_KEY_PREFIX = providerSecretKey('');

/** Whether a secret-storage key is one the guide cares about. */
export function isProviderSecretKey(key: string): boolean {
	return key.startsWith(PROVIDER_SECRET_KEY_PREFIX) || key === PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY;
}

/** A stored key counts only when it carries a value, never a blank leftover. */
function hasSecret(value: string | undefined): boolean {
	return value !== undefined && !isFalsyOrWhitespace(value);
}

/**
 * The provider ids that have a key, in registry order, each at most once. The
 * legacy Anthropic secret is read as the Anthropic provider so early testers
 * see their key acknowledged.
 */
export async function detectConfiguredProviderIds(secrets: ISecretStorageService): Promise<readonly string[]> {
	const checks = PRIMAL_PROVIDERS.map(async provider => {
		const stored = hasSecret(await secrets.get(providerSecretKey(provider.id)));
		const legacy = provider.id === LEGACY_ANTHROPIC_PROVIDER_ID && hasSecret(await secrets.get(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY));
		return stored || legacy ? provider.id : undefined;
	});
	const results = await Promise.all(checks);
	return results.filter((id): id is string => id !== undefined);
}

/** Whether any published model belongs to the Claude coding agent. */
export function hasClaudeAgentModels(languageModels: ILanguageModelsService): boolean {
	return languageModels.getLanguageModelIds().some(identifier => {
		const metadata = languageModels.lookupLanguageModel(identifier);
		return metadata !== undefined && metadata.vendor.startsWith(SessionType.AgentHostClaude);
	});
}

/**
 * Claude models that no configured key could have unlocked come from an
 * existing Claude Code login. A key that can drive the Claude harness (Anthropic
 * or an Anthropic-compatible endpoint) explains the catalogue by itself, so
 * the login is not claimed then - it may or may not exist, and the guide only
 * says what it knows.
 */
export function inferClaudeLogin(claudeModelsPresent: boolean, configuredProviderIds: readonly string[]): boolean {
	if (!claudeModelsPresent) {
		return false;
	}
	return !configuredProviderIds.some(id => providerById(id)?.canDriveClaudeHarness === true);
}
