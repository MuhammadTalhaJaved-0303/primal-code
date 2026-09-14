/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IPrimalMotifService, PRIMAL_MOTIF_STAGE_CLASS } from '../../../../../workbench/contrib/primalMotif/browser/primalMotif.js';
import { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { NEW_CHAT_MOTIF_HOST_CLASS, NewChatMotifStage } from '../../browser/newChatMotifStage.js';

interface IStageOffer {
	readonly container: HTMLElement;
	readonly element: HTMLElement;
	withdrawn: boolean;
}

suite('Sessions - NewChatMotifStage', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness() {
		const container = $('.monaco-workbench.agent-sessions-workbench');
		const host = $('.sessions-chat-widget');
		const offers: IStageOffer[] = [];
		let relayouts = 0;

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkbenchLayoutService, { getContainer: () => container } as Partial<IWorkbenchLayoutService>);
		instantiationService.stub(IPrimalMotifService, {
			registerStage(offeredContainer: HTMLElement, element: HTMLElement) {
				const offer: IStageOffer = { container: offeredContainer, element, withdrawn: false };
				offers.push(offer);
				return toDisposable(() => { offer.withdrawn = true; });
			},
			relayout() { relayouts++; }
		} as Partial<IPrimalMotifService>);

		const stage = store.add(instantiationService.createInstance(NewChatMotifStage, host));
		return { container, host, offers, stage, relayouts: () => relayouts };
	}

	test('offers the workbench container a stage element that everything rendered after it paints above', () => {
		const { container, host, offers } = createHarness();
		assert.strictEqual(offers.length, 1);
		assert.strictEqual(offers[0].container, container, 'the offer names the workbench container, never the pane');
		assert.ok(offers[0].element.classList.contains(PRIMAL_MOTIF_STAGE_CLASS));
		assert.strictEqual(host.firstElementChild, offers[0].element, 'the stage is the first child of the landing');
		assert.strictEqual(offers[0].element.getAttribute('aria-hidden'), 'true');
		assert.ok(host.classList.contains(NEW_CHAT_MOTIF_HOST_CLASS), 'the stylesheet keys its stacking rules on this class');
	});

	test('withdraws the offer while the host is hidden and offers again when it is shown', () => {
		const { offers, stage } = createHarness();
		stage.setHostVisible(false);
		assert.strictEqual(offers[0].withdrawn, true);
		stage.setHostVisible(true);
		assert.strictEqual(offers.length, 2);
		assert.strictEqual(offers[1].withdrawn, false);
	});

	test('repeating the same visibility does not re-offer', () => {
		const { offers, stage } = createHarness();
		stage.setHostVisible(true);
		stage.setHostVisible(true);
		assert.strictEqual(offers.length, 1);
		stage.setHostVisible(false);
		stage.setHostVisible(false);
		assert.strictEqual(offers.length, 1);
	});

	test('relayout reaches the scheduler only while the stage is offered', () => {
		const { stage, relayouts } = createHarness();
		stage.layout();
		assert.strictEqual(relayouts(), 1);
		stage.setHostVisible(false);
		stage.layout();
		assert.strictEqual(relayouts(), 1, 'a hidden landing has no surface to lay out');
	});

	test('disposing withdraws the offer and removes the stage element', () => {
		const { host, offers, stage } = createHarness();
		stage.dispose();
		assert.strictEqual(offers[0].withdrawn, true);
		assert.strictEqual(host.querySelector(`.${PRIMAL_MOTIF_STAGE_CLASS}`), null);
	});
});
