/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IPrimalProvider, PRIMAL_CLEAR_ANTHROPIC_KEY_COMMAND_ID, PRIMAL_CUSTOM_BASE_URL_SETTING_ID, PRIMAL_HARNESS_PROVIDER_SETTING_ID, PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, PRIMAL_MANAGE_PROVIDERS_COMMAND_ID, PRIMAL_PROVIDERS, PRIMAL_SET_ANTHROPIC_KEY_COMMAND_ID, providerSecretKey } from '../../../../../platform/agentHost/common/primalProviders.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';

const CATEGORY = localize2('primalCode.category', "Primal Code");

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'primalCode',
	title: localize('primalCode.settings', "Primal Code"),
	properties: {
		[PRIMAL_HARNESS_PROVIDER_SETTING_ID]: {
			type: 'string',
			enum: PRIMAL_PROVIDERS.filter(p => p.canDriveClaudeHarness).map(p => p.id),
			default: 'anthropic',
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.agent.provider', "Which configured provider powers the coding agent. Anthropic runs natively; the others run through their Anthropic-compatible endpoints. Set API keys with 'Primal Code: Manage AI Providers'."),
		},
		[PRIMAL_CUSTOM_BASE_URL_SETTING_ID]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.agent.customBaseUrl', "Anthropic-compatible base URL used when the coding agent provider is 'custom'."),
		},
	},
});

interface IProviderPickItem extends IQuickPickItem {
	readonly provider: IPrimalProvider;
}

/**
 * One flow for every provider: pick it, paste the key (stored encrypted in the
 * OS-backed secret storage), optionally make it the coding-agent provider, and
 * restart the agent host so the change is live immediately.
 */
