/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { PRIMAL_MANAGE_PROVIDERS_COMMAND_ID, providerById } from '../../../../platform/agentHost/common/primalProviders.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IPrimalVibeService } from '../../primalVibes/browser/primalVibes.js';
import { FirstRunModelSource, FirstRunStepId, FirstRunStepStatus, IFirstRunStep } from '../common/primalFirstRunSteps.js';
import { IPrimalFirstRunService } from './primalFirstRunService.js';
import { shortVibeName } from './primalStartVibeName.js';

const $ = DOM.$;

/**
 * The first-run guide as the Start page shows it: three quiet steps between
 * the primary actions and the vibe cards, each stating where it stands in a
 * word and a glyph. It is part of the page, not a wizard: nothing blocks,
 * nothing is modal, and once the guide is complete the strip renders nothing
 * beyond a single "You're set." that is shown for one open of the page.
 *
 * State is never carried by colour alone (see primal/design/vibe-tokens.json):
 * the current step has a heavier edge, and every step says "done", "now" or
 * "next" next to its glyph.
 */

/** How a status is shown: a glyph and a word. Shape and text, never hue. */
interface IStatusPresentation {
	readonly icon: ThemeIcon;
	readonly word: string;
}

function presentStatus(status: FirstRunStepStatus): IStatusPresentation {
	switch (status) {
		case FirstRunStepStatus.Done:
			return { icon: Codicon.check, word: localize('primalStart.firstRun.done', "done") };
		case FirstRunStepStatus.Current:
			return { icon: Codicon.arrowRight, word: localize('primalStart.firstRun.now', "now") };
		case FirstRunStepStatus.Next:
			return { icon: Codicon.circleOutline, word: localize('primalStart.firstRun.next', "next") };
	}
}

/** One affordance a step may offer. */
interface IStepAction {
	readonly label: string;
	readonly run: () => void;
}

/** A step's copy, resolved against the world at render time. */
interface IStepContent {
	readonly title: string;
	readonly detail: string;
	readonly action?: IStepAction;
}

export class PrimalFirstRunStrip extends Disposable {

