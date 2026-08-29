/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalSettingsEditor.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { IPrimalProvider, PRIMAL_CUSTOM_BASE_URL_SETTING_ID, PRIMAL_HARNESS_PROVIDER_SETTING_ID, PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, PRIMAL_PROVIDERS, PRIMAL_PROVIDER_MODEL_PREVIEWS, providerExtensionSecretKey, providerSecretKey } from '../../../../../platform/agentHost/common/primalProviders.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { AgentSessionProviders } from '../agentSessions/agentSessions.js';
import { getRememberedSessionType, storeUserSelectedSessionType } from '../../common/chatSessionTypePreference.js';
import { ILanguageModelChatMetadata, ILanguageModelsService } from '../../common/languageModels.js';
import { PrimalSettingsEditorInput } from './primalSettingsEditorInput.js';

const $ = DOM.$;

/** One row of the Cursor-style model list. */
interface IModelRow {
	readonly label: string;
	readonly tag: string;
	/** Undefined for greyed preview rows (provider key missing). */
	readonly identifier?: string;
	readonly providerOrder: number;
}

/**
 * The Primal Code Settings page: one organized surface for provider API keys,
 * the coding-agent provider, and the model list with visibility toggles —
 * modeled on the settings pages of the leading agent IDEs so nothing needs a
 * command name to find.
 */
