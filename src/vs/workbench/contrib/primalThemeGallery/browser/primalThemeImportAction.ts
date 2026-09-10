/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IPrimalImportProblem, readImportedTheme } from '../common/primalThemeImport.js';
import { computeThemeReadability } from '../common/primalThemeReadability.js';
import { describeVerdictCounts, describeVerdictLevel } from '../common/primalThemeVerdictLabel.js';
import { createColorMapSource } from './primalThemeColorSource.js';

/** The setting an imported palette is written to. Inert JSON, visible, reversible. */
const COLOR_CUSTOMIZATIONS_SETTING_ID = 'workbench.colorCustomizations';

/** The colour ids the last import wrote, so only those can be taken back out. */
const IMPORTED_KEYS_STORAGE_KEY = 'primalCode.themeImport.keys';

/** At most this many per-value problems are listed before the rest are counted. */
const MAX_LISTED_PROBLEMS = 6;

function formatProblems(problems: readonly IPrimalImportProblem[]): string {
	const listed = problems.slice(0, MAX_LISTED_PROBLEMS)
		.map(problem => (problem.at ? `${problem.at}: ${problem.message}` : problem.message));
	if (problems.length > MAX_LISTED_PROBLEMS) {
		listed.push(localize('primalImport.andMore', "…and {0} more.", problems.length - MAX_LISTED_PROBLEMS));
	}
	return listed.join('\n');
}

/** The colour ids a previous import wrote, as recorded in storage. */
function readImportedKeys(storageService: IStorageService): readonly string[] {
	const raw = storageService.get(IMPORTED_KEYS_STORAGE_KEY, StorageScope.PROFILE);
	if (!raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
	} catch {
		return []; // storage is external data; a corrupt value simply means "nothing recorded"
	}
}

/**
 * The USER layer of `workbench.colorCustomizations`, or an empty object.
 *
 * The user layer specifically, not `getValue()`. Both callers below do a
 * read-modify-write against `ConfigurationTarget.USER`, and `getValue()` returns
 * the CONSOLIDATED value — defaults, application, user, workspace and memory
 * merged key by key. Writing that back to the user file would promote every
 * workspace-authored colour into the user's global settings: a repository's
 * `.vscode/settings.json` can set this key (it is window-scoped and not
 * trust-restricted), so a colour it confined to one window would silently become
 * permanent and global, in every project, and unremovable by
 * {@link clearImportedTheme}, which only takes back the ids an import recorded.
 */
