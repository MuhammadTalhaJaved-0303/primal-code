/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_MOTIF_STATIC_ID, getMotifDescriptors } from '../../../primalMotif/browser/primalMotif.js';
import { PRIMAL_MOTIF_WORLD_ID } from '../../../primalMotif/browser/motifs/globe.js';
import { STARFIELD_MOTIF_ID } from '../../../primalMotif/browser/motifs/starfield.js';
import { composeMotifChoices } from '../../../primalMotif/browser/primalMotifChoices.js';
import { IMotifRow, renderMotifRow } from '../../browser/primalStartMotifRow.js';
// The shipping set, so the row is tested against what the product offers.
import '../../../primalMotif/browser/motifs/motifs.js';

suite('Primal Start - motif row', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const descriptors = getMotifDescriptors();

	interface IHarness {
		readonly row: IMotifRow;
		readonly section: HTMLElement;
		readonly selected: readonly string[];
	}

	function render(currentId: string): IHarness {
		const section = mainWindow.document.createElement('div');
		const selected: string[] = [];
		const disposables = store.add(new DisposableStore());
		const row = renderMotifRow(section, composeMotifChoices(descriptors, currentId), id => selected.push(id), disposables);
		return { row, section, selected };
	}

	/** The word the card carries for its state, or '' when it has none. */
	function stateWord(card: HTMLElement): string {
		return card.querySelector('.primal-start-motif-state')?.textContent?.trim() ?? '';
	}

	test('renders one card per registered motif, each with a name and a description', () => {
		const { row, section } = render(PRIMAL_MOTIF_STATIC_ID);

		assert.strictEqual(row.cards.size, descriptors.length);
		assert.strictEqual(section.querySelectorAll('button.primal-start-motif-card').length, descriptors.length);

		for (const descriptor of descriptors) {
			const card = row.cards.get(descriptor.id);
			assert.ok(card, `a card for '${descriptor.id}'`);
			const name = card.querySelector('.primal-start-motif-label')?.textContent ?? '';
			const description = card.querySelector('.primal-start-motif-description')?.textContent ?? '';
			assert.ok(name.length > 0, `'${descriptor.id}' shows a name`);
			assert.ok(description.length > 0, `'${descriptor.id}' shows a description`);
			assert.ok(descriptor.description.startsWith(description), `'${descriptor.id}' shows the start of its own description, got '${description}'`);
			assert.ok(!description.includes('. '), `'${descriptor.id}' shows one line, not a paragraph: '${description}'`);
			assert.strictEqual(card.title, descriptor.description, 'the whole description is a hover away');
		}
	});

	test('the static card names itself as the way to no motion', () => {
		const { row } = render(PRIMAL_MOTIF_WORLD_ID);
		const name = row.cards.get(PRIMAL_MOTIF_STATIC_ID)?.querySelector('.primal-start-motif-label')?.textContent ?? '';
		assert.ok(/no motion/i.test(name), `got '${name}'`);
	});

	test('the current motif is said in words, on exactly one card', () => {
		const { row } = render(PRIMAL_MOTIF_WORLD_ID);

		for (const [id, card] of row.cards) {
			const isCurrent = id === PRIMAL_MOTIF_WORLD_ID;
			assert.strictEqual(card.classList.contains('current'), isCurrent, `'${id}' current class`);
			assert.strictEqual(card.getAttribute('aria-pressed'), String(isCurrent), `'${id}' aria-pressed`);
			assert.strictEqual(/current/i.test(stateWord(card)), isCurrent, `'${id}' says '${stateWord(card)}'`);
		}
	});

	test('marking another motif current moves the word, it does not copy it', () => {
		const { row } = render(PRIMAL_MOTIF_WORLD_ID);

		row.markCurrent(STARFIELD_MOTIF_ID);

		const marked = [...row.cards.entries()].filter(([, card]) => card.classList.contains('current')).map(([id]) => id);
		assert.deepStrictEqual(marked, [STARFIELD_MOTIF_ID]);
		assert.ok(/current/i.test(stateWord(row.cards.get(STARFIELD_MOTIF_ID)!)));
		assert.strictEqual(stateWord(row.cards.get(PRIMAL_MOTIF_WORLD_ID)!), '');
	});

	test('selecting a card reports that motif and nothing else', () => {
		const { row, selected } = render(PRIMAL_MOTIF_WORLD_ID);

		row.cards.get(STARFIELD_MOTIF_ID)!.click();

		assert.deepStrictEqual(selected, [STARFIELD_MOTIF_ID]);
	});
});
