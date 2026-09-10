/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { PRIMAL_THEME_GALLERY_COMMAND_ID } from '../../primalThemeGallery/common/primalThemeGallery.js';
import { PrimalThemePreviewer } from '../common/primalThemePreviewer.js';
import { IPrimalVibe, IPrimalVibeService, PRIMAL_VIBES, PRIMAL_VIBE_SETTING_ID, PRIMAL_VIBE_STORAGE_KEY } from './primalVibes.js';

interface IVibeQuickPickItem extends IQuickPickItem {
	/** Absent on the "browse all themes" entry. */
	readonly vibe?: IPrimalVibe;
	readonly colorTheme?: IWorkbenchColorTheme;
	/** Set on the entry that leaves the picker for the full gallery. */
	readonly browse?: boolean;
}

/**
 * Applies vibes (color theme + product icon theme + file icon theme) through
 * {@link IWorkbenchThemeService} with USER persistence, and tracks which vibe
 * the active color theme corresponds to.
 */
export class PrimalVibeService extends Disposable implements IPrimalVibeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeVibe = this._register(new Emitter<IPrimalVibe | undefined>());
	readonly onDidChangeVibe: Event<IPrimalVibe | undefined> = this._onDidChangeVibe.event;

	private lastNotifiedVibeId: string | undefined;

	constructor(
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.lastNotifiedVibeId = this.currentVibe?.id;
		this._register(this.themeService.onDidColorThemeChange(() => {
			const vibe = this.currentVibe;
			if (vibe?.id !== this.lastNotifiedVibeId) {
				this.lastNotifiedVibeId = vibe?.id;
				this._onDidChangeVibe.fire(vibe);
			}
		}));
	}

	get currentVibe(): IPrimalVibe | undefined {
		const settingsId = this.themeService.getColorTheme().settingsId;
		return PRIMAL_VIBES.find(vibe => vibe.colorTheme === settingsId);
	}

	async applyVibe(id: string): Promise<void> {
		const vibe = PRIMAL_VIBES.find(candidate => candidate.id === id);
		if (!vibe) {
			this.logService.error(`[primalVibes] Unknown vibe id '${id}'`);
			this.notificationService.error(localize('vibes.unknownVibe', "Unknown vibe '{0}'.", id));
			return;
		}

		const colorTheme = await this.findColorTheme(vibe);
		if (!colorTheme) {
			this.logService.error(`[primalVibes] Color theme '${vibe.colorTheme}' for vibe '${vibe.id}' is not installed`);
			this.notificationService.error(localize('vibes.missingTheme', "The color theme '{0}' for the vibe '{1}' is not installed.", vibe.colorTheme, vibe.label));
			return;
		}

		try {
			await this.themeService.setColorTheme(colorTheme, ConfigurationTarget.USER);
			await this.applyIconThemes(vibe);
		} catch (error) {
			this.logService.error(`[primalVibes] Failed to apply vibe '${vibe.id}'`, error);
			this.notificationService.error(localize('vibes.applyFailed', "Failed to apply the vibe '{0}'.", vibe.label));
			return;
		}

		this.storageService.store(PRIMAL_VIBE_STORAGE_KEY, vibe.id, StorageScope.APPLICATION, StorageTarget.USER);
		try {
			await this.configurationService.updateValue(PRIMAL_VIBE_SETTING_ID, vibe.id, ConfigurationTarget.USER);
		} catch (error) {
			this.logService.warn(`[primalVibes] Failed to persist '${PRIMAL_VIBE_SETTING_ID}'`, error);
		}
	}

	async cycleVibe(): Promise<void> {
		const startId = this.currentVibe?.id ?? this.storageService.get(PRIMAL_VIBE_STORAGE_KEY, StorageScope.APPLICATION);
		const startIndex = PRIMAL_VIBES.findIndex(vibe => vibe.id === startId);
		const nextVibe = PRIMAL_VIBES[(startIndex + 1) % PRIMAL_VIBES.length];
		await this.applyVibe(nextVibe.id);
	}

	async pickVibe(): Promise<void> {
		const colorThemes = await this.themeService.getColorThemes();
		const currentVibe = this.currentVibe;

		const picks: (IVibeQuickPickItem | IQuickPickSeparator)[] = PRIMAL_VIBES.map(vibe => {
			const colorTheme = colorThemes.find(theme => theme.settingsId === vibe.colorTheme);
			const mode = vibe.mode === 'dark'
				? localize('vibes.mode.dark', "dark")
				: localize('vibes.mode.light', "light");
			const isCurrent = vibe.id === currentVibe?.id;
			return {
				id: vibe.id,
				vibe,
				colorTheme,
				// The applied vibe is marked in the LABEL, in words. It used to be
				// signalled only by `activeItems`, which is a background highlight
				// that is also just where the cursor happens to start: arrow once and
				// there was nothing left to say which vibe you are actually wearing.
				// A colour-blind user never had that signal at all.
				label: isCurrent ? localize('vibes.currentLabel', "{0} — current", vibe.label) : vibe.label,
				description: colorTheme ? mode : localize('vibes.notInstalled', "theme not installed")
			};
		});

		picks.push({ type: 'separator' });
		picks.push({
			id: 'primal.browseThemes',
			browse: true,
			label: localize('vibes.browseAll', "Browse all themes..."),
			description: localize('vibes.browseAllDescription', "{0} colour themes, searchable, with a readability check", colorThemes.length)
		});

		const previewer = new PrimalThemePreviewer(this.themeService, this.logService);
		const disposables = new DisposableStore();
		disposables.add(previewer);

		await new Promise<void>(resolve => {
			let isCompleted = false;
			const quickpick = disposables.add(this.quickInputService.createQuickPick<IVibeQuickPickItem>({ useSeparators: true }));
			quickpick.items = picks;
			quickpick.title = localize('vibes.pick.title', "Choose Vibe");
			// The preview is deliberately partial and says so: only the colour theme
			// moves while you arrow, because swapping the product and file icon
			// themes on every keystroke is not something to do speculatively.
			quickpick.placeholder = localize('vibes.pick.placeholder', "Select a vibe (Up/Down previews its colours; icons change on Enter)");
			quickpick.canSelectMany = false;
			quickpick.matchOnDescription = true;
			const activeItem = picks.find((pick): pick is IVibeQuickPickItem => pick.type !== 'separator' && pick.vibe?.id === currentVibe?.id);
			if (activeItem) {
				quickpick.activeItems = [activeItem];
			}
			disposables.add(quickpick.onDidChangeActive(items => previewer.preview(items[0]?.colorTheme)));
			disposables.add(quickpick.onDidAccept(async () => {
				isCompleted = true;
				const pick = quickpick.selectedItems[0];
				quickpick.hide();
				if (pick?.browse) {
					await previewer.revert();
					await this.commandService.executeCommand(PRIMAL_THEME_GALLERY_COMMAND_ID);
				} else if (pick?.vibe && pick.colorTheme) {
					await this.applyVibe(pick.vibe.id);
					previewer.adoptAppliedTheme();
				} else {
					await previewer.revert(); // vibe theme missing: put back what was there
				}
				resolve();
			}));
			disposables.add(quickpick.onDidHide(() => {
				if (!isCompleted) {
					// Escape reverts WITHOUT persisting. This used to run through the
					// apply path, whose target resolves to 'auto', so dismissing the
					// picker wrote workbench.colorTheme into the user's settings.json.
					previewer.revert().catch(error => this.logService.error('[primalVibes] Failed to revert the vibe preview', error));
					resolve();
				}
			}));
			quickpick.show();
		}).finally(() => disposables.dispose());
	}

	private async findColorTheme(vibe: IPrimalVibe): Promise<IWorkbenchColorTheme | undefined> {
		const colorThemes = await this.themeService.getColorThemes();
		return colorThemes.find(theme => theme.settingsId === vibe.colorTheme);
	}

	private async applyIconThemes(vibe: IPrimalVibe): Promise<void> {
		const productIconThemes = await this.themeService.getProductIconThemes();
		const productIconTheme = productIconThemes.find(theme => theme.settingsId === vibe.productIconTheme);
		if (productIconTheme) {
			await this.themeService.setProductIconTheme(productIconTheme, ConfigurationTarget.USER);
		} else {
			this.logService.warn(`[primalVibes] Product icon theme '${vibe.productIconTheme}' is not installed, keeping the current one`);
		}

		if (vibe.fileIconTheme) {
			const fileIconThemes = await this.themeService.getFileIconThemes();
			const fileIconTheme = fileIconThemes.find(theme => theme.settingsId === vibe.fileIconTheme);
			if (fileIconTheme) {
				await this.themeService.setFileIconTheme(fileIconTheme, ConfigurationTarget.USER);
			} else {
				this.logService.warn(`[primalVibes] File icon theme '${vibe.fileIconTheme}' is not installed, keeping the current one`);
			}
		}
	}
}
