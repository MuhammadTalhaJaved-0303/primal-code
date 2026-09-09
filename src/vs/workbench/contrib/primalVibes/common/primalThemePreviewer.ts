/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';

/**
 * How long a selection has to settle before the workbench repaints for it.
 *
 * Matches the built-in theme picker: arrowing through a list must not repaint
 * the whole workbench on every keystroke.
 */
export const PRIMAL_THEME_PREVIEW_DELAY_MS = 200;

/**
 * Live theme preview with revert-on-cancel, owned in one place.
 *
 * THE TARGET DISCIPLINE, which is the whole point of this class:
 *
 *   preview -> `'preview'`   transient; `applyTheme` skips storage and
 *                            `writeConfiguration` early-returns, so nothing
 *                            reaches the user's settings.
 *   revert  -> `undefined`   applies the baseline theme without writing it.
 *   apply   -> `'auto'`      the ONLY target that persists, and only on an
 *                            explicit user Apply.
 *
 * The vibe quick pick used to reach for `'auto'` on its escape path, which
 * wrote `workbench.colorTheme` to the user's settings.json every time somebody
 * opened the picker and pressed Escape — a dismissal that silently edited a file.
 * The same mistake is in upstream's own picker. Both callers of this class
 * (the quick pick and the theme gallery pane) now share one implementation so
 * the discipline cannot drift between them again.
 */
export class PrimalThemePreviewer extends Disposable {

	private readonly delayer = this._register(new Delayer<void>(PRIMAL_THEME_PREVIEW_DELAY_MS));

	private baseline: IWorkbenchColorTheme;
	private previewInFlight = false;
	private previewedSettingsId: string | undefined;

	constructor(
		private readonly themeService: IWorkbenchThemeService,
		private readonly logService: ILogService
	) {
		super();
		this.baseline = this.themeService.getColorTheme();
		this._register(this.themeService.onDidColorThemeChange(theme => this.onColorThemeChanged(theme)));
	}

	/**
	 * Abandons a preview that something else has already overwritten.
	 *
	 * A preview is not the only way the workbench's theme can change while this
	 * previewer is alive: a vibe cycle command, the built-in picker or a settings
	 * edit can all apply a theme for real, and persist it. Without this, the
	 * previewer would still believe its own preview was on screen and its stale
	 * baseline was the user's choice, and the next {@link revert} — on Escape, on
	 * the pane being hidden, on the pane closing — would repaint the workbench
	 * back to a theme the user had already moved on from, leaving the display
	 * disagreeing with `workbench.colorTheme` until the next reload.
	 *
	 * Anything that is neither the theme this previewer asked to preview nor the
	 * baseline it would revert to came from somewhere else, so it becomes the new
	 * baseline and there is nothing left to revert.
	 */
	private onColorThemeChanged(theme: IWorkbenchColorTheme): void {
		if (theme.settingsId === this.previewedSettingsId || theme.settingsId === this.baseline.settingsId) {
			return;
		}
		this.delayer.cancel();
		this.previewInFlight = false;
		this.previewedSettingsId = undefined;
		this.baseline = theme;
	}

	/** The theme {@link revert} returns to. */
	get baselineTheme(): IWorkbenchColorTheme {
		return this.baseline;
	}

	/**
	 * The settings id of the theme currently on screen as a preview, or
	 * `undefined` when the workbench is wearing the user's own choice.
	 *
	 * The single source of truth for anything that draws a "previewing" marker:
	 * a preview can end without the marker's owner asking for it — reverted,
	 * applied, or superseded by another route entirely.
	 */
	get previewedTheme(): string | undefined {
		return this.previewInFlight ? this.previewedSettingsId : undefined;
	}

	/**
	 * Re-reads the currently applied theme as the theme to revert to.
	 *
	 * Callers must do this whenever they (re)gain control — a pane becoming
	 * visible, a picker opening — because the user may have changed themes by
	 * some other route in the meantime, and reverting to a stale baseline would
	 * be the pane undoing a change it never made.
	 */
	captureBaseline(): void {
		if (!this.previewInFlight) {
			this.baseline = this.themeService.getColorTheme();
		}
	}

	/**
	 * Previews a theme after the settle delay. Passing `undefined` cancels a
	 * pending preview without reverting one that already took effect.
	 */
	preview(theme: IWorkbenchColorTheme | undefined): void {
		if (!theme) {
			this.delayer.cancel();
			return;
		}
		if (theme.settingsId === this.baseline.settingsId && !this.previewInFlight) {
			this.delayer.cancel();
			return; // already looking at it
		}
		this.delayer.trigger(async () => {
			this.previewInFlight = true;
			this.previewedSettingsId = theme.settingsId;
			try {
				await this.themeService.setColorTheme(theme, 'preview');
			} catch (error) {
				this.logService.error('[primalThemePreviewer] Failed to preview a color theme', error);
				await this.revert();
			}
		}).catch(() => {
			// A cancelled delayer rejects by design; nothing to report.
		});
	}

	/**
	 * Returns to the baseline theme. Safe to call when nothing is being
	 * previewed, and safe to call twice.
	 */
	async revert(): Promise<void> {
		this.delayer.cancel();
		if (!this.previewInFlight) {
			return;
		}
		this.previewInFlight = false;
		this.previewedSettingsId = undefined;
		try {
			await this.themeService.setColorTheme(this.baseline, undefined);
		} catch (error) {
			this.logService.error('[primalThemePreviewer] Failed to revert a previewed color theme', error);
		}
	}

	/**
	 * Applies a theme for real, persisting it, and makes it the new baseline.
	 * This is the only path that writes the user's settings.
	 */
	async apply(theme: IWorkbenchColorTheme): Promise<void> {
		this.delayer.cancel();
		this.previewInFlight = false;
		this.previewedSettingsId = undefined;
		await this.themeService.setColorTheme(theme, 'auto');
		this.baseline = this.themeService.getColorTheme();
	}

	/**
	 * Records that something else applied a theme (a vibe, say, which moves three
	 * theme slots at once and therefore cannot go through {@link apply}).
	 */
	adoptAppliedTheme(): void {
		this.delayer.cancel();
		this.previewInFlight = false;
		this.previewedSettingsId = undefined;
		this.baseline = this.themeService.getColorTheme();
	}

	override dispose(): void {
		// A pane torn down mid-preview must not leave the workbench wearing a
		// theme the user never chose.
		void this.revert();
		super.dispose();
	}
}
