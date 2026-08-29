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
import { IPrimalProvider, PRIMAL_CUSTOM_BASE_URL_SETTING_ID, PRIMAL_HARNESS_PROVIDER_SETTING_ID, PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, PRIMAL_PROVIDERS, providerExtensionSecretKey, providerSecretKey } from '../../../../../platform/agentHost/common/primalProviders.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ChatModelsWidget } from '../chatManagement/chatModelsWidget.js';
import { PrimalSettingsEditorInput } from './primalSettingsEditorInput.js';

const $ = DOM.$;

/** Fixed height of the embedded models table; the table scrolls internally. */
const MODELS_EMBED_HEIGHT = 460;

/**
 * The Primal Code Settings page: one organized surface for provider API keys,
 * the coding-agent provider, and model visibility — modeled on the settings
 * pages of the leading agent IDEs so nothing needs a command name to find.
 */
export class PrimalSettingsEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.primalSettings';

	private readonly editorDisposables = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private scrollContainer: HTMLElement | undefined;
	private modelsContainer: HTMLElement | undefined;
	private modelsWidget: ChatModelsWidget | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
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

		this._renderApiKeysSection(page);
		this._renderAgentSection(page);
		this._renderModelsSection(page);
	}

	private _renderApiKeysSection(page: HTMLElement): void {
		DOM.append(page, $('h2', undefined, localize('primalSettings.apiKeys', "API Keys")));
		DOM.append(page, $('p.primal-section-note', undefined,
			localize('primalSettings.apiKeys.note', "Add a key to light up that provider's models in the chat model picker.")));

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
			input.value = '';
			status.classList.add('ok');
			status.textContent = localize('primalSettings.status.saving', "Key saved — restarting the agent…");
			try {
				await this.agentHostService.restartAgentHost();
				status.textContent = localize('primalSettings.status.ready', "Key saved — models will appear in the picker in a few seconds.");
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
		}));
	}

	private _renderAgentSection(page: HTMLElement): void {
		DOM.append(page, $('h2', undefined, localize('primalSettings.agent', "Coding Agent")));
		DOM.append(page, $('p.primal-section-note', undefined,
			localize('primalSettings.agent.note', "The provider that powers the agent which edits files and runs commands. Anthropic runs natively; the others run through their Anthropic-compatible endpoints. OpenAI powers the separate Codex agent.")));

		const controls = DOM.append(page, $('.primal-provider-controls'));
		const select = DOM.append(controls, $('select')) as HTMLSelectElement;
		for (const provider of PRIMAL_PROVIDERS.filter(p => p.canDriveClaudeHarness)) {
			const option = DOM.append(select, $('option')) as HTMLOptionElement;
			option.value = provider.id;
			option.textContent = provider.label;
		}
		select.value = this.configurationService.getValue<string>(PRIMAL_HARNESS_PROVIDER_SETTING_ID) || 'anthropic';

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

	private _renderModelsSection(page: HTMLElement): void {
		DOM.append(page, $('h2', undefined, localize('primalSettings.models', "Models")));
		DOM.append(page, $('p.primal-section-note', undefined,
			localize('primalSettings.models.note', "Choose which models appear in the chat model picker. Models show up here once their provider has a key above (Claude also via your Claude Code sign-in). The eye toggles hide a model from the picker.")));
		// The full models table — the same widget as the standalone Language
		// Models editor — embedded so keys and model toggles live on one page.
		this.modelsContainer = DOM.append(page, $('.primal-models-embed'));
		this.modelsWidget = this.editorDisposables.add(this.instantiationService.createInstance(ChatModelsWidget));
		this.modelsContainer.appendChild(this.modelsWidget.element);
	}

	override async setInput(input: PrimalSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.modelsWidget?.render();
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (this.modelsWidget && this.modelsContainer) {
			const height = MODELS_EMBED_HEIGHT;
			this.modelsContainer.style.height = `${height}px`;
			this.modelsWidget.layout(height, this.modelsContainer.clientWidth);
		}
	}
}
