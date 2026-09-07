/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction } from '../../../../base/common/actions.js';
import { derived, IObservable, IReader } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { getContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuItemAction, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IAgentHostToolSetEnablementService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostToolSetEnablementService.js';
import { agentIcon, hookIcon, instructionsIcon, mcpServerIcon, pluginIcon, promptIcon, skillIcon } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationIcons.js';
import { IAICustomizationListItem } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationItemSource.js';
import { IAICustomizationItemsModel, ItemsModelSection } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationItemsModel.js';
import { AICustomizationSource, AICustomizationSources } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { isContributionEnabled } from '../../../../workbench/contrib/chat/common/enablement.js';
import { IAgentPlugin, IAgentPluginService } from '../../../../workbench/contrib/chat/common/plugins/agentPluginService.js';
import { PromptsType } from '../../../../workbench/contrib/chat/common/promptSyntax/promptTypes.js';
import { ILanguageModelToolsService } from '../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { McpCommandIds } from '../../../../workbench/contrib/mcp/common/mcpCommandIds.js';
import { IMcpServer, IMcpService, McpConnectionState } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { AICustomizationItemMenuId } from '../../aiCustomizationTreeView/browser/aiCustomizationTreeView.js';
import { AICustomizationItemDisabledContextKey, AICustomizationItemStorageContextKey, AICustomizationItemTypeContextKey } from '../../aiCustomizationTreeView/browser/aiCustomizationTreeViewViews.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ICustomizationCountServices, ICustomizationItemConfig, openCustomizationPluginDetail, readCustomizationItemCount } from './customizationsToolbar.contribution.js';

/**
 * Menu group that holds the Chat Customization view's "Open" action
 * (registered in `aiCustomizationTreeView.contribution.ts`).
 */
const OPEN_ITEM_MENU_GROUP = '1_open';

/**
 * Context forwarded to `AICustomizationItemMenuId` actions. Mirrors the
 * shape the Chat Customization tree passes so the same actions work here.
 */
export interface ICustomizationItemActionContext {
	readonly uri: string;
	readonly name: string;
	readonly promptType: PromptsType;
	readonly storage: AICustomizationSource;
}

/**
 * Context-menu actions for a leaf row plus the argument they expect.
 */
export interface ICustomizationLeafContextMenu {
	readonly actions: readonly IAction[];
	readonly context: ICustomizationItemActionContext;
}

/**
 * One row rendered beneath an expanded customization category.
 */
export interface ICustomizationLeaf {
	readonly id: string;
	readonly label: string;
	/** Quiet secondary line, rendered as dot-separated parts. Only real model fields end up here. */
	readonly detailParts: readonly string[];
	readonly icon: ThemeIcon;
	readonly disabled: boolean;
	/** Longer description surfaced in the hover, when the data carries one. */
	readonly hover: string | undefined;
	/** Opens the row's item the way the Chat Customization view would. */
	readonly open: () => Promise<void>;
	/** Present when the underlying data contributes context-menu actions. */
	readonly getContextMenu?: () => ICustomizationLeafContextMenu;
}

/**
 * Lazily-read rows for one category.
 */
export interface ICustomizationLeafSource {
	readonly leaves: IObservable<readonly ICustomizationLeaf[]>;
	/** Starts (or awaits) the first fetch for the underlying section. */
	load(): Promise<void>;
}

/**
 * Turns the sidebar's customization categories into counts and leaf rows,
 * reading the same observables the customizations editor renders from:
 * `IAICustomizationItemsModel` for agents/skills/instructions/hooks,
 * `IMcpService.servers` for MCP servers and `IAgentPluginService.plugins`
 * for plugins.
 */
export class CustomizationsTreeDataSource {

	private readonly _countServices: ICustomizationCountServices;

	constructor(
		@IAICustomizationItemsModel private readonly _itemsModel: IAICustomizationItemsModel,
		@IMcpService private readonly _mcpService: IMcpService,
		@IAgentPluginService private readonly _agentPluginService: IAgentPluginService,
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IAgentHostToolSetEnablementService toolEnablementService: IAgentHostToolSetEnablementService,
		@IMenuService private readonly _menuService: IMenuService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICustomizationHarnessService private readonly _harnessService: ICustomizationHarnessService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
	) {
		this._countServices = { itemsModel: _itemsModel, mcpService: _mcpService, toolsService, toolEnablementService };
	}

	/**
	 * Whether the category has an item list that can be expanded in place.
	 */
	canExpand(config: ICustomizationItemConfig): boolean {
		return Boolean(config.modelSection || config.isMcp || config.isPlugins);
	}

	readCount(config: ICustomizationItemConfig, reader: IReader): number {
		return readCustomizationItemCount(config, reader, this._countServices);
	}

	/**
	 * Creates the leaf source for an expandable category. Nothing is fetched
	 * until the returned observable is first read or `load()` is called.
	 */
	createLeafSource(config: ICustomizationItemConfig): ICustomizationLeafSource | undefined {
		const section = config.modelSection;
		if (section) {
			return this._createModelSectionSource(section);
		}
		if (config.isMcp) {
			return {
				leaves: derived<readonly ICustomizationLeaf[]>(reader => this._mcpService.servers.read(reader).map(server => this._toMcpLeaf(server, reader))),
				load: () => Promise.resolve(),
			};
		}
		if (config.isPlugins) {
			return {
				leaves: derived<readonly ICustomizationLeaf[]>(reader => this._agentPluginService.plugins.read(reader).map(plugin => this._toPluginLeaf(plugin, reader))),
				load: () => Promise.resolve(),
			};
		}
		return undefined;
	}

	private _createModelSectionSource(section: ItemsModelSection): ICustomizationLeafSource {
		return {
			leaves: derived<readonly ICustomizationLeaf[]>(reader => this._itemsModel.getItems(section).read(reader).map(item => this._toCustomizationLeaf(item))),
			load: () => this._itemsModel.whenSectionLoaded(section),
		};
	}

	private _toCustomizationLeaf(item: IAICustomizationListItem): ICustomizationLeaf {
		const context: ICustomizationItemActionContext = {
			uri: item.uri.toString(),
			name: item.name,
			promptType: item.promptType,
			storage: item.source,
		};
		return {
			id: item.id,
			label: item.displayName || item.name || item.filename,
			detailParts: customizationDetailParts(item),
			icon: item.typeIcon ?? promptTypeIcon(item.promptType),
			disabled: item.disabled,
			hover: item.description,
			open: () => this._openCustomizationItem(item, context),
			getContextMenu: () => ({
				actions: getContextMenuActions(this._getItemMenuGroups(item, context), 'inline').secondary,
				context,
			}),
		};
	}

	/**
	 * Resolves the `AICustomizationItemMenuId` actions for an item with the
	 * same context-key overlay the Chat Customization tree uses.
	 */
	private _getItemMenuGroups(item: IAICustomizationListItem, context: ICustomizationItemActionContext): [string, Array<MenuItemAction | SubmenuItemAction>][] {
		const overlay = this._contextKeyService.createOverlay([
			[AICustomizationItemTypeContextKey.key, item.promptType],
			[AICustomizationItemDisabledContextKey.key, item.disabled],
			[AICustomizationItemStorageContextKey.key, item.source],
		]);
		return this._menuService.getMenuActions(AICustomizationItemMenuId, overlay, { arg: context, shouldForwardArgs: true });
	}

	/**
	 * Opens an item via the Chat Customization view's registered "Open"
	 * action; falls back to opening the file directly, which is what that
	 * view does when a row is activated.
	 */
	private async _openCustomizationItem(item: IAICustomizationListItem, context: ICustomizationItemActionContext): Promise<void> {
		const openGroup = this._getItemMenuGroups(item, context).find(([group]) => group === OPEN_ITEM_MENU_GROUP);
		const openAction = openGroup?.[1].at(0);
		if (openAction) {
			await openAction.run();
			return;
		}
		await this._editorService.openEditor({ resource: item.uri });
	}

	private _toMcpLeaf(server: IMcpServer, reader: IReader): ICustomizationLeaf {
		const state = server.connectionState.read(reader);
		const disabled = !isContributionEnabled(server.enablement.read(reader));
		const detailParts = [disabled ? localize('customizationLeafDisabled', "Disabled") : McpConnectionState.toString(state)];
		if (server.collection.label) {
			detailParts.push(server.collection.label);
		}
		return {
			id: server.definition.id,
			label: server.definition.label,
			detailParts,
			icon: mcpServerIcon,
			disabled,
			hover: state.state === McpConnectionState.Kind.Error ? state.message : undefined,
			open: async () => {
				await this._commandService.executeCommand(McpCommandIds.ServerOptions, server.definition.id);
			},
		};
	}

	private _toPluginLeaf(plugin: IAgentPlugin, reader: IReader): ICustomizationLeaf {
		const enabled = isContributionEnabled(plugin.enablement.read(reader));
		const marketplace = plugin.fromMarketplace;
		const detailParts: string[] = [];
		if (marketplace?.version) {
			detailParts.push(localize('customizationPluginVersion', "v{0}", marketplace.version));
		}
		if (marketplace?.marketplace) {
			detailParts.push(marketplace.marketplace);
		}
		if (!enabled) {
			detailParts.push(localize('customizationLeafDisabled', "Disabled"));
		}
		return {
			id: plugin.uri.toString(),
			label: plugin.label || basename(plugin.uri),
			detailParts,
			icon: pluginIcon,
			disabled: !enabled,
			hover: marketplace?.description,
			open: () => openCustomizationPluginDetail(this._editorService, this._harnessService, this._sessionsService, plugin),
		};
	}
}

function customizationDetailParts(item: IAICustomizationListItem): string[] {
	const parts = [sourceLabel(item.source)];
	if (item.disabled) {
		parts.push(localize('customizationLeafDisabled', "Disabled"));
	}
	if (item.status === 'error' || item.status === 'degraded') {
		parts.push(item.statusMessage || statusLabel(item.status));
	}
	return parts;
}

function sourceLabel(source: AICustomizationSource): string {
	switch (source) {
		case AICustomizationSources.local: return localize('customizationSource.workspace', "Workspace");
		case AICustomizationSources.user: return localize('customizationSource.user', "User");
		case AICustomizationSources.extension: return localize('customizationSource.extension', "Extension");
		case AICustomizationSources.plugin: return localize('customizationSource.plugin', "Plugin");
		case AICustomizationSources.builtin: return localize('customizationSource.builtin', "Built-in");
		default: return source;
	}
}

function statusLabel(status: 'error' | 'degraded'): string {
	return status === 'error'
		? localize('customizationStatus.error', "Error")
		: localize('customizationStatus.degraded', "Degraded");
}

function promptTypeIcon(promptType: PromptsType): ThemeIcon {
	switch (promptType) {
		case PromptsType.agent: return agentIcon;
		case PromptsType.skill: return skillIcon;
		case PromptsType.instructions: return instructionsIcon;
		case PromptsType.hook: return hookIcon;
		case PromptsType.prompt: return promptIcon;
		default: return promptIcon;
	}
}
