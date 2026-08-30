/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IPrimalVibe, IPrimalVibeService, PRIMAL_VIBES, PRIMAL_VIBE_SETTING_ID, PRIMAL_VIBE_STORAGE_KEY } from './primalVibes.js';

interface IVibeQuickPickItem extends IQuickPickItem {
	readonly vibe: IPrimalVibe;
	readonly colorTheme: IWorkbenchColorTheme | undefined;
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
		const currentColorTheme = this.themeService.getColorTheme();
		const currentVibe = this.currentVibe;

		const picks: IVibeQuickPickItem[] = PRIMAL_VIBES.map(vibe => {
			const colorTheme = colorThemes.find(theme => theme.settingsId === vibe.colorTheme);
			return {
				id: vibe.id,
				vibe,
				colorTheme,
				label: vibe.label,
				description: colorTheme
					? (vibe.mode === 'dark' ? localize('vibes.mode.dark', "dark") : localize('vibes.mode.light', "light"))
					: localize('vibes.notInstalled', "theme not installed")
			};
		});

		// Replicates the live-preview pattern of the built-in theme picker
		// (themes.contribution.ts): debounce previews by 200ms, apply
		// immediately on accept, revert to the current theme when dismissed.
		let previewTimeout: number | undefined;
		const previewOrApply = (theme: IWorkbenchColorTheme | undefined, apply: boolean) => {
			if (previewTimeout) {
				mainWindow.clearTimeout(previewTimeout);
			}
			previewTimeout = mainWindow.setTimeout(() => {
				previewTimeout = undefined;
				this.themeService.setColorTheme(theme ?? currentColorTheme, apply ? 'auto' : 'preview')
					.then(undefined, error => {
						this.logService.error('[primalVibes] Failed to preview vibe theme', error);
						this.themeService.setColorTheme(currentColorTheme, undefined);
					});
			}, apply ? 0 : 200);
		};

		const disposables = new DisposableStore();
		await new Promise<void>(resolve => {
			let isCompleted = false;
			const quickpick = disposables.add(this.quickInputService.createQuickPick<IVibeQuickPickItem>());
			quickpick.items = picks;
			quickpick.title = localize('vibes.pick.title', "Choose Vibe");
			quickpick.placeholder = localize('vibes.pick.placeholder', "Select Vibe (Up/Down Keys to Preview)");
			quickpick.canSelectMany = false;
			quickpick.matchOnDescription = true;
			const activeItem = picks.find(pick => pick.vibe.id === currentVibe?.id);
			if (activeItem) {
				quickpick.activeItems = [activeItem];
			}
			disposables.add(quickpick.onDidChangeActive(items => previewOrApply(items[0]?.colorTheme, false)));
			disposables.add(quickpick.onDidAccept(async () => {
				isCompleted = true;
				const pick = quickpick.selectedItems[0];
				quickpick.hide();
				if (pick?.colorTheme) {
					await this.applyVibe(pick.vibe.id);
				} else {
					previewOrApply(currentColorTheme, true); // vibe theme missing: restore
				}
				resolve();
			}));
			disposables.add(quickpick.onDidHide(() => {
				if (!isCompleted) {
					previewOrApply(currentColorTheme, true); // escape: revert preview
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
