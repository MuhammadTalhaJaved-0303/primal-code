/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { isHighContrast } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPrimalVibeService } from '../../primalVibes/browser/primalVibes.js';
import {
	PRIMAL_WALLPAPER_GRAIN_PROPERTY,
	PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID,
	PRIMAL_WALLPAPER_IMAGE_PROPERTY,
	PRIMAL_WALLPAPER_LAYER_CLASS,
	PRIMAL_WALLPAPER_MODE_SETTING_ID,
	PRIMAL_WALLPAPER_NO_IMAGE,
	PRIMAL_WALLPAPER_ON_CLASS,
	PRIMAL_WALLPAPER_OPACITY_PROPERTY,
	PRIMAL_WALLPAPER_OPACITY_SETTING_ID,
	PRIMAL_WALLPAPER_SETTING_IDS,
	PRIMAL_WALLPAPER_SIZE_PROPERTY,
	PRIMAL_WALLPAPER_TINT_CLASS,
	PRIMAL_WALLPAPER_TINT_SLABS_SETTING_ID,
	clampWallpaperOpacity,
	toWallpaperMode
} from './primalWallpaper.js';
import { composeAmbientWash, getWallpaperGrainImage, parseWallpaperImagePath, toWallpaperImageValue } from './primalWallpaperPaint.js';

/** One resolved paint, recomputed from scratch on every update. */
interface IWallpaperPaint {
	/** Whether the layer paints at all. When false the ground is untouched. */
	readonly enabled: boolean;
	/** `background-image` of the layer: the ambient wash, or the user's image. */
	readonly image: string;
	/** `background-size` of the layer. */
	readonly size: string;
	/** `background-image` of the grain sub-layer, or `none`. */
	readonly grain: string;
	/** Clamped intensity, applied as the layer's `opacity`. */
	readonly opacity: number;
	/** Whether the side bar, auxiliary bar and panel slabs let a hint through. */
	readonly tintSlabs: boolean;
}

const NO_PAINT: IWallpaperPaint = Object.freeze({
	enabled: false,
	image: PRIMAL_WALLPAPER_NO_IMAGE,
	size: 'auto',
	grain: PRIMAL_WALLPAPER_NO_IMAGE,
	opacity: 0,
	tintSlabs: false
});

/**
 * Paints the wallpaper into the workbench ground (`primal/design/atmosphere-spec.md`,
 * section B).
 *
 * WHERE IT SITS. The slab chrome recessed the window into a ground that the
 * title bar and status bar merge into (`primalVibes/browser/media/primalChrome.css`,
 * section 1: it paints the workbench background from the title bar token, and
 * the two bars paint the same tone on themselves). This contribution appends a
 * single element to each workbench container and the stylesheet gives it
 * `z-index: -1`, so it paints over the container's own background and under
 * every part. The four slabs — editor, side bar, auxiliary bar, panel — stay
 * opaque on top of it, which is what makes legibility structural: the wallpaper
 * can never end up behind code.
 *
 * WHY IT IS A CONTRIBUTION AND NOT A SERVICE. Nothing else in the workbench
 * needs to read or drive the wallpaper, so there is no interface to inject; the
 * file is named for the deliverable it satisfies.
 *
 * COST. The paint is static: no animation, no timers, no per-frame work, and
 * the grain data URI is built once and memoized. An update is a handful of
 * custom property writes on an element that is already in the DOM.
 */