	private readonly section: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());

	/**
	 * The "You're set." line lives for the open of the page in which the guide
	 * completed (or the first open after it) and goes away on the next one.
	 */
	private completionNoticeVisible = false;

	constructor(
		container: HTMLElement,
		private readonly firstRunService: IPrimalFirstRunService,
		private readonly vibeService: IPrimalVibeService,
		private readonly commandService: ICommandService,
	) {
		super();

		this.section = DOM.append(container, $('section.primal-start-section.primal-start-firstrun'));
		this.section.setAttribute('aria-label', localize('primalStart.firstRun.aria', "First-run guide"));

		this.render();
		this._register(this.firstRunService.onDidChange(() => this.render()));
		// The "Keep Basalt" label follows the vibe even before the choice is recorded.
		this._register(this.vibeService.onDidChangeVibe(() => this.render()));
	}

	/** The page was opened (again): re-read the world, and retire a completion line that already had its showing. */
	onDidOpen(): void {
		this.completionNoticeVisible = false;
		this.firstRunService.refreshDetection().catch(onUnexpectedError);
		this.render();
	}

	private render(): void {
		this.renderDisposables.clear();
		DOM.clearNode(this.section);

		if (this.firstRunService.isGuideVisible) {
			this.section.classList.remove('empty');
			this.renderSteps();
			return;
		}

		if (this.firstRunService.takeCompletionNotice()) {
			this.completionNoticeVisible = true;
		}
		this.section.classList.toggle('empty', !this.completionNoticeVisible);
		if (this.completionNoticeVisible) {
			DOM.append(this.section, $('p.primal-start-firstrun-settled', undefined, localize('primalStart.firstRun.settled', "You're set.")));
		}
	}

	private renderSteps(): void {
		DOM.append(this.section, $('.primal-start-section-label', undefined, localize('primalStart.firstRun.label', "First run")));
		const list = DOM.append(this.section, $('ol.primal-start-firstrun-steps'));

		const guide = this.firstRunService.guide;
		for (const step of guide.steps) {
			this.renderStep(list, step, this.contentFor(step, guide.modelSource));
		}
	}

	private renderStep(list: HTMLElement, step: IFirstRunStep, content: IStepContent): void {
		const { icon, word } = presentStatus(step.status);

		const item = DOM.append(list, $('li.primal-start-firstrun-step.' + step.status));
		DOM.append(item, $('span.primal-start-firstrun-glyph' + ThemeIcon.asCSSSelector(icon), { 'aria-hidden': 'true' }));

		const body = DOM.append(item, $('.primal-start-firstrun-body'));
		const head = DOM.append(body, $('.primal-start-firstrun-head'));
		DOM.append(head, $('span.primal-start-firstrun-title', undefined, content.title));
		DOM.append(head, $('span.primal-start-firstrun-state', undefined, word));
		DOM.append(body, $('p.primal-start-firstrun-detail', undefined, content.detail));

		const action = content.action;
		if (action) {
			const button = DOM.append(body, $('button.primal-start-firstrun-button', undefined, action.label)) as HTMLButtonElement;
			button.type = 'button';
			this.renderDisposables.add(DOM.addDisposableListener(button, 'click', () => action.run()));
		}
	}

	//#region Copy

	private contentFor(step: IFirstRunStep, modelSource: FirstRunModelSource): IStepContent {
		switch (step.id) {
			case FirstRunStepId.Vibe:
				return this.vibeContent(step.status);
			case FirstRunStepId.Model:
				return this.modelContent(modelSource);
			case FirstRunStepId.Start:
				return this.startContent(step.status);
		}
	}

	private vibeContent(status: FirstRunStepStatus): IStepContent {
		const title = localize('primalStart.firstRun.vibe', "Pick a vibe");
		const vibe = this.vibeService.currentVibe;

		if (status === FirstRunStepStatus.Done) {
			return {
				title,
				detail: vibe
					? localize('primalStart.firstRun.vibe.done', "{0}.", shortVibeName(vibe))
					: localize('primalStart.firstRun.vibe.doneCustom', "A theme of your own."),
			};
		}

		return {
			title,
			detail: vibe
				? localize('primalStart.firstRun.vibe.todo', "Six looks below. Click one to try it, or keep {0}.", shortVibeName(vibe))
				: localize('primalStart.firstRun.vibe.todoCustom', "Six looks below. Click one to try it, or keep the theme you have."),
			action: {
				label: vibe
					? localize('primalStart.firstRun.keepVibe', "Keep {0}", shortVibeName(vibe))
					: localize('primalStart.firstRun.keepTheme', "Keep this theme"),
				run: () => this.firstRunService.keepCurrentVibe(),
			},
		};
	}

	private modelContent(source: FirstRunModelSource): IStepContent {
		const title = localize('primalStart.firstRun.model', "Connect a model");

		switch (source.kind) {
			case 'claudeLogin':
				return {
					title,
					// allow-any-unicode-next-line
					detail: localize('primalStart.firstRun.model.claudeLogin', "Using your Claude Code login — nothing to set up."),
				};
			case 'keys': {
				const names = source.providerIds.map(id => providerById(id)?.label ?? id).join(', ');
				return {
					title,
					detail: source.claudeLogin
						? localize('primalStart.firstRun.model.keysAndLogin', "Using your Claude Code login, plus keys for {0}.", names)
						: localize('primalStart.firstRun.model.keys', "Keys for {0}.", names),
				};
			}
			case 'checking':
				return {
					title,
					detail: localize('primalStart.firstRun.model.checking', "Looking for an existing setup..."),
					action: this.addProviderAction(),
				};
			case 'none':
				return {
					title,
					detail: localize('primalStart.firstRun.model.none', "The agent needs a provider. Keys stay in your keychain; nothing is sent anywhere."),
					action: this.addProviderAction(),
				};
		}
	}

	private addProviderAction(): IStepAction {
		return {
			label: localize('primalStart.firstRun.addProvider', "Add a provider..."),
			run: () => this.commandService.executeCommand(PRIMAL_MANAGE_PROVIDERS_COMMAND_ID).then(undefined, onUnexpectedError),
		};
	}

	private startContent(status: FirstRunStepStatus): IStepContent {
		return {
			title: localize('primalStart.firstRun.start', "Start"),
			detail: status === FirstRunStepStatus.Done
				? localize('primalStart.firstRun.start.done', "A project is open or a session has started.")
				: localize('primalStart.firstRun.start.todo', "Open a project, clone a repository, or send the agent a first message."),
		};
	}

	//#endregion
}
