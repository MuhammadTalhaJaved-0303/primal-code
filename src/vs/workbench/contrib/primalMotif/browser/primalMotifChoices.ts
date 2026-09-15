/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IMotifDescriptor, PRIMAL_MOTIF_STATIC_ID } from './primalMotif.js';

/**
 * Primal Code - the motif choice list.
 *
 * One pure list, read by two views: the quick pick (`primalMotifPicker.ts`)
 * and the MOTIF row on Primal Start (`primalStart/browser/primalStartMotifRow.ts`).
 * Both used to be a way of not finding the feature - the setting was reachable
 * only through Settings search - so the list is composed once here, and the two
 * places a user can actually see it agree on the spelling of every entry, on
 * which one is current, and on `static` leading as the way to no motion.
 *
 * "Current" is a WORD on the entry (`current: true`, rendered as text by each
 * view), never a colour: the product owner is colour blind, and a highlight is
 * also just where the cursor happens to be.
 */
export interface IMotifChoice {
	readonly id: string;
	/** The name a user picks by. `static` is named for what it is for. */
	readonly label: string;
	/** The descriptor's own description, unchanged. */
	readonly description: string;
	/** True on exactly one entry: the motif the setting currently resolves to. */
	readonly current: boolean;
}

/**
 * The static motif's label in a list of choices. In the registry it is
 * "Static", which is accurate but says nothing about why one would choose it;
 * in a list next to five things that move, it is the way to none of them.
 */
const STATIC_CHOICE_LABEL = localize('primalCode.motif.choice.static', "Static (no motion)");

/**
 * Every registered motif as a choice, `static` first and the rest in registry
 * order, with `currentId` marked. Pure: the same descriptors and id always give
 * the same list, and nothing here reads a service.
 */
export function composeMotifChoices(descriptors: readonly IMotifDescriptor[], currentId: string): readonly IMotifChoice[] {
	const ordered = [
		...descriptors.filter(descriptor => descriptor.id === PRIMAL_MOTIF_STATIC_ID),
		...descriptors.filter(descriptor => descriptor.id !== PRIMAL_MOTIF_STATIC_ID)
	];

	return Object.freeze(ordered.map(descriptor => Object.freeze({
		id: descriptor.id,
		label: descriptor.id === PRIMAL_MOTIF_STATIC_ID ? STATIC_CHOICE_LABEL : descriptor.label,
		description: descriptor.description,
		current: descriptor.id === currentId
	})));
}
