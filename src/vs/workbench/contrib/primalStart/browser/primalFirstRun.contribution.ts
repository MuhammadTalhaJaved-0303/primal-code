/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPrimalFirstRunService, PrimalFirstRunService } from './primalFirstRunService.js';
import { PrimalStartInput } from './primalStartInput.js';

/** Forgets first-run progress and opens Primal Start so the guide is on screen again. */
export const PRIMAL_FIRST_RUN_RESET_COMMAND_ID = 'primalCode.firstRun.reset';

const PRIMAL_CATEGORY = localize2('primalCode.category', "Primal Code");

registerSingleton(IPrimalFirstRunService, PrimalFirstRunService, InstantiationType.Delayed);

/**
 * Brings the service to life in every window. The Start page only exists in
 * empty windows, but the "Start" step is ticked by a folder or repository
 * opening - which happens in a window that never shows the page. Resolving
 * the service is the whole job: its constructor wires the listeners.
 */
class PrimalFirstRunTrackerContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primalFirstRunTracker';

	constructor(@IPrimalFirstRunService _firstRunService: IPrimalFirstRunService) { }
}

registerWorkbenchContribution2(PrimalFirstRunTrackerContribution.ID, PrimalFirstRunTrackerContribution, WorkbenchPhase.Eventually);

class ResetFirstRunGuideAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_FIRST_RUN_RESET_COMMAND_ID,
			title: localize2('primalCode.firstRun.reset', "Show First-Run Guide Again"),
			category: PRIMAL_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IPrimalFirstRunService).reset();
		await accessor.get(IEditorService).openEditor(new PrimalStartInput(), { pinned: true });
	}
}

registerAction2(ResetFirstRunGuideAction);
