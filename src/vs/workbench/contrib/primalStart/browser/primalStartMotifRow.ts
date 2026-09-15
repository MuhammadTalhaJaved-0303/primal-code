/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IMotifChoice } from '../../primalMotif/browser/primalMotifChoices.js';

const $ = DOM.$;

/**
 * Primal Code - the MOTIF row on Primal Start.
 *
 * Sits beside the VIBE row and speaks the same card language (a quiet slab
 * with a hairline edge; the current one gets a check glyph and a heavier edge).
 * It adds one thing the vibe cards do not have to: the word "current" on the
 * card itself. A motif has no swatch to recognise it by, so the card is the
 * whole signal, and the product owner is colour blind - meaning is never
 * carried by hue, and here not even by shape alone.
 *
 * Pure DOM: the row is handed its choices and reports a selection; it reads no
 * service and writes no setting, so it is tested without the editor around it.
 */
export interface IMotifRow {
	/** One card per choice, by motif id. */
	readonly cards: ReadonlyMap<string, HTMLButtonElement>;
	/** Moves the current mark - class, `aria-pressed` and the word - to `motifId`. */
	markCurrent(motifId: string): void;
}

const CURRENT_WORD = localize('primalStart.motif.current', "current");

/**
 * The first sentence of a description, for a card that has one line to give
 * it. The whole description goes on the card's `title`. Falls back to the
 * whole text when there is no sentence break to cut at.
 */
function firstSentence(description: string): string {
	const end = description.indexOf('. ');
	return end === -1 ? description : description.substring(0, end + 1);
}

export function renderMotifRow(section: HTMLElement, choices: readonly IMotifChoice[], onSelect: (motifId: string) => void, disposables: DisposableStore): IMotifRow {
	const strip = DOM.append(section, $('.primal-start-motifs'));
	const cards = new Map<string, HTMLButtonElement>();
	// The state span of each card, held directly rather than found by selector.
	const states = new Map<string, HTMLElement>();

	for (const choice of choices) {
		const { card, state } = renderMotifCard(strip, choice, onSelect, disposables);
		cards.set(choice.id, card);
		states.set(choice.id, state);
	}

	const markCurrent = (motifId: string): void => {
		for (const [id, card] of cards) {
			const isCurrent = id === motifId;
			card.classList.toggle('current', isCurrent);
			card.setAttribute('aria-pressed', String(isCurrent));
			const state = states.get(id);
			if (state) {
				state.textContent = isCurrent ? CURRENT_WORD : '';
			}
		}
	};

	const current = choices.find(choice => choice.current);
	if (current) {
		markCurrent(current.id);
	}

	return Object.freeze({ cards, markCurrent });
}

interface IMotifCard {
	readonly card: HTMLButtonElement;
	readonly state: HTMLElement;
}

function renderMotifCard(strip: HTMLElement, choice: IMotifChoice, onSelect: (motifId: string) => void, disposables: DisposableStore): IMotifCard {
	const card = DOM.append(strip, $('button.primal-start-motif-card')) as HTMLButtonElement;
	card.type = 'button';
	card.title = choice.description;
	card.setAttribute('aria-label', localize('primalStart.applyMotif', "Use the {0} motif", choice.label));

	const nameRow = DOM.append(card, $('.primal-start-motif-name'));
	DOM.append(nameRow, $('span.primal-start-motif-check' + ThemeIcon.asCSSSelector(Codicon.check)));
	DOM.append(nameRow, $('span.primal-start-motif-label', undefined, choice.label));
	// Filled in by `markCurrent`; empty on every card that is not current.
	const state = DOM.append(nameRow, $('span.primal-start-motif-state'));

	DOM.append(card, $('.primal-start-motif-description', undefined, firstSentence(choice.description)));

	disposables.add(DOM.addDisposableListener(card, 'click', () => onSelect(choice.id)));

	return { card, state };
}
