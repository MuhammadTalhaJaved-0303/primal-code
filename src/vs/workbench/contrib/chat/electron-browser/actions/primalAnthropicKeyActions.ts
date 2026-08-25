/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { PRIMAL_ANTHROPIC_API_KEY_SECRET_KEY, PRIMAL_CLEAR_ANTHROPIC_KEY_COMMAND_ID, PRIMAL_SET_ANTHROPIC_KEY_COMMAND_ID } from '../../../../../platform/agentHost/common/primalAnthropicKey.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';

const CATEGORY = localize2('primalCode.category', "Primal Code");

/**
 * Prompts for an Anthropic API key, stores it encrypted in the OS-backed secret
 * storage, and restarts the agent host so the Claude agent picks it up. This is
 * the primary onboarding path for the BYOK Claude agent.
 */
class SetAnthropicApiKeyAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_SET_ANTHROPIC_KEY_COMMAND_ID,
			title: localize2('primalCode.setAnthropicApiKey', "Set Anthropic API Key…"),
			category: CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const secretStorageService = accessor.get(ISecretStorageService);
		const agentHostService = accessor.get(IAgentHostService);
		const notificationService = accessor.get(INotificationService);

		const entered = await quickInputService.input({
			title: localize('primalCode.setKey.title', "Anthropic API Key"),
			prompt: localize('primalCode.setKey.prompt', "Paste your Anthropic API key (starts with sk-ant-). It is stored encrypted on this machine and only ever sent to Anthropic."),
			password: true,
			ignoreFocusLost: true,
			validateInput: async value => {
				if (!value.trim()) {
					return localize('primalCode.setKey.empty', "The key cannot be empty.");
				}
				if (!value.trim().startsWith('sk-ant-')) {
					// Non-standard keys (proxies, gateways) are allowed; just flag the common paste mistake.
					return { content: localize('primalCode.setKey.unusual', "Anthropic keys usually start with sk-ant-. The key will be saved as entered."), severity: Severity.Warning };
				}
				return undefined;
			},
		});
		if (entered === undefined) {
			return; // cancelled
		}

		await secretStorageService.set(PRIMAL_ANTHROPIC_API_KEY_SECRET_KEY, entered.trim());
		try {
			await agentHostService.restartAgentHost();
			notificationService.info(localize('primalCode.setKey.done', "Anthropic API key saved. The Claude agent is starting — open the chat and send a message."));
		} catch (error) {
			notificationService.warn(localize('primalCode.setKey.savedNoRestart', "Anthropic API key saved. Restart Primal Code to start the Claude agent. ({0})", String(error)));
		}
	}
}

/** Removes the stored Anthropic API key and restarts the agent host. */
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

		await secretStorageService.delete(PRIMAL_ANTHROPIC_API_KEY_SECRET_KEY);
		try {
			await agentHostService.restartAgentHost();
		} catch {
			// The next app start simply won't forward a key.
		}
		notificationService.info(localize('primalCode.clearKey.done', "Anthropic API key removed."));
	}
}

export function registerPrimalAnthropicKeyActions(): void {
	registerAction2(SetAnthropicApiKeyAction);
	registerAction2(ClearAnthropicApiKeyAction);
}
