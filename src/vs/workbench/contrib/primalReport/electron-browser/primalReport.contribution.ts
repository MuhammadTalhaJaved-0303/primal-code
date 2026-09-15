/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { PrimalProblemReporter } from './primalProblemReporter.js';

export const PRIMAL_REPORT_PROBLEM_COMMAND_ID = 'primalCode.reportProblem';
export const PRIMAL_COPY_PROBLEM_REPORT_COMMAND_ID = 'primalCode.copyProblemReport';

const PRIMAL_CATEGORY = localize2('primalCode.category', "Primal Code");

/**
 * Sits where the upstream "Report Issue" used to be in the Help menu; that
 * entry is hidden in `issue/common/issue.contribution.ts` so users see one
 * way to report, and it is this one.
 */
class PrimalReportProblemAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_REPORT_PROBLEM_COMMAND_ID,
			title: {
				...localize2('primalReport.reportProblem', "Report a Problem"),
				mnemonicTitle: localize({ key: 'primalReport.miReportProblem', comment: ['&& denotes a mnemonic'] }, "Report a &&Problem")
			},
			category: PRIMAL_CATEGORY,
			f1: true,
			menu: {
				id: MenuId.MenubarHelpMenu,
				group: '3_feedback',
				order: 3
			}
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IInstantiationService).createInstance(PrimalProblemReporter).reportProblem();
	}
}

class PrimalCopyProblemReportAction extends Action2 {
	constructor() {
		super({
			id: PRIMAL_COPY_PROBLEM_REPORT_COMMAND_ID,
			title: localize2('primalReport.copyProblemReport', "Copy Problem Report"),
			category: PRIMAL_CATEGORY,
			f1: true
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IInstantiationService).createInstance(PrimalProblemReporter).copyProblemReport();
	}
}

registerAction2(PrimalReportProblemAction);
registerAction2(PrimalCopyProblemReportAction);