function readUserCustomizations(configurationService: IConfigurationService): Readonly<Record<string, unknown>> {
	const value = configurationService.inspect<Record<string, unknown>>(COLOR_CUSTOMIZATIONS_SETTING_ID).userValue;
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

/**
 * Imports a colour theme or base16/base24 palette from the clipboard.
 *
 * The clipboard rather than a URL box, deliberately: the document is something
 * the user already has, so nothing is fetched, nothing is installed, and there
 * is no request an attacker could aim anywhere. See the threat model at the top
 * of `primalThemeImport.ts`.
 *
 * The result is merged into `workbench.colorCustomizations` — inert JSON in the
 * user's own settings file, applied on top of whatever theme is active, and
 * removable again by {@link clearImportedTheme}. It is not an installed theme,
 * and the confirmation says so.
 */
export async function importThemeFromClipboard(
	clipboardService: IClipboardService,
	configurationService: IConfigurationService,
	dialogService: IDialogService,
	notificationService: INotificationService,
	storageService: IStorageService,
	logService: ILogService
): Promise<void> {
	let text: string;
	try {
		text = await clipboardService.readText();
	} catch (error) {
		logService.error('[primalThemeGallery] Could not read the clipboard', error);
		notificationService.error(localize('primalImport.clipboardFailed', "The clipboard could not be read."));
		return;
	}

	const result = readImportedTheme(text);
	if (!result.ok) {
		notificationService.notify({
			severity: Severity.Error,
			message: localize('primalImport.refused', "That could not be imported as a theme."),
			source: formatProblems(result.problems)
		});
		return;
	}

	const theme = result.theme;
	const verdict = computeThemeReadability(createColorMapSource(theme.parsedColors, theme.scopeForegrounds));
	const presentation = describeVerdictLevel(verdict.level);

	const detail = [
		theme.kind === 'palette'
			? localize('primalImport.detail.palette', "{0} colours, mapped from the palette's own slots. A palette specifies an editor plane and a terminal ramp; it is not a full generated theme.", theme.colors.size)
			: localize('primalImport.detail.theme', "{0} colours read from the pasted theme.", theme.colors.size),
		localize('primalImport.detail.verdict', "Readability: {0}. {1}", presentation.label, describeVerdictCounts(verdict)),
		localize('primalImport.detail.where', "These are written to workbench.colorCustomizations in your own settings and layered over the theme you are using. No extension is installed and nothing is downloaded."),
		theme.problems.length > 0 ? localize('primalImport.detail.skipped', "{0} value(s) were skipped:", theme.problems.length) + '\n' + formatProblems(theme.problems) : ''
	].filter(line => line.length > 0).join('\n\n');

	const confirmation = await dialogService.confirm({
		message: localize('primalImport.confirm', "Import \"{0}\"?", theme.name),
		detail,
		primaryButton: localize('primalImport.confirmButton', "&&Import")
	});
	if (!confirmation.confirmed) {
		return;
	}

	const existing = readUserCustomizations(configurationService);
	const previousKeys = readImportedKeys(storageService);
	const merged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(existing)) {
		// Take out what the last import put in, so repeated imports do not silt up.
		if (!previousKeys.includes(key)) {
			merged[key] = value;
		}
	}
	for (const [colorId, value] of theme.colors) {
		merged[colorId] = value;
	}

	try {
		await configurationService.updateValue(COLOR_CUSTOMIZATIONS_SETTING_ID, merged, ConfigurationTarget.USER);
	} catch (error) {
		logService.error('[primalThemeGallery] Failed to write the imported colours', error);
		notificationService.error(localize('primalImport.writeFailed', "The imported colours could not be written to your settings."));
		return;
	}
	storageService.store(IMPORTED_KEYS_STORAGE_KEY, JSON.stringify([...theme.colors.keys()]), StorageScope.PROFILE, StorageTarget.USER);
	notificationService.info(localize('primalImport.done', "Imported \"{0}\". Use 'Primal Code: Remove Imported Theme Colours' to take it back out.", theme.name));
}

/** Removes exactly the colour ids the last import wrote, leaving the user's own alone. */
export async function clearImportedTheme(
	configurationService: IConfigurationService,
	notificationService: INotificationService,
	storageService: IStorageService,
	logService: ILogService
): Promise<void> {
	const keys = readImportedKeys(storageService);
	if (keys.length === 0) {
		notificationService.info(localize('primalImport.nothingToClear', "No imported theme colours are in your settings."));
		return;
	}
	const existing = readUserCustomizations(configurationService);
	const remaining: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(existing)) {
		if (!keys.includes(key)) {
			remaining[key] = value;
		}
	}
	try {
		await configurationService.updateValue(COLOR_CUSTOMIZATIONS_SETTING_ID, Object.keys(remaining).length > 0 ? remaining : undefined, ConfigurationTarget.USER);
	} catch (error) {
		logService.error('[primalThemeGallery] Failed to remove the imported colours', error);
		notificationService.error(localize('primalImport.clearFailed', "The imported colours could not be removed from your settings."));
		return;
	}
	storageService.remove(IMPORTED_KEYS_STORAGE_KEY, StorageScope.PROFILE);
	notificationService.info(localize('primalImport.cleared', "Removed {0} imported colour(s).", keys.length));
}
