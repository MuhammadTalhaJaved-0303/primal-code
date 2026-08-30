/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * A vibe bundles a whole-IDE look: workbench color theme, product icon theme
 * and file icon theme, applied atomically and persisted to user settings.
 *
 * The definitions mirror `primal/design/vibe-tokens.json` (the binding
 * contract): vibe ids, labels and shortcuts must stay in sync with it.
 */
export interface IPrimalVibe {
	/** Stable vibe id from the contract (e.g. 'basalt'). */
	readonly id: string;
	/** Display label, also the color theme settings id (e.g. 'Primal Basalt'). */
	readonly label: string;
	/** Whether the vibe is a light or dark look. */
	readonly mode: 'light' | 'dark';
	/** Settings id of the workbench color theme (`workbench.colorTheme`). */
	readonly colorTheme: string;
	/** Settings id of the product icon theme (`workbench.productIconTheme`). */
	readonly productIconTheme: string;
	/** Settings id of the file icon theme (`workbench.iconTheme`), if the vibe specifies one. */
	readonly fileIconTheme?: string;
}

/** All vibes share our product icon theme (contract: `productIconTheme`). */
export const PRIMAL_VIBE_PRODUCT_ICON_THEME = 'primal-icons';

/** The file icon theme that ships as default (`ThemeSettingDefaults.FILE_ICON_THEME`). */
export const PRIMAL_VIBE_FILE_ICON_THEME = 'vs-seti';

/**
 * The six launch vibes, mirroring `primal/design/vibe-tokens.json`.
 * Color theme settings ids equal the vibe labels (theme JSONs omit an `id`,
 * so the label becomes the settings id).
 */
export const PRIMAL_VIBES: readonly IPrimalVibe[] = Object.freeze([
	Object.freeze({ id: 'ink', label: 'Primal Ink', mode: 'light' as const, colorTheme: 'Primal Ink', productIconTheme: PRIMAL_VIBE_PRODUCT_ICON_THEME, fileIconTheme: PRIMAL_VIBE_FILE_ICON_THEME }),
	Object.freeze({ id: 'basalt', label: 'Primal Basalt', mode: 'dark' as const, colorTheme: 'Primal Basalt', productIconTheme: PRIMAL_VIBE_PRODUCT_ICON_THEME, fileIconTheme: PRIMAL_VIBE_FILE_ICON_THEME }),
	Object.freeze({ id: 'tide', label: 'Primal Tide', mode: 'dark' as const, colorTheme: 'Primal Tide', productIconTheme: PRIMAL_VIBE_PRODUCT_ICON_THEME, fileIconTheme: PRIMAL_VIBE_FILE_ICON_THEME }),
	Object.freeze({ id: 'dusk', label: 'Primal Dusk', mode: 'dark' as const, colorTheme: 'Primal Dusk', productIconTheme: PRIMAL_VIBE_PRODUCT_ICON_THEME, fileIconTheme: PRIMAL_VIBE_FILE_ICON_THEME }),
	Object.freeze({ id: 'fern', label: 'Primal Fern', mode: 'dark' as const, colorTheme: 'Primal Fern', productIconTheme: PRIMAL_VIBE_PRODUCT_ICON_THEME, fileIconTheme: PRIMAL_VIBE_FILE_ICON_THEME }),
	Object.freeze({ id: 'ridge', label: 'Primal Ridge', mode: 'light' as const, colorTheme: 'Primal Ridge', productIconTheme: PRIMAL_VIBE_PRODUCT_ICON_THEME, fileIconTheme: PRIMAL_VIBE_FILE_ICON_THEME })
]);

/** User setting that records the last applied vibe id. */
export const PRIMAL_VIBE_SETTING_ID = 'primalCode.vibe';

/** Storage key mirroring the applied vibe id (application scope). */
export const PRIMAL_VIBE_STORAGE_KEY = 'primalCode.vibe.current';

export const PRIMAL_VIBE_CYCLE_COMMAND_ID = 'primalCode.vibes.cycle';
export const PRIMAL_VIBE_PICK_COMMAND_ID = 'primalCode.vibes.pick';

export const IPrimalVibeService = createDecorator<IPrimalVibeService>('primalVibeService');

export interface IPrimalVibeService {
	readonly _serviceBrand: undefined;

	/**
	 * The vibe whose color theme matches the currently active color theme, or
	 * `undefined` when the user switched to a theme outside any vibe ("Custom").
	 */
	readonly currentVibe: IPrimalVibe | undefined;

	/**
	 * Fires when the effective vibe changes — through {@link applyVibe} or a
	 * manual color theme change outside the vibe engine.
	 */
	readonly onDidChangeVibe: Event<IPrimalVibe | undefined>;

	/**
	 * Applies all theme slots of the given vibe with USER persistence and
	 * records the vibe id in storage and the `primalCode.vibe` setting.
	 */
	applyVibe(id: string): Promise<void>;

	/** Applies the next vibe in contract order, starting after the current one. */
	cycleVibe(): Promise<void>;

	/** Opens the vibe quick pick with live preview on focus and revert on escape. */
	pickVibe(): Promise<void>;
}