export class PrimalSettingsEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.primalSettings';

	private readonly editorDisposables = this._register(new DisposableStore());
	private readonly modelRowDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private scrollContainer: HTMLElement | undefined;
	private modelsListContainer: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super(PrimalSettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.scrollContainer = DOM.append(parent, $('.primal-settings-editor'));
		const page = DOM.append(this.scrollContainer, $('.primal-settings-page'));

		DOM.append(page, $('h1', undefined, localize('primalSettings.title', "Primal Code Settings")));
		DOM.append(page, $('p.primal-settings-subtitle', undefined,
			localize('primalSettings.subtitle', "Bring your own keys. They are stored encrypted on this machine and only ever sent to the provider itself — never to us.")));

		this._renderModelsSection(page);
		this._renderApiKeysSection(page);
		this._renderAgentSection(page);
	}

	// #region Models — Cursor-style list: model name + on/off switch

	private _renderModelsSection(page: HTMLElement): void {
		DOM.append(page, $('h2', undefined, localize('primalSettings.models', "Models")));
		DOM.append(page, $('p.primal-section-note', undefined,
			localize('primalSettings.models.note', "Choose which models appear in the chat's model picker. Greyed models need their provider's API key — add it in the API Keys section below.")));
		this.modelsListContainer = DOM.append(page, $('.primal-model-list'));
		this._renderModelRows();
		this._pullProviderModels();
		// Live refresh: saving a key registers models a moment later; the list
		// updates itself without reopening the page.
		this.editorDisposables.add(this.languageModelsService.onDidChangeLanguageModels(() => this._renderModelRows()));
	}

	private _renderModelRows(): void {
		const container = this.modelsListContainer;
		if (!container) {
			return;
		}
		this.modelRowDisposables.clear();
		DOM.clearNode(container);

		const rows = this._collectModelRows();
		for (const row of rows) {
			const rowElement = DOM.append(container, $(row.identifier ? '.primal-model-row' : '.primal-model-row.preview'));
			const info = DOM.append(rowElement, $('.primal-model-info'));
			DOM.append(info, $('.primal-model-name', undefined, row.label));
			DOM.append(info, $('.primal-model-tag', undefined, row.identifier ? row.tag : localize('primalSettings.models.needsKey', "{0} — add API key below", row.tag)));

			const toggle = DOM.append(rowElement, $('label.primal-toggle')) as HTMLLabelElement;
			const checkbox = DOM.append(toggle, $('input')) as HTMLInputElement;
			checkbox.type = 'checkbox';
			DOM.append(toggle, $('span.primal-toggle-slider'));
			if (row.identifier) {
				const identifier = row.identifier;
				checkbox.checked = !this.languageModelsService.isModelHidden(identifier);
				checkbox.ariaLabel = localize('primalSettings.models.toggleAria', "Show {0} in the chat model picker", row.label);
				this.modelRowDisposables.add(DOM.addDisposableListener(checkbox, 'change', () => {
					this.languageModelsService.setModelHidden(identifier, !checkbox.checked);
				}));
			} else {
				checkbox.checked = false;
				checkbox.disabled = true;
			}
		}
	}

	/**
	 * Wakes the bundled model-provider extension and resolves its models, so a
	 * key saved a moment ago unlocks its models here and in the chat picker
	 * without any other UI having to be opened first. Errors surface on use.
	 */
	private _pullProviderModels(): void {
		void this.languageModelsService.selectLanguageModels({ vendor: 'primal' }).catch(() => { });
	}

	/** Live models first (ordered by provider), then greyed previews for keyless providers. */
	private _collectModelRows(): IModelRow[] {
		const providerOrder = new Map<string, number>(PRIMAL_PROVIDERS.map((p, i) => [p.id, i]));
		const providerLabel = new Map<string, string>(PRIMAL_PROVIDERS.map(p => [p.id, p.label]));
		const liveRows: IModelRow[] = [];
		const liveProviders = new Set<string>();

		for (const identifier of this.languageModelsService.getLanguageModelIds()) {
			const metadata = this.languageModelsService.lookupLanguageModel(identifier);
			if (!metadata || metadata.id === 'auto') {
				continue;
			}
			// Agent-host copies of BYOK models already appear under their real
			// provider; listing them again would duplicate the catalogue.
			if (ILanguageModelChatMetadata.getAgentHostByokManageModelsIdentifier(metadata) !== undefined) {
				continue;
			}
			const providerId = this._providerIdForMetadata(metadata);
			if (providerId) {
				liveProviders.add(providerId);
			}
			liveRows.push({
				label: metadata.name,
				tag: providerId ? (providerLabel.get(providerId) ?? providerId) : this._friendlyVendor(metadata.vendor),
				identifier,
				providerOrder: providerId !== undefined ? (providerOrder.get(providerId) ?? 90) : 95,
			});
		}
		liveRows.sort((a, b) => a.providerOrder - b.providerOrder || a.label.localeCompare(b.label));

		const previewRows: IModelRow[] = [];
		for (const [providerId, models] of Object.entries(PRIMAL_PROVIDER_MODEL_PREVIEWS)) {
			if (liveProviders.has(providerId)) {
				continue;
			}
			for (const label of models) {
				previewRows.push({
					label,
					tag: providerLabel.get(providerId) ?? providerId,
					providerOrder: providerOrder.get(providerId) ?? 90,
				});
			}
		}
		previewRows.sort((a, b) => a.providerOrder - b.providerOrder);

		return [...liveRows, ...previewRows];
	}

	/** Maps a live model back to one of our provider ids, when recognizable. */
	private _providerIdForMetadata(metadata: ILanguageModelChatMetadata): string | undefined {
		if (metadata.vendor === 'primal') {
			// The primal extension namespaces model ids as `<provider>:<model>`.
			const at = metadata.id.indexOf(':');
			return at > 0 ? metadata.id.slice(0, at) : 'anthropic';
		}
		if (metadata.vendor.startsWith('agent-host-claude') || metadata.vendor === 'agent-host-copilot') {
			return 'anthropic';
		}
		return undefined;
	}

	private _friendlyVendor(vendor: string): string {
		if (vendor.startsWith('agent-host-')) {
			return localize('primalSettings.models.agentTag', "Coding agent");
		}
		return vendor;
	}

	// #endregion

	private _renderApiKeysSection(page: HTMLElement): void {
		DOM.append(page, $('h2', undefined, localize('primalSettings.apiKeys', "API Keys")));
		DOM.append(page, $('p.primal-section-note', undefined,
			localize('primalSettings.apiKeys.note', "Add a key to light up that provider's models in the list above.")));

		for (const provider of PRIMAL_PROVIDERS) {
			if (provider.id === 'custom') {
				continue; // configured in the Coding Agent section, where its base URL lives
			}
			this._renderProviderRow(page, provider);
		}
	}

	private _renderProviderRow(page: HTMLElement, provider: IPrimalProvider): void {
		const row = DOM.append(page, $('.primal-provider-row'));
		DOM.append(row, $('.primal-provider-label', undefined, provider.label));
		const desc = provider.id === 'anthropic'
			? localize('primalSettings.anthropic.desc', "Powers the Claude models and the coding agent.")
			: provider.canDriveClaudeHarness
				? localize('primalSettings.compat.desc', "Chat models, and can power the coding agent through its Anthropic-compatible endpoint.")
				: localize('primalSettings.chat.desc', "Chat models in the model picker.");
		DOM.append(row, $('.primal-provider-desc', undefined, desc));

		const controls = DOM.append(row, $('.primal-provider-controls'));
		const input = DOM.append(controls, $('input')) as HTMLInputElement;
		input.type = 'password';
		input.placeholder = localize('primalSettings.keyPlaceholder', "Enter your {0} API key", provider.label);
		input.spellcheck = false;

		const saveButton = DOM.append(controls, $('button.primal-btn', undefined, localize('primalSettings.save', "Save"))) as HTMLButtonElement;
		const removeButton = DOM.append(controls, $('button.primal-btn.secondary', undefined, localize('primalSettings.remove', "Remove"))) as HTMLButtonElement;
		removeButton.style.display = 'none';
		const status = DOM.append(row, $('.primal-provider-status'));

		if (provider.id === 'anthropic') {
			DOM.append(row, $('.primal-anthropic-note', undefined,
				localize('primalSettings.anthropic.note', "Signed in to Claude Code on this Mac? Claude models already work with no key — a key here is only needed without that login.")));
		}

		const refreshSavedState = async () => {
			const saved = !!(await this.secretStorageService.get(providerSecretKey(provider.id)))
				|| (provider.id === 'anthropic' && !!(await this.secretStorageService.get(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY)));
			removeButton.style.display = saved ? '' : 'none';
			if (saved) {
				input.placeholder = localize('primalSettings.keySaved', "•••••••• key saved — paste to replace");
				status.classList.add('ok');
				status.textContent = localize('primalSettings.status.saved', "Key saved");
			} else {
				status.classList.remove('ok');
				status.textContent = '';
			}
		};
		void refreshSavedState();

		this.editorDisposables.add(DOM.addDisposableListener(saveButton, 'click', async () => {
			const value = input.value.trim();
			if (!value) {
				status.classList.remove('ok');
				status.textContent = localize('primalSettings.status.empty', "Paste a key first.");
				return;
			}
			if (provider.keyPrefix && !value.startsWith(provider.keyPrefix)) {
				// Soft warning only: gateways and proxies use other shapes.
				status.textContent = localize('primalSettings.status.unusual', "Note: {0} keys usually start with {1}. Saving as entered…", provider.label, provider.keyPrefix);
			}
			await this.secretStorageService.set(providerSecretKey(provider.id), value);
			await this.secretStorageService.set(providerExtensionSecretKey(provider.id), value);
			this._pullProviderModels();
			input.value = '';
			status.classList.add('ok');
			status.textContent = localize('primalSettings.status.saving', "Key saved — restarting the agent…");
			try {
				await this.agentHostService.restartAgentHost();
				this._pullProviderModels();
				status.textContent = localize('primalSettings.status.ready', "Key saved — the models above will light up in a few seconds.");
			} catch {
				status.textContent = localize('primalSettings.status.savedRestart', "Key saved — restart Primal Code to finish.");
			}
			void refreshSavedState();
		}));

		this.editorDisposables.add(DOM.addDisposableListener(removeButton, 'click', async () => {
			await this.secretStorageService.delete(providerSecretKey(provider.id));
			await this.secretStorageService.delete(providerExtensionSecretKey(provider.id));
			if (provider.id === 'anthropic') {
				await this.secretStorageService.delete(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY);
			}
			status.classList.remove('ok');
			status.textContent = localize('primalSettings.status.removed', "Key removed.");
			input.placeholder = localize('primalSettings.keyPlaceholder', "Enter your {0} API key", provider.label);
			removeButton.style.display = 'none';
			try {
				await this.agentHostService.restartAgentHost();
			} catch { /* picked up on next start */ }
			this._pullProviderModels();
		}));
	}

	private _renderAgentSection(page: HTMLElement): void {
		DOM.append(page, $('h2', undefined, localize('primalSettings.agent', "Coding Agent")));
		DOM.append(page, $('p.primal-section-note', undefined,
			localize('primalSettings.agent.note', "The provider that powers the agent which edits files and runs commands. Anthropic runs natively; the others run through their Anthropic-compatible endpoints. OpenAI powers the separate Codex agent.")));

		const controls = DOM.append(page, $('.primal-provider-controls'));
		const select = DOM.append(controls, $('select')) as HTMLSelectElement;
		for (const provider of PRIMAL_PROVIDERS.filter(p => p.canDriveClaudeHarness || p.id === 'openai')) {
			const option = DOM.append(select, $('option')) as HTMLOptionElement;
			option.value = provider.id;
			option.textContent = provider.id === 'openai'
				? localize('primalSettings.agent.openaiOption', "OpenAI (Codex agent)")
				: provider.label;
		}
		// OpenAI rides the separate Codex session type; everything else drives
		// the Claude harness selected by the provider setting.
		select.value = getRememberedSessionType(this.storageService) === AgentSessionProviders.AgentHostCodex
			? 'openai'
			: (this.configurationService.getValue<string>(PRIMAL_HARNESS_PROVIDER_SETTING_ID) || 'anthropic');

		const status = DOM.append(page, $('.primal-agent-note'));

		const customRow = DOM.append(page, $('.primal-provider-row'));
		customRow.style.marginTop = '10px';
		DOM.append(customRow, $('.primal-provider-desc', undefined, localize('primalSettings.customUrl', "Custom Anthropic-compatible base URL (used when the provider above is Custom):")));
		const customControls = DOM.append(customRow, $('.primal-provider-controls'));
		const customInput = DOM.append(customControls, $('input')) as HTMLInputElement;
		customInput.type = 'text';
		customInput.placeholder = 'https://api.example.com/anthropic';
		customInput.spellcheck = false;
		customInput.value = this.configurationService.getValue<string>(PRIMAL_CUSTOM_BASE_URL_SETTING_ID) || '';
		const customSave = DOM.append(customControls, $('button.primal-btn.secondary', undefined, localize('primalSettings.save', "Save"))) as HTMLButtonElement;
		const updateCustomVisibility = () => { customRow.style.display = select.value === 'custom' ? '' : 'none'; };
		updateCustomVisibility();

		this.editorDisposables.add(DOM.addDisposableListener(select, 'change', async () => {
			updateCustomVisibility();
			if (select.value === 'openai') {
				storeUserSelectedSessionType(this.storageService, AgentSessionProviders.AgentHostCodex);
				status.textContent = localize('primalSettings.agent.codex', "New chats now use the Codex agent on your OpenAI key.");
				return;
			}
			storeUserSelectedSessionType(this.storageService, AgentSessionProviders.AgentHostClaude);
			await this.configurationService.updateValue(PRIMAL_HARNESS_PROVIDER_SETTING_ID, select.value);
			status.textContent = localize('primalSettings.agent.switching', "Coding agent switching to {0}…", select.selectedOptions[0]?.textContent ?? select.value);
			try {
				await this.agentHostService.restartAgentHost();
				status.textContent = localize('primalSettings.agent.switched', "Coding agent now runs on {0}. Make sure its key is saved above.", select.selectedOptions[0]?.textContent ?? select.value);
			} catch {
				status.textContent = localize('primalSettings.agent.switchRestart', "Saved — restart Primal Code to finish.");
			}
		}));
		this.editorDisposables.add(DOM.addDisposableListener(customSave, 'click', async () => {
			await this.configurationService.updateValue(PRIMAL_CUSTOM_BASE_URL_SETTING_ID, customInput.value.trim());
			try {
				await this.agentHostService.restartAgentHost();
			} catch { /* picked up on next start */ }
			status.textContent = localize('primalSettings.customUrl.saved', "Custom endpoint saved.");
		}));
	}

	override async setInput(input: PrimalSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._renderModelRows();
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
	}
}