async function runManageProviders(accessor: ServicesAccessor, preselectedProviderId?: string): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const secretStorageService = accessor.get(ISecretStorageService);
	const configurationService = accessor.get(IConfigurationService);
	const agentHostService = accessor.get(IAgentHostService);
	const notificationService = accessor.get(INotificationService);

	let provider = PRIMAL_PROVIDERS.find(p => p.id === preselectedProviderId);
	if (!provider) {
		const activeHarness = configurationService.getValue<string>(PRIMAL_HARNESS_PROVIDER_SETTING_ID) || 'anthropic';
		const items: IProviderPickItem[] = [];
		for (const p of PRIMAL_PROVIDERS) {
			const hasKey = !!(await secretStorageService.get(providerSecretKey(p.id)))
				|| (p.id === 'anthropic' && !!(await secretStorageService.get(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY)));
			items.push({
				provider: p,
				label: p.label,
				description: [
					hasKey ? localize('primalCode.providers.keySaved', "key saved") : localize('primalCode.providers.noKey', "no key"),
					p.id === activeHarness ? localize('primalCode.providers.active', "powers the coding agent") : undefined,
				].filter(Boolean).join(' · '),
			});
		}
		const picked = await quickInputService.pick(items, {
			title: localize('primalCode.providers.title', "AI Providers"),
			placeHolder: localize('primalCode.providers.placeholder', "Choose a provider to add or update its API key"),
		});
		provider = picked?.provider;
	}
	if (!provider) {
		return;
	}

	const entered = await quickInputService.input({
		title: localize('primalCode.key.title', "{0} API Key", provider.label),
		prompt: localize('primalCode.key.prompt', "Paste your {0} API key. It is stored encrypted on this machine and only ever sent to that provider.", provider.label),
		password: true,
		ignoreFocusLost: true,
		validateInput: async value => {
			if (!value.trim()) {
				return localize('primalCode.key.empty', "The key cannot be empty.");
			}
			if (provider.keyPrefix && !value.trim().startsWith(provider.keyPrefix)) {
				return { content: localize('primalCode.key.unusual', "{0} keys usually start with {1}. The key will be saved as entered.", provider.label, provider.keyPrefix), severity: Severity.Warning };
			}
			return undefined;
		},
	});
	if (entered === undefined) {
		return; // cancelled
	}
	await secretStorageService.set(providerSecretKey(provider.id), entered.trim());
	// Mirror into the built-in primal extension's secret namespace so the model
	// picker's chat models light up from the same single key entry. Extension
	// secrets live in the same encrypted store under a composite key (see
	// mainThreadSecretState). 'custom' has no picker analog.
	if (provider.id !== 'custom') {
		await secretStorageService.set(JSON.stringify({ extensionId: 'primal-ai.primal-code', key: `primal.${provider.id}ApiKey` }), entered.trim());
	}

	if (provider.id === 'custom') {
		const currentUrl = configurationService.getValue<string>(PRIMAL_CUSTOM_BASE_URL_SETTING_ID) || '';
		const url = await quickInputService.input({
			title: localize('primalCode.customUrl.title', "Anthropic-compatible Base URL"),
			prompt: localize('primalCode.customUrl.prompt', "The endpoint the coding agent should call, e.g. https://api.example.com/anthropic"),
			value: currentUrl,
			ignoreFocusLost: true,
			validateInput: async value => value.trim().startsWith('http') ? undefined : localize('primalCode.customUrl.invalid', "Enter a full http(s) URL."),
		});
		if (url === undefined) {
			return;
		}
		await configurationService.updateValue(PRIMAL_CUSTOM_BASE_URL_SETTING_ID, url.trim());
	}

	let madeActive = false;
	if (provider.canDriveClaudeHarness) {
		const current = configurationService.getValue<string>(PRIMAL_HARNESS_PROVIDER_SETTING_ID) || 'anthropic';
		if (current !== provider.id) {
			const yes = localize('primalCode.makeActive.yes', "Use {0}", provider.label);
			const choice = await quickInputService.pick([
				{ label: yes },
				{ label: localize('primalCode.makeActive.no', "Keep {0}", current) },
			], { title: localize('primalCode.makeActive.title', "Use {0} for the coding agent?", provider.label) });
			if (choice?.label === yes) {
				await configurationService.updateValue(PRIMAL_HARNESS_PROVIDER_SETTING_ID, provider.id);
				madeActive = true;
			}
		} else {
			madeActive = true;
		}
	}

	try {
		await agentHostService.restartAgentHost();
		notificationService.info(madeActive
			? localize('primalCode.key.doneActive', "{0} key saved — the coding agent is starting with it. Open the chat and send a message.", provider.label)
			: localize('primalCode.key.done', "{0} key saved.", provider.label));
	} catch (error) {
		notificationService.warn(localize('primalCode.key.savedNoRestart', "{0} key saved. Restart Primal Code for the coding agent to pick it up. ({1})", provider.label, String(error)));
	}
}

class ManageProvidersAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_MANAGE_PROVIDERS_COMMAND_ID,
			title: localize2('primalCode.manageProviders', "Manage AI Providers…"),
			category: CATEGORY,
			f1: true,
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runManageProviders(accessor);
	}
}

/** Kept as a stable id (the chat empty-state dialog links here). */
class SetAnthropicApiKeyAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_SET_ANTHROPIC_KEY_COMMAND_ID,
			title: localize2('primalCode.setAnthropicApiKey', "Set Anthropic API Key…"),
			category: CATEGORY,
			f1: true,
		});
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return runManageProviders(accessor, 'anthropic');
	}
}

class ClearAnthropicApiKeyAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_CLEAR_ANTHROPIC_KEY_COMMAND_ID,
			title: localize2('primalCode.clearAnthropicApiKey', "Clear Anthropic API Key"),
			category: CATEGORY,
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const secretStorageService = accessor.get(ISecretStorageService);
		const agentHostService = accessor.get(IAgentHostService);
		const notificationService = accessor.get(INotificationService);
		await secretStorageService.delete(providerSecretKey('anthropic'));
		await secretStorageService.delete(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY);
		try {
			await agentHostService.restartAgentHost();
		} catch {
			// The next app start simply won't forward a key.
		}
		notificationService.info(localize('primalCode.clearKey.done', "Anthropic API key removed."));
	}
}

export function registerPrimalProviderActions(): void {
	registerAction2(ManageProvidersAction);
	registerAction2(SetAnthropicApiKeyAction);
	registerAction2(ClearAnthropicApiKeyAction);
}
