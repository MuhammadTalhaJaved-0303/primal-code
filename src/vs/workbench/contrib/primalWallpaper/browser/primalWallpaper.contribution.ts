/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalWallpaper.css';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import {
	PRIMAL_WALLPAPER_DEFAULT_IMAGE_PATH,
	PRIMAL_WALLPAPER_DEFAULT_MODE,
	PRIMAL_WALLPAPER_DEFAULT_OPACITY,
	PRIMAL_WALLPAPER_DEFAULT_TINT_SLABS,
	PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID,
	PRIMAL_WALLPAPER_MAX_OPACITY,
	PRIMAL_WALLPAPER_MIN_OPACITY,
	PRIMAL_WALLPAPER_MODES,
	PRIMAL_WALLPAPER_MODE_SETTING_ID,
	PRIMAL_WALLPAPER_OPACITY_SETTING_ID,
	PRIMAL_WALLPAPER_TINT_SLABS_SETTING_ID
} from './primalWallpaper.js';
import { PrimalWallpaperContribution } from './primalWallpaperService.js';

// --- settings --------------------------------------------------------------

// All four are `APPLICATION` scoped, like `primalCode.vibe`: the wallpaper is
// window chrome rather than anything about the code being edited, and keeping
// `imagePath` out of workspace settings means opening a folder can never point
// the renderer at a file on this machine.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'primalCode',
	title: localize('primalCode.settings', "Primal Code"),
	properties: {
		[PRIMAL_WALLPAPER_MODE_SETTING_ID]: {
			type: 'string',
			enum: [...PRIMAL_WALLPAPER_MODES],
			enumDescriptions: [
				localize('primalCode.wallpaper.mode.ambient', "A soft wash and a fine grain, generated from the colors of the active theme. Ships no image, and always matches the vibe."),
				localize('primalCode.wallpaper.mode.image', "Your own artwork, from the 'Wallpaper: Image Path' setting. Falls back to 'ambient' if the image cannot be used."),
				localize('primalCode.wallpaper.mode.off', "Leave the ground unpainted.")
			],
			default: PRIMAL_WALLPAPER_DEFAULT_MODE,
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.wallpaper.mode', "What to paint in the window ground, the frame around and behind the editor, side bar, auxiliary bar and panel. The wallpaper never sits behind code."),
		},
		[PRIMAL_WALLPAPER_IMAGE_PATH_SETTING_ID]: {
			type: 'string',
			default: PRIMAL_WALLPAPER_DEFAULT_IMAGE_PATH,
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.wallpaper.imagePath', "The image to use when 'Wallpaper: Mode' is 'image'. An absolute file path, a 'file:' URI, or a 'data:' image URI. Anything else, or an image that cannot be read, falls back to the ambient wallpaper."),
		},
		[PRIMAL_WALLPAPER_OPACITY_SETTING_ID]: {
			type: 'number',
			default: PRIMAL_WALLPAPER_DEFAULT_OPACITY,
			minimum: PRIMAL_WALLPAPER_MIN_OPACITY,
			maximum: PRIMAL_WALLPAPER_MAX_OPACITY,
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.wallpaper.opacity', "How strongly the wallpaper is painted. Capped so that no value can make the chrome hard to read."),
		},
		[PRIMAL_WALLPAPER_TINT_SLABS_SETTING_ID]: {
			type: 'boolean',
			default: PRIMAL_WALLPAPER_DEFAULT_TINT_SLABS,
			scope: ConfigurationScope.APPLICATION,
			description: localize('primalCode.wallpaper.tintSlabs', "Let a hint of the wallpaper through the side bar, auxiliary bar and panel. Never applies to the editor, so code always sits on an opaque surface."),
		},
	},
});

// --- contribution ----------------------------------------------------------

// `BlockRestore` for the same reason the other chrome contributions use it: the
// ground has to be right in the first painted frame, or the window visibly
// changes color after it opens. The contribution's constructor only appends one
// element per window and writes a few custom properties onto it, so it adds no
// measurable work to startup and never waits on anything.
registerWorkbenchContribution2(PrimalWallpaperContribution.ID, PrimalWallpaperContribution, WorkbenchPhase.BlockRestore);
