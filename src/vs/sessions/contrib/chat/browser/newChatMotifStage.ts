/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, getWindow, prepend } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IPrimalMotifService, PRIMAL_MOTIF_STAGE_CLASS } from '../../../../workbench/contrib/primalMotif/browser/primalMotif.js';
import { renderMotifMotionControl } from '../../../../workbench/contrib/primalMotif/browser/primalMotifMotionControl.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';

/**
 * Written on the landing element that hosts a stage. `chatWidget.css` keys the
 * stacking rules on it - the isolated context, the stage at z-index 0, the
 * content above it and the scrim under the words - so that a landing without a
 * stage (the new-chat-in-session widget, which sits next to code) gets none of
 * them.
 */
export const NEW_CHAT_MOTIF_HOST_CLASS = 'primal-motif-host';

/**
 * Primal Code - the "New session" landing of the Agents window offers itself as
 * the window's motif stage.
 *
 * The motif layer runs exactly one surface per window, and outside a stage that
 * surface lives in the wallpaper layer, where the Agents window shows it only
 * through its title bar and the gaps between its floating panels. The landing
 * is the one pane in that window that shows no code at all - a heading, a
 * workspace picker and an input - which is the condition `registerStage` sets
 * for offering a host, and the same condition Primal Start meets in the IDE
 * window (`primalStartEditor.ts`, whose lifecycle this mirrors).
 *
 * The offer follows the host's visibility: withdrawn while the landing is
 * hidden behind a session, made again when it is shown, and withdrawn for good
 * on dispose. Which motif is drawn, at what strength and whether it moves at
 * all is the scheduler's decision, not this class's.
 *
 * On a stage the motif keeps moving by default (`defaultMotionFor` in
 * primalMotif.ts), and WCAG 2.2.2 then needs a pause control the reader can
 * see. The IDE window has one in its status bar; this window has no status bar,
 * so the landing carries its own, appended after the stage so it paints above
 * the picture it governs.
 */
export class NewChatMotifStage extends Disposable {

	private readonly stage: HTMLElement;
	private readonly control: HTMLElement;
	private readonly container: HTMLElement;
	private readonly registration = this._register(new MutableDisposable());
	private hostVisible = true;

	constructor(
		host: HTMLElement,
		@IPrimalMotifService private readonly motifService: IPrimalMotifService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService
	) {
		super();

		host.classList.add(NEW_CHAT_MOTIF_HOST_CLASS);

		// First child, so everything the landing renders after it paints above
		// the picture. Decorative only: nothing in it is reachable or readable.
		this.stage = prepend(host, $(`.${PRIMAL_MOTIF_STAGE_CLASS}`, { 'aria-hidden': 'true' }));

		// The offer names the workbench container the pane lives in, never the
		// pane: that is where the window's single surface is resolved.
		this.container = layoutService.getContainer(getWindow(host));

		this.control = renderMotifMotionControl(host, motifService, this._store).element;

		this.updateOffer();
	}

	/** Mirrors `NewChatView.setVisible`: a hidden landing offers nothing. */
	setHostVisible(visible: boolean): void {
		if (this.hostVisible === visible) {
			return;
		}
		this.hostVisible = visible;
		this.updateOffer();
	}

	/** The landing was laid out, so the stage's CSS box may have changed. */
	layout(): void {
		if (this.registration.value) {
			this.motifService.relayout(this.container);
		}
	}

	private updateOffer(): void {
		if (this.hostVisible === !!this.registration.value) {
			return;
		}
		if (!this.hostVisible) {
			this.registration.clear();
			return;
		}
		this.registration.value = this.motifService.registerStage(this.container, this.stage);
	}

	override dispose(): void {
		super.dispose();
		this.stage.remove();
		this.control.remove();
	}
}
