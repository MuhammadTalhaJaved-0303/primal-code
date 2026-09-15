/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IMotifDescriptor, PRIMAL_MOTIF_ID_SETTING_ID, getMotifDescriptors, toMotifId } from './primalMotif.js';
import { composeMotifChoices } from './primalMotifChoices.js';

/**
 * Primal Code - the motif picker.
 *
 * `Motif: Choose Motif...` in the command palette. Before this the only way to
 * a motif was Settings search for a key nobody knew the name of, and the owner
 * of the product, having installed a release, could not find the feature at
 * all. The picker is the same shape as `Vibes: Choose Vibe...`
 * (`primalVibes/browser/primalVibeService.ts`): a quick pick of every choice,
 * the current one said in words in its label, a live preview while arrowing,
 * and Escape putting back exactly what was there.
 *
 * The preview IS the setting. The scheduler already treats a change to
 * `primalCode.motif.id` as "the user wants to see this" and plays a burst
 * (`primalMotifScheduler.ts`, the `onDidChangeConfiguration` handler), so
 * previewing by writing the setting gets the burst for free and needs no second
 * path into the scheduler. The cost is that Escape has to write too, and it
 * writes the value that was there - including `undefined`, for a profile that
 * never set one, so a dismissed picker does not pin the default into
 * settings.json.
 */

export const PRIMAL_MOTIF_PICK_COMMAND_ID = 'primalCode.motif.pick';

/** The same category as the other motif commands in `primalMotif.contribution.ts`. */
const MOTIF_CATEGORY = localize2('primalCode.motif.category', "Motif");

export interface IMotifQuickPickItem extends IQuickPickItem {
	readonly motifId: string;
}

/** The choices as quick pick items, the current one marked in its label. */
export function composeMotifPicks(descriptors: readonly IMotifDescriptor[], currentId: string): readonly IMotifQuickPickItem[] {
	return composeMotifChoices(descriptors, currentId).map(choice => ({
		id: choice.id,
		motifId: choice.id,
		// allow-any-unicode-next-line
		label: choice.current ? localize('primalCode.motif.pick.currentLabel', "{0} — current", choice.label) : choice.label,
		description: choice.description
	}));
}

export class PrimalMotifPicker {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILogService private readonly logService: ILogService
	) { }

	/** Resolves when the picker closes, by either route. */
	async pick(): Promise<void> {
		// What Escape puts back: the user's own value, which may be nothing.
		const original = this.configurationService.inspect<unknown>(PRIMAL_MOTIF_ID_SETTING_ID).userValue;
		const currentId = toMotifId(this.configurationService.getValue<unknown>(PRIMAL_MOTIF_ID_SETTING_ID));
		const picks = composeMotifPicks(getMotifDescriptors(), currentId);

		const disposables = new DisposableStore();
		// The id most recently written, so arrowing back onto it writes nothing
		// and starts no second burst.
		let applied: unknown = original;

		const write = async (value: unknown): Promise<void> => {
			if (value === applied) {
				return;
			}
			applied = value;
			try {
				await this.configurationService.updateValue(PRIMAL_MOTIF_ID_SETTING_ID, value, ConfigurationTarget.USER);
			} catch (error) {
				this.logService.error(`[primalMotif] Failed to write '${PRIMAL_MOTIF_ID_SETTING_ID}'`, error);
			}
		};

		await new Promise<void>(resolve => {
			// Set by Enter; still `undefined` on Escape or a lost focus.
			let chosen: string | undefined;
			const quickPick = disposables.add(this.quickInputService.createQuickPick<IMotifQuickPickItem>());
			quickPick.items = picks;
			quickPick.title = localize('primalCode.motif.pick.title', "Choose Motif");
			quickPick.placeholder = localize('primalCode.motif.pick.placeholder', "Select what moves in the window ground (Up/Down previews it; Escape puts back what was there)");
			quickPick.canSelectMany = false;
			quickPick.matchOnDescription = true;

			const activeItem = picks.find(pick => pick.motifId === currentId);
			if (activeItem) {
				quickPick.activeItems = [activeItem];
			}

			disposables.add(quickPick.onDidChangeActive(items => {
				const item = items[0];
				if (item) {
					write(item.motifId).catch(error => this.logService.error('[primalMotif] Failed to preview the motif', error));
				}
			}));
			disposables.add(quickPick.onDidAccept(() => {
				chosen = quickPick.selectedItems[0]?.motifId;
				quickPick.hide(); // `onDidHide` finishes the job, on both routes
			}));
			disposables.add(quickPick.onDidHide(() => {
				// The quick pick is gone whichever way it went, so the listeners on
				// it are released HERE and synchronously, not behind the write: a
				// picker dismissed and re-opened in the same tick must not hold two
				// sets. Then either the choice is kept, or - Escape, focus lost -
				// what was there is put back, without a preview ever having been
				// persisted as if it were a choice.
				disposables.dispose();
				write(chosen ?? original).then(resolve, resolve);
			}));
			quickPick.show();
		}).finally(() => disposables.dispose());
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PRIMAL_MOTIF_PICK_COMMAND_ID,
			title: localize2('primalCode.motif.pick', "Choose Motif..."),
			category: MOTIF_CATEGORY,
			f1: true
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(PrimalMotifPicker).pick();
	}
});