export class PrimalWallpaperContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalWallpaper';

	/** The layer element for each workbench container (main and auxiliary windows). */
	private readonly layers = new Map<HTMLElement, HTMLElement>();

	/**
	 * Bumped on every paint, so an image validation that resolves after the
	 * settings changed again cannot overwrite the newer paint.
	 */
	private paintGeneration = 0;

	/**
	 * The raw `imagePath` value that could not be used, kept so the ambient
	 * fallback does not re-run the same failing validation (or re-log it) on
	 * every subsequent repaint. Cleared when the setting itself changes.
	 */
	private rejectedImagePath: string | undefined;

	/**
	 * The raw `imagePath` value already confirmed to be readable, so a repaint
	 * caused by something else (a theme change, say) does not stat the file
	 * again. Cleared when the setting itself changes.
	 */
	private verifiedImagePath: string | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IThemeService private readonly themeService: IThemeService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._register(toDisposable(() => this.clearLayers()));

		// The ambient wash is derived from the active theme, so any color theme
		// change repaints it.
		this._register(this.themeService.onDidColorThemeChange(() => this.paint()));

		// A vibe change always arrives as a color theme change too, so this is
		// belt and braces; it costs one idempotent repaint and keeps the vibe
		// engine as the explicit upstream of the look.
		this._register(this.vibeService.onDidChangeVibe(() => this.paint()));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (!PRIMAL_WALLPAPER_SETTING_IDS.some(settingId => e.affectsConfiguration(settingId))) {
				return;
			}

			if (e.affectsConfiguration(PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID)) {
				// A new path deserves a fresh check, in both directions.
				this.rejectedImagePath = undefined;
				this.verifiedImagePath = undefined;
			}

			this.paint();
		}));

		// Auxiliary windows are painted too (see `ensureLayer`). Their element is
		// removed with the window, through the window-scoped disposables.
		this._register(this.layoutService.onDidAddContainer(({ container, disposables }) => {
			disposables.add(toDisposable(() => this.removeLayer(container)));
			this.paint();
		}));

		this.paint();
	}

	private paint(): void {
		const generation = ++this.paintGeneration;
		const resolved = this.resolvePaint(generation);

		for (const container of this.layoutService.containers) {
			this.applyTo(container, resolved);
		}
	}

	private resolvePaint(generation: number): IWallpaperPaint {
		const mode = toWallpaperMode(this.configurationService.getValue<unknown>(PRIMAL_WALLPAPER_MODE_SETTING_ID));
		const opacity = clampWallpaperOpacity(this.configurationService.getValue<unknown>(PRIMAL_WALLPAPER_OPACITY_SETTING_ID));
		const tintSlabs = this.configurationService.getValue<unknown>(PRIMAL_WALLPAPER_TINT_SLABS_SETTING_ID) === true;
		const theme = this.themeService.getColorTheme();

		// High contrast opts out entirely (atmosphere-spec.md, non-negotiables).
		// The stylesheet guards this as well; bailing here means no paint is even
		// composed.
		if (mode === 'off' || opacity === 0 || isHighContrast(theme.type)) {
			return NO_PAINT;
		}

		if (mode === 'image') {
			const image = this.resolveImage(generation);
			if (image) {
				return { enabled: true, image, size: 'cover', grain: PRIMAL_WALLPAPER_NO_IMAGE, opacity, tintSlabs };
			}
			// Anything the image path cannot deliver falls through to ambient,
			// silently as far as the UI is concerned. `resolveImage` has logged.
		}

		const wash = composeAmbientWash(theme);
		if (!wash) {
			this.logService.debug('[primalWallpaper] The active theme defines no foreground color, painting nothing');
			return NO_PAINT;
		}

		return { enabled: true, image: wash, size: 'auto', grain: getWallpaperGrainImage(), opacity, tintSlabs };
	}

	/**
	 * The `background-image` for `image` mode, or `undefined` to fall back to
	 * ambient. Never throws and never waits: the syntactic check is synchronous,
	 * and whether the file actually exists is confirmed afterwards, off the
	 * startup path.
	 */
	private resolveImage(generation: number): string | undefined {
		const configured = this.configurationService.getValue<unknown>(PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID);
		const rawPath = typeof configured === 'string' ? configured : '';

		if (!rawPath.trim()) {
			this.logService.debug(`[primalWallpaper] '${PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID}' is empty, using the ambient wallpaper`);
			return undefined;
		}

		if (rawPath === this.rejectedImagePath) {
			return undefined; // already rejected and reported for this exact value
		}

		const uri = parseWallpaperImagePath(rawPath);
		if (!uri) {
			this.logService.warn(`[primalWallpaper] '${PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID}' must be an absolute path, a file: URI or a data: image URI, got '${rawPath}'. Using the ambient wallpaper`);
			this.rejectedImagePath = rawPath;
			return undefined;
		}

		// Not awaited: a paint must never wait on the disk. The rejection sink is
		// there so a failure inside the validation can never surface as an
		// unhandled rejection, which the workbench would report to the user.
		this.verifyImage(uri, rawPath, generation)
			.catch(error => this.logService.warn('[primalWallpaper] Failed to validate the wallpaper image', error));

		return toWallpaperImageValue(uri);
	}

	/**
	 * Confirms that a `file:` wallpaper is actually readable, and repaints as
	 * ambient if it is not. Deliberately not awaited by the caller: a missing
	 * image must never delay or break a paint.
	 */
	private async verifyImage(uri: URI, rawPath: string, generation: number): Promise<void> {
		if (uri.scheme !== Schemas.file) {
			return; // a data: URI carries its own bytes, there is nothing to check
		}

		if (rawPath === this.verifiedImagePath) {
			return; // confirmed readable already
		}

		try {
			if (await this.fileService.exists(uri)) {
				this.verifiedImagePath = rawPath;
				return;
			}

			this.logService.warn(`[primalWallpaper] The wallpaper image '${rawPath}' does not exist, using the ambient wallpaper`);
		} catch (error) {
			this.logService.warn(`[primalWallpaper] Failed to read the wallpaper image '${rawPath}', using the ambient wallpaper`, error);
		}

		if (generation !== this.paintGeneration) {
			return; // a newer paint has already replaced this one
		}

		this.rejectedImagePath = rawPath;
		this.paint();
	}

	private applyTo(container: HTMLElement, paint: IWallpaperPaint): void {
		const layer = this.ensureLayer(container);

		layer.style.setProperty(PRIMAL_WALLPAPER_IMAGE_PROPERTY, paint.image);
		layer.style.setProperty(PRIMAL_WALLPAPER_SIZE_PROPERTY, paint.size);
		layer.style.setProperty(PRIMAL_WALLPAPER_GRAIN_PROPERTY, paint.grain);
		layer.style.setProperty(PRIMAL_WALLPAPER_OPACITY_PROPERTY, String(paint.opacity));

		container.classList.toggle(PRIMAL_WALLPAPER_ON_CLASS, paint.enabled);
		container.classList.toggle(PRIMAL_WALLPAPER_TINT_CLASS, paint.enabled && paint.tintSlabs);
	}

	/**
	 * The one element per container, appended once and then only updated.
	 *
	 * It is created in the main window's document on purpose: auxiliary windows
	 * forbid `createElement` in their own context (auxiliaryWindowService.ts) and
	 * the node is adopted when it is appended into their container.
	 */
	private ensureLayer(container: HTMLElement): HTMLElement {
		let layer = this.layers.get(container);
		if (!layer) {
			layer = $<HTMLElement>(`div.${PRIMAL_WALLPAPER_LAYER_CLASS}`, { 'aria-hidden': 'true' });
			container.appendChild(layer);
			this.layers.set(container, layer);
		}

		return layer;
	}

	private removeLayer(container: HTMLElement): void {
		this.layers.get(container)?.remove();
		this.layers.delete(container);
		container.classList.remove(PRIMAL_WALLPAPER_ON_CLASS, PRIMAL_WALLPAPER_TINT_CLASS);
	}

	/** Leaves no element and no class behind on any container. */
	private clearLayers(): void {
		for (const container of [...this.layers.keys()]) {
			this.removeLayer(container);
		}
	}
}
