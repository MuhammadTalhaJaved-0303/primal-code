/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The BYOK provider registry for Primal Code's coding agent.
 *
 * Every provider's API key is stored encrypted through `ISecretStorageService`
 * under {@link providerSecretKey}. The provider selected by
 * {@link PRIMAL_HARNESS_PROVIDER_SETTING_ID} powers the Claude agent harness:
 * Anthropic natively via `ANTHROPIC_API_KEY`, everything else through its
 * documented Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL` +
 * `ANTHROPIC_AUTH_TOKEN` — the same mechanism these providers publish for
 * running Claude Code against their models. OpenAI keys power the Codex
 * harness (`OPENAI_API_KEY`); Google keys currently power picker models only.
 */
export interface IPrimalProvider {
	readonly id: string;
	readonly label: string;
	/** Expected key prefix, used only for a soft paste-mistake warning. */
	readonly keyPrefix?: string;
	/** Anthropic-compatible base URL; `undefined` for Anthropic itself. */
	readonly anthropicCompatibleBaseUrl?: string;
	/** True when this provider can drive the Claude agent harness. */
	readonly canDriveClaudeHarness: boolean;
}

export const PRIMAL_PROVIDERS: readonly IPrimalProvider[] = [
	{ id: 'anthropic', label: 'Anthropic (Claude)', keyPrefix: 'sk-ant-', canDriveClaudeHarness: true },
	{ id: 'openai', label: 'OpenAI (GPT / Codex)', keyPrefix: 'sk-', canDriveClaudeHarness: false },
	{ id: 'google', label: 'Google (Gemini)', canDriveClaudeHarness: false },
	{ id: 'deepseek', label: 'DeepSeek', keyPrefix: 'sk-', anthropicCompatibleBaseUrl: 'https://api.deepseek.com/anthropic', canDriveClaudeHarness: true },
	{ id: 'kimi', label: 'Kimi (Moonshot)', keyPrefix: 'sk-', anthropicCompatibleBaseUrl: 'https://api.moonshot.ai/anthropic', canDriveClaudeHarness: true },
	{ id: 'glm', label: 'GLM (Zhipu / Z.ai)', anthropicCompatibleBaseUrl: 'https://open.bigmodel.cn/api/anthropic', canDriveClaudeHarness: true },
	{ id: 'minimax', label: 'MiniMax', anthropicCompatibleBaseUrl: 'https://api.minimax.io/anthropic', canDriveClaudeHarness: true },
	{ id: 'custom', label: 'Custom (Anthropic-compatible endpoint)', canDriveClaudeHarness: true },
];

export function providerById(id: string | undefined): IPrimalProvider | undefined {
	return PRIMAL_PROVIDERS.find(p => p.id === id);
}

/** Secret-storage key for one provider's API key. */
export function providerSecretKey(providerId: string): string {
	return `primalCode.providerApiKey.${providerId}`;
}

/**
 * The built-in primal extension's own secret for the same key (extension
 * secrets share the core store under a composite key — see
 * mainThreadSecretState). Writing both makes one key entry light up the
 * picker's chat models and the coding agent alike. 'custom' has no picker
 * analog and is not mirrored.
 */
export function providerExtensionSecretKey(providerId: string): string {
	return JSON.stringify({ extensionId: 'primal-ai.primal-code', key: `primal.${providerId}ApiKey` });
}

/**
 * Setting naming which configured provider drives the Claude agent harness.
 * Plain (non-secret) — it holds an id, never a key.
 */
export const PRIMAL_HARNESS_PROVIDER_SETTING_ID = 'primalCode.agent.provider';

/** Base URL used when the harness provider is `custom`. */
export const PRIMAL_CUSTOM_BASE_URL_SETTING_ID = 'primalCode.agent.customBaseUrl';

/** Command ids (referenced from chat UX). */
export const PRIMAL_OPEN_SETTINGS_COMMAND_ID = 'primalCode.openSettings';
export const PRIMAL_MANAGE_PROVIDERS_COMMAND_ID = 'primalCode.manageProviders';
export const PRIMAL_SET_ANTHROPIC_KEY_COMMAND_ID = 'primalCode.setAnthropicApiKey';
export const PRIMAL_CLEAR_ANTHROPIC_KEY_COMMAND_ID = 'primalCode.clearAnthropicApiKey';

/**
 * Legacy secret key from the first iteration of key onboarding; read as a
 * fallback for the Anthropic provider so early testers keep working.
 */
export const PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY = 'primalCode.anthropicApiKey';
