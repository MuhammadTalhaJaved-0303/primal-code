/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import {
	IPrimalThemeDescriptor,
	IPrimalVibeReference,
	IPrimalThemeEntry,
	PRIMAL_THEME_EXTENSION_ID,
	PRIMAL_THEME_LABEL_PREFIX,
	PrimalThemeGrouping,
	PrimalThemeMode,
	PrimalThemeSource
} from './primalThemeGallery.js';

/**
 * The catalogue: classification, search and grouping for the theme gallery.
 *
 * Pure by construction — it takes descriptors and the vibe list and returns new
 * arrays. `PRIMAL_VIBES` stays the single vibe list; this reads it and never
 * forks it.
 */

/** The depth suffixes the corpus generator appends to a family name. */
const CORPUS_VARIANTS: readonly string[] = ['Soft', 'Hard'];

/** The family a theme with no recognisable family is filed under. */
function installedFamily(): string {
	return localize('primalGallery.family.installed', "Installed");
}

/** The mode facet, derived from the theme's own colour scheme. */
export function modeOf(type: ColorScheme): PrimalThemeMode {
	switch (type) {
		case ColorScheme.LIGHT: return 'light';
		case ColorScheme.HIGH_CONTRAST_DARK: return 'highContrastDark';
		case ColorScheme.HIGH_CONTRAST_LIGHT: return 'highContrastLight';
		default: return 'dark';
	}
}

/** The mode as a WORD, which is how the card states it — never as a colour. */
export function modeLabel(mode: PrimalThemeMode): string {
	switch (mode) {
		case 'light': return localize('primalGallery.mode.light', "Light");
		case 'highContrastDark': return localize('primalGallery.mode.hcDark', "High contrast dark");
		case 'highContrastLight': return localize('primalGallery.mode.hcLight', "High contrast light");
		default: return localize('primalGallery.mode.dark', "Dark");
	}
}

/** What applying a theme of this source actually moves, in words. */
export function sourceLabel(source: PrimalThemeSource): string {
	switch (source) {
		case 'vibe': return localize('primalGallery.source.vibe', "Vibe — colours and icons");
		case 'corpus': return localize('primalGallery.source.corpus', "Theme only — icons unchanged");
		default: return localize('primalGallery.source.installed', "Theme only — icons unchanged");
	}
}

/**
 * Splits a Primal theme label into its family and the short name on the card.
 *
 * `Primal Umber Hard` -> family `Umber`, short `Umber Hard`.
 * `Primal Ink` -> family `Ink`, short `Ink`.
 */
function splitPrimalLabel(label: string): { readonly family: string; readonly shortLabel: string } {
	const shortLabel = label.startsWith(PRIMAL_THEME_LABEL_PREFIX)
		? label.substring(PRIMAL_THEME_LABEL_PREFIX.length)
		: label;
	const words = shortLabel.split(' ');
	const family = words.length > 1 && CORPUS_VARIANTS.includes(words[words.length - 1])
		? words.slice(0, -1).join(' ')
		: shortLabel;
	return { family, shortLabel };
}

/**
 * Classifies one theme.
 *
 * A theme whose settings id matches a vibe's colour theme is a `vibe`; one
 * contributed by the bundled theme extension that is not a vibe is `corpus` —
 * those are the fifteen the vibe engine could not see; everything else is
 * `installed`.
 */
export function classifyTheme(descriptor: IPrimalThemeDescriptor, vibes: readonly IPrimalVibeReference[]): IPrimalThemeEntry {
	const vibe = vibes.find(candidate => candidate.colorTheme === descriptor.settingsId);
	const isPrimalExtension = descriptor.extensionId === PRIMAL_THEME_EXTENSION_ID;
	const source: PrimalThemeSource = vibe ? 'vibe' : isPrimalExtension ? 'corpus' : 'installed';

	if (source === 'installed') {
		return {
			settingsId: descriptor.settingsId,
			label: descriptor.label,
			shortLabel: descriptor.label,
			family: installedFamily(),
			mode: modeOf(descriptor.type),
			source
		};
	}

	const { family, shortLabel } = splitPrimalLabel(descriptor.label);
	return {
		settingsId: descriptor.settingsId,
		label: descriptor.label,
		shortLabel,
		family,
		mode: modeOf(descriptor.type),
		source,
		vibeId: vibe?.id
	};
}

/** Classifies a whole catalogue, vibes first and then everything else by name. */
export function buildCatalogue(descriptors: readonly IPrimalThemeDescriptor[], vibes: readonly IPrimalVibeReference[]): readonly IPrimalThemeEntry[] {
	const entries = descriptors.map(descriptor => classifyTheme(descriptor, vibes));
	const rank: Readonly<Record<PrimalThemeSource, number>> = { vibe: 0, corpus: 1, installed: 2 };
	return [...entries].sort((a, b) => {
		if (rank[a.source] !== rank[b.source]) {
			return rank[a.source] - rank[b.source];
		}
		// Vibes keep contract order; everything else is alphabetical.
		if (a.source === 'vibe' && b.source === 'vibe') {
			return vibes.findIndex(v => v.id === a.vibeId) - vibes.findIndex(v => v.id === b.vibeId);
		}
		return a.label.localeCompare(b.label);
	});
}

/**
 * Filters the catalogue by a free-text query, matched against the name, the
 * family and the mode word. Every term must match somewhere, so "umber dark"
 * narrows rather than widens.
 */
export function filterCatalogue(entries: readonly IPrimalThemeEntry[], query: string): readonly IPrimalThemeEntry[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(term => term.length > 0);
	if (terms.length === 0) {
		return entries;
	}
	return entries.filter(entry => {
		const haystack = [entry.label, entry.shortLabel, entry.family, modeLabel(entry.mode), sourceLabel(entry.source)]
			.join(' ')
			.toLowerCase();
		return terms.every(term => haystack.includes(term));
	});
}

/** One rendered section of the grid. */
export interface IPrimalThemeGroup {
	readonly id: string;
	readonly label: string;
	readonly entries: readonly IPrimalThemeEntry[];
}

/** Splits the catalogue into the sections the rail selects between. */
export function groupCatalogue(entries: readonly IPrimalThemeEntry[], grouping: PrimalThemeGrouping): readonly IPrimalThemeGroup[] {
	const buckets = new Map<string, IPrimalThemeEntry[]>();
	for (const entry of entries) {
		const key = grouping === 'mode' ? entry.mode : entry.family;
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.push(entry);
		} else {
			buckets.set(key, [entry]);
		}
	}
	return [...buckets.entries()].map(([id, members]) => ({
		id,
		label: grouping === 'mode' ? modeLabel(id as PrimalThemeMode) : id,
		entries: members
	}));
}
