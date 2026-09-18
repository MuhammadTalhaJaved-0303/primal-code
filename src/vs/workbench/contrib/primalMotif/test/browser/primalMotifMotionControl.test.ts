/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPrimalMotifService, IPrimalMotifStatus, PRIMAL_MOTIF_STATIC_ID, PrimalMotifMotion, PrimalMotifState } from '../../browser/primalMotif.js';
import { MOTIF_MOTION_CONTROL_CLASS, renderMotifMotionControl } from '../../browser/primalMotifMotionControl.js';

/** The slice of the service the control reads, driven by hand. */
class TestMotifService {
	private readonly _onDidChangeStatus = new Emitter<IPrimalMotifStatus>();
	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	motion: PrimalMotifMotion = 'perpetual';
	isPaused = false;
	status: IPrimalMotifStatus = { state: 'moving', motifId: 'world', reason: undefined, fps: 30 };
	readonly toggles: boolean[] = [];

	setPaused(paused: boolean): void {
		this.toggles.push(paused);
		this.isPaused = paused;
	}

	report(state: PrimalMotifState, motifId = 'world'): void {
		this.status = { ...this.status, state, motifId };
		this._onDidChangeStatus.fire(this.status);
	}

	dispose(): void {
		this._onDidChangeStatus.dispose();
	}
}

suite('Primal Motif - motion control', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function mount() {
		const service = store.add(new TestMotifService());
		const host = $('.host');
		const control = renderMotifMotionControl(host, service as unknown as IPrimalMotifService, store);
		return { service, host, control };
	}

	const wordOf = (host: HTMLElement) => host.querySelector(`.${MOTIF_MOTION_CONTROL_CLASS}`)?.textContent?.trim() ?? '';
	const shown = (host: HTMLElement) => !(host.querySelector(`.${MOTIF_MOTION_CONTROL_CLASS}`) as HTMLElement).hidden;

	test('offers to pause while the motif moves, and says so in words', () => {
		const { host } = mount();
		assert.strictEqual(shown(host), true);
		assert.ok(/pause/i.test(wordOf(host)), `got '${wordOf(host)}'`);
	});

	test('offers to play once paused, and tells the service which way it went', () => {
		const { service, host } = mount();
		(host.querySelector(`.${MOTIF_MOTION_CONTROL_CLASS}`) as HTMLButtonElement).click();
		service.report('paused');
		assert.deepStrictEqual(service.toggles, [true]);
		assert.ok(/play|resume/i.test(wordOf(host)), `got '${wordOf(host)}'`);
	});

	test('is not offered when there is no motion to pause', () => {
		const { service, host } = mount();
		service.motion = 'settle';
		service.report('resting');
		assert.strictEqual(shown(host), false, 'a settling motif stops on its own');

		service.motion = 'perpetual';
		service.report('static', PRIMAL_MOTIF_STATIC_ID);
		assert.strictEqual(shown(host), false, 'static has no motion at all');
	});

	test('stays offered while paused even if the mode has since changed, so the reader can always get back', () => {
		const { service, host } = mount();
		service.isPaused = true;
		service.motion = 'settle';
		service.report('paused');
		assert.strictEqual(shown(host), true);
	});
});
