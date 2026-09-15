/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { buildProblemReport, buildProblemReportTitle, IProblemReportInput, tailLines } from '../common/primalProblemReport.js';
import { planProblemReportDelivery } from '../common/primalProblemReportDelivery.js';
import { PrimalProblemReportGatherer } from './primalProblemReportGatherer.js';

interface IBuiltReport {
	readonly title: string;
	readonly body: string;
}

/**
 * Runs the two user-facing commands. Every outcome is said in words through a
 * notification: what was opened, what was copied, or what went wrong.
 */
export class PrimalProblemReporter {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IProductService private readonly productService: IProductService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService
	) { }

	/** Builds the report and opens a prefilled GitHub issue, via the clipboard when the link would be too long. */
	async reportProblem(): Promise<void> {
		const reportIssueUrl = this.productService.reportIssueUrl;
		if (!reportIssueUrl) {
			this.notificationService.warn(localize('primalReport.noIssueUrl', "This build has no issue tracker address, so a problem cannot be reported from here. Use \"Copy Problem Report\" and send the text another way."));
			return;
		}

		const report = await this.build();
		if (!report) {
			return;
		}

		const plan = planProblemReportDelivery(reportIssueUrl, report.title, report.body);
		if (plan.mode === 'clipboard') {
			const copied = await this.copyToClipboard(plan.clipboardText);
			if (!copied) {
				return;
			}
		}

		try {
			await this.openerService.open(URI.parse(plan.url), { openExternal: true });
		} catch (error) {
			this.logService.error('[primalReport] failed to open the issue link', error);
			this.notificationService.error(localize('primalReport.openFailed', "Could not open the issue page: {0}", toErrorMessage(error)));
			return;
		}

		if (plan.mode === 'clipboard') {
			this.notificationService.info(localize('primalReport.openedViaClipboard', "The problem report is longer than a link can carry, so it was copied to your clipboard. Paste it into the GitHub issue form that just opened. No keys or secrets are included."));
		} else {
			this.notificationService.info(localize('primalReport.opened', "A GitHub issue form opened with the problem report filled in. Read it over before you submit. No keys or secrets are included; home paths are shortened to ~."));
		}
	}

	/** Builds the report and puts it on the clipboard. */
	async copyProblemReport(): Promise<void> {
		const report = await this.build();
		if (!report) {
			return;
		}
		if (await this.copyToClipboard(report.body)) {
			const lineCount = tailLines(report.body, Number.MAX_SAFE_INTEGER).total;
			this.notificationService.info(localize('primalReport.copied', "Problem report copied to the clipboard ({0} lines). No keys or secrets are included; home paths are shortened to ~.", lineCount));
		}
	}

	private async build(): Promise<IBuiltReport | undefined> {
		try {
			const gatherer = this.instantiationService.createInstance(PrimalProblemReportGatherer);
			const input: IProblemReportInput = await gatherer.gather();
			return { title: buildProblemReportTitle(input), body: buildProblemReport(input) };
		} catch (error) {
			this.logService.error('[primalReport] failed to build the problem report', error);
			this.notificationService.error(localize('primalReport.buildFailed', "Could not build the problem report: {0}", toErrorMessage(error)));
			return undefined;
		}
	}

	private async copyToClipboard(text: string): Promise<boolean> {
		try {
			await this.clipboardService.writeText(text);
			return true;
		} catch (error) {
			this.logService.error('[primalReport] failed to write the clipboard', error);
			this.notificationService.error(localize('primalReport.copyFailed', "Could not copy the problem report to the clipboard: {0}", toErrorMessage(error)));
			return false;
		}
	}
}
