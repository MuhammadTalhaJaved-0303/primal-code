/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Primal Basalt';
	export const COLOR_THEME_LIGHT = 'Primal Ink';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#37332F',
	'activityBar.activeBorder': '#E8E4DE',
	'activityBar.background': '#191817',
	'activityBar.border': '#2B2826',
	'activityBar.foreground': '#E8E4DE',
	'activityBar.inactiveForeground': '#807A73',
	'activityBarBadge.background': '#E8E4DE',
	'activityBarBadge.foreground': '#131211',
	'badge.background': '#E8E4DE',
	'badge.foreground': '#131211',
	'button.background': '#E8E4DE',
	'button.border': '#E8E4DE',
	'button.foreground': '#131211',
	'button.hoverBackground': '#F5F2ED',
	'button.secondaryBackground': '#262320',
	'button.secondaryForeground': '#E8E4DE',
	'button.secondaryHoverBackground': '#37332F',
	'chat.slashCommandBackground': '#E8E4DE26',
	'chat.slashCommandForeground': '#F5F2ED',
	'chat.editedFileForeground': '#DCBE7E',
	'checkbox.background': '#1B1A18',
	'checkbox.border': '#383430',
	'debugToolBar.background': '#201E1C',
	'descriptionForeground': '#807A73',
	'dropdown.background': '#1B1A18',
	'dropdown.border': '#383430',
	'dropdown.foreground': '#E8E4DE',
	'dropdown.listBackground': '#201E1C',
	'editor.background': '#131211',
	'editor.findMatchBackground': '#DCBE7E55',
	'editor.foreground': '#E8E4DE',
	'editor.inactiveSelectionBackground': '#37332F99',
	'editor.selectionHighlightBackground': '#37332F66',
	'editorGroup.border': '#2B2826',
	'editorGroupHeader.tabsBackground': '#1C1A19',
	'editorGroupHeader.tabsBorder': '#2B2826',
	'editorGutter.addedBackground': '#86B384',
	'editorGutter.deletedBackground': '#E06C5E',
	'editorGutter.modifiedBackground': '#8AA9C8',
	'editorIndentGuide.activeBackground1': '#807A73',
	'editorIndentGuide.background1': '#2B2826',
	'editorLineNumber.activeForeground': '#E8E4DE',
	'editorLineNumber.foreground': '#807A73',
	'editorOverviewRuler.border': '#00000000',
	'editorWidget.background': '#201E1C',
	'errorForeground': '#E06C5E',
	'focusBorder': '#E8E4DEB3',
	'foreground': '#E8E4DE',
	'icon.foreground': '#B8B2AA',
	'input.background': '#1B1A18',
	'input.border': '#383430',
	'input.foreground': '#E8E4DE',
	'input.placeholderForeground': '#807A73',
	'inputOption.activeBackground': '#E8E4DE33',
	'inputOption.activeBorder': '#E8E4DE',
	'keybindingLabel.foreground': '#E8E4DE',
	'list.activeSelectionIconForeground': '#E8E4DE',
	'list.dropBackground': '#E8E4DE1A',
	'menu.background': '#201E1C',
	'menu.border': '#2B2826',
	'menu.foreground': '#E8E4DE',
	'menu.selectionBackground': '#37332F',
	'menu.separatorBackground': '#2B2826',
	'notificationCenterHeader.background': '#201E1C',
	'notificationCenterHeader.foreground': '#E8E4DE',
	'notifications.background': '#201E1C',
	'notifications.border': '#2B2826',
	'notifications.foreground': '#E8E4DE',
	'panel.background': '#191817',
	'panel.border': '#2B2826',
	'panelInput.border': '#383430',
	'panelTitle.activeBorder': '#E8E4DE',
	'panelTitle.activeForeground': '#E8E4DE',
	'panelTitle.inactiveForeground': '#807A73',
	'peekViewEditor.background': '#191817',
	'peekViewEditor.matchHighlightBackground': '#DCBE7E40',
	'peekViewResult.background': '#191817',
	'peekViewResult.matchHighlightBackground': '#DCBE7E40',
	'pickerGroup.border': '#2B2826',
	'ports.iconRunningProcessForeground': '#86B384',
	'progressBar.background': '#E8E4DE',
	'quickInput.background': '#201E1C',
	'quickInput.foreground': '#E8E4DE',
	'settings.dropdownBackground': '#1B1A18',
	'settings.dropdownBorder': '#383430',
	'settings.headerForeground': '#E8E4DE',
	'settings.modifiedItemIndicator': '#8AA9C8',
	'sideBar.background': '#191817',
	'sideBar.border': '#2B2826',
	'sideBar.foreground': '#E8E4DE',
	'sideBarSectionHeader.background': '#191817',
	'sideBarSectionHeader.border': '#2B2826',
	'sideBarSectionHeader.foreground': '#B8B2AA',
	'sideBarTitle.foreground': '#E8E4DE',
	'statusBar.background': '#1C1A19',
	'statusBar.border': '#2B2826',
	'statusBar.debuggingBackground': '#E8E4DE',
	'statusBar.debuggingForeground': '#131211',
	'statusBar.focusBorder': '#E8E4DEB3',
	'statusBar.foreground': '#B8B2AA',
	'statusBar.noFolderBackground': '#131211',
	'statusBarItem.focusBorder': '#E8E4DEB3',
	'statusBarItem.prominentBackground': '#37332F',
	'statusBarItem.remoteBackground': '#E8E4DE',
	'statusBarItem.remoteForeground': '#131211',
	'tab.activeBackground': '#131211',
	'tab.activeBorder': '#131211',
	'tab.activeBorderTop': '#E8E4DE',
	'tab.activeForeground': '#E8E4DE',
	'tab.border': '#2B2826',
	'tab.hoverBackground': '#131211',
	'tab.inactiveBackground': '#1C1A19',
	'tab.inactiveForeground': '#807A73',
	'tab.lastPinnedBorder': '#2B2826',
	'tab.selectedBackground': '#37332F',
	'tab.selectedBorderTop': '#807A73',
	'tab.selectedForeground': '#E8E4DE',
	'tab.unfocusedActiveBorder': '#131211',
	'tab.unfocusedActiveBorderTop': '#2B2826',
	'tab.unfocusedHoverBackground': '#131211',
	'terminal.foreground': '#E8E4DE',
	'terminal.inactiveSelectionBackground': '#37332F55',
	'terminal.tab.activeBorder': '#E8E4DE',
	'textBlockQuote.background': '#201E1C',
	'textBlockQuote.border': '#2B2826',
	'textCodeBlock.background': '#201E1C',
	'textLink.activeForeground': '#FFFFFF',
	'textLink.foreground': '#E8E4DE',
	'textPreformat.background': '#262320',
	'textPreformat.foreground': '#B8B2AA',
	'textSeparator.foreground': '#2B2826',
	'titleBar.activeBackground': '#1C1A19',
	'titleBar.activeForeground': '#B8B2AA',
	'titleBar.border': '#2B2826',
	'titleBar.inactiveBackground': '#1C1A19',
	'titleBar.inactiveForeground': '#807A73',
	'welcomePage.progress.foreground': '#E8E4DE',
	'welcomePage.tileBackground': '#191817',
	'widget.border': '#2B2826'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#DDD8CE',
	'activityBar.activeBorder': '#1C1A18',
	'activityBar.background': '#F2EFE9',
	'activityBar.border': '#E0DCD4',
	'activityBar.foreground': '#1C1A18',
	'activityBar.inactiveForeground': '#8A847C',
	'activityBarBadge.background': '#1C1A18',
	'activityBarBadge.foreground': '#FAF9F6',
	'badge.background': '#1C1A18',
	'badge.foreground': '#FAF9F6',
	'button.background': '#1C1A18',
	'button.border': '#1C1A18',
	'button.foreground': '#FAF9F6',
	'button.hoverBackground': '#3A3733',
	'button.secondaryBackground': '#E9E5DC',
	'button.secondaryForeground': '#1C1A18',
	'button.secondaryHoverBackground': '#DDD8CE',
	'chat.slashCommandBackground': '#1C1A1826',
	'chat.slashCommandForeground': '#1C1A18',
	'chat.editedFileForeground': '#8A651C',
	'checkbox.background': '#FDFCFA',
	'checkbox.border': '#D5D0C6',
	'descriptionForeground': '#8A847C',
	'diffEditor.unchangedRegionBackground': '#F2EFE9',
	'dropdown.background': '#FDFCFA',
	'dropdown.border': '#D5D0C6',
	'dropdown.foreground': '#1C1A18',
	'dropdown.listBackground': '#F5F2EC',
	'editor.background': '#FAF9F6',
	'editor.foreground': '#1C1A18',
	'editor.inactiveSelectionBackground': '#DDD8CE99',
	'editor.selectionHighlightBackground': '#DDD8CE66',
	'editorGroup.border': '#E0DCD4',
	'editorGroupHeader.tabsBackground': '#EFECE6',
	'editorGroupHeader.tabsBorder': '#E0DCD4',
	'editorGutter.addedBackground': '#4C7A44',
	'editorGutter.deletedBackground': '#B04A38',
	'editorGutter.modifiedBackground': '#3E5F7E',
	'editorIndentGuide.activeBackground1': '#8A847C',
	'editorIndentGuide.background1': '#E0DCD4',
	'editorLineNumber.activeForeground': '#1C1A18',
	'editorLineNumber.foreground': '#8A847C',
	'editorOverviewRuler.border': '#00000000',
	'editorSuggestWidget.background': '#F5F2EC',
	'editorWidget.background': '#F5F2EC',
	'errorForeground': '#A8382C',
	'focusBorder': '#1C1A18',
	'foreground': '#1C1A18',
	'icon.foreground': '#3A3733',
	'input.background': '#FDFCFA',
	'input.border': '#D5D0C6',
	'input.foreground': '#1C1A18',
	'input.placeholderForeground': '#8A847C',
	'inputOption.activeBackground': '#1C1A1833',
	'inputOption.activeBorder': '#1C1A18',
	'inputOption.activeForeground': '#1C1A18',
	'keybindingLabel.foreground': '#1C1A18',
	'list.activeSelectionBackground': '#DDD8CE',
	'list.activeSelectionForeground': '#1C1A18',
	'list.activeSelectionIconForeground': '#1C1A18',
	'list.focusAndSelectionOutline': '#1C1A18',
	'list.hoverBackground': '#E9E5DC',
	'menu.border': '#E0DCD4',
	'menu.selectionBackground': '#DDD8CE',
	'menu.selectionForeground': '#1C1A18',
	'notebook.cellBorderColor': '#E0DCD4',
	'notebook.selectedCellBackground': '#F1EEE7',
	'notificationCenterHeader.background': '#F5F2EC',
	'notificationCenterHeader.foreground': '#1C1A18',
	'notifications.background': '#F5F2EC',
	'notifications.border': '#E0DCD4',
	'notifications.foreground': '#1C1A18',
	'panel.background': '#F2EFE9',
	'panel.border': '#E0DCD4',
	'panelInput.border': '#D5D0C6',
	'panelTitle.activeBorder': '#1C1A18',
	'panelTitle.activeForeground': '#1C1A18',
	'panelTitle.inactiveForeground': '#8A847C',
	'peekViewEditor.matchHighlightBackground': '#8A651C40',
	'peekViewResult.background': '#F2EFE9',
	'peekViewResult.matchHighlightBackground': '#8A651C40',
	'pickerGroup.border': '#E0DCD4',
	'pickerGroup.foreground': '#8A847C',
	'ports.iconRunningProcessForeground': '#4C7A44',
	'progressBar.background': '#1C1A18',
	'quickInput.background': '#F5F2EC',
	'quickInput.foreground': '#1C1A18',
	'searchEditor.textInputBorder': '#D5D0C6',
	'settings.dropdownBackground': '#FDFCFA',
	'settings.dropdownBorder': '#D5D0C6',
	'settings.headerForeground': '#1C1A18',
	'settings.modifiedItemIndicator': '#3E5F7E',
	'settings.numberInputBorder': '#D5D0C6',
	'settings.textInputBorder': '#D5D0C6',
	'sideBar.background': '#F2EFE9',
	'sideBar.border': '#E0DCD4',
	'sideBar.foreground': '#1C1A18',
	'sideBarSectionHeader.background': '#F2EFE9',
	'sideBarSectionHeader.border': '#E0DCD4',
	'sideBarSectionHeader.foreground': '#3A3733',
	'sideBarTitle.foreground': '#1C1A18',
	'statusBar.background': '#EFECE6',
	'statusBar.border': '#E0DCD4',
	'statusBar.debuggingBackground': '#1C1A18',
	'statusBar.debuggingForeground': '#FAF9F6',
	'statusBar.focusBorder': '#1C1A18',
	'statusBar.foreground': '#3A3733',
	'statusBar.noFolderBackground': '#EFECE6',
	'statusBarItem.compactHoverBackground': '#E9E5DC',
	'statusBarItem.errorBackground': '#A8382C',
	'statusBarItem.focusBorder': '#1C1A18',
	'statusBarItem.hoverBackground': '#E9E5DC',
	'statusBarItem.prominentBackground': '#DDD8CE',
	'statusBarItem.remoteBackground': '#1C1A18',
	'statusBarItem.remoteForeground': '#FAF9F6',
	'tab.activeBackground': '#FAF9F6',
	'tab.activeBorder': '#FAF9F6',
	'tab.activeBorderTop': '#1C1A18',
	'tab.activeForeground': '#1C1A18',
	'tab.border': '#E0DCD4',
	'tab.hoverBackground': '#FAF9F6',
	'tab.inactiveBackground': '#EFECE6',
	'tab.inactiveForeground': '#8A847C',
	'tab.lastPinnedBorder': '#E0DCD4',
	'tab.selectedBackground': '#DDD8CE',
	'tab.selectedBorderTop': '#8A847C',
	'tab.selectedForeground': '#1C1A18',
	'tab.unfocusedActiveBorder': '#FAF9F6',
	'tab.unfocusedActiveBorderTop': '#E0DCD4',
	'tab.unfocusedHoverBackground': '#FAF9F6',
	'terminal.foreground': '#1C1A18',
	'terminal.inactiveSelectionBackground': '#DDD8CE55',
	'terminal.tab.activeBorder': '#1C1A18',
	'terminalCursor.foreground': '#1C1A18',
	'textBlockQuote.background': '#F5F2EC',
	'textBlockQuote.border': '#E0DCD4',
	'textCodeBlock.background': '#F5F2EC',
	'textLink.activeForeground': '#000000',
	'textLink.foreground': '#1C1A18',
	'textPreformat.background': '#E9E5DC',
	'textPreformat.foreground': '#3A3733',
	'textSeparator.foreground': '#E0DCD4',
	'titleBar.activeBackground': '#EFECE6',
	'titleBar.activeForeground': '#3A3733',
	'titleBar.border': '#E0DCD4',
	'titleBar.inactiveBackground': '#EFECE6',
	'titleBar.inactiveForeground': '#8A847C',
	'welcomePage.tileBackground': '#F2EFE9',
	'widget.border': '#E0DCD4'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
