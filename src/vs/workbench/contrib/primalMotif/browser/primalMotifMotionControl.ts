/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IPrimalMotifService, IPrimalMotifStatus, PRIMAL_MOTIF_STATIC_ID } from './primalMotif.js';

/**
 * Primal Code - a pause control for a motif that keeps moving.
 *
 * WCAG 2.2.2 allows motion that starts on its own and lasts more than five
 * seconds only where the reader can pause it, and "can" means a control they
 * can see, not a command they would have to know the name of. The IDE window
 * has that control in its status bar. A stage host that has no status bar -
 * the Agents window's landing - renders this one instead, next to the picture
 * it governs.
 *
 * It follows the same rule the status bar item does: shown while the motion is
 * perpetual, or while it is paused so there is always a way back; hidden when
 * the motif settles on its own or there is no motif. State is a word and a
 * glyph, never a colour.
 */
export const MOTIF_MOTION_CONTROL_CLASS = 'primal-motif-motion-control';

export interface IMotifMotionControl {
	readonly element: HTMLButtonElement;
}

export function renderMotifMotionControl(parent: HTMLElement, motifService: IPrimalMotifService, disposables: Pick<DisposableStore, 'add'>): IMotifMotionControl {
	const element = append(parent, $(`button.${MOTIF_MOTION_CONTROL_CLASS}`)) as HTMLButtonElement;
	element.type = 'button';

	const glyph = append(element, $('span.primal-motif-motion-control-glyph'));
	const word = append(element, $('span.primal-motif-motion-control-word'));

	const render = (status: IPrimalMotifStatus): void => {
		const paused = motifService.isPaused || status.state === 'paused';
		const offered = status.motifId !== PRIMAL_MOTIF_STATIC_ID && (paused || motifService.motion === 'perpetual');

		element.hidden = !offered;
		if (!offered) {
			return;
		}

		glyph.className = `primal-motif-motion-control-glyph ${ThemeIcon.asClassName(paused ? Codicon.play : Codicon.debugPause)}`;
		word.textContent = paused
			? localize('primalCode.motif.control.play', "Play motion")
			: localize('primalCode.motif.control.pause', "Pause motion");
		element.setAttribute('aria-pressed', String(paused));
		element.title = paused
			? localize('primalCode.motif.control.playTitle', "The motif is paused. Select to let it move again.")
			: localize('primalCode.motif.control.pauseTitle', "The motif is moving. Select to pause it.");
	};

	disposables.add(addDisposableListener(element, 'click', () => {
		motifService.setPaused(!motifService.isPaused);
		render(motifService.status);
	}));
	disposables.add(motifService.onDidChangeStatus(render));
	render(motifService.status);

	return { element };
}
