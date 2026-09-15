/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildIssueUrl, planProblemReportDelivery, PRIMAL_REPORT_CLIPBOARD_BODY, PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH } from '../../common/primalProblemReportDelivery.js';

const ISSUE_URL = 'https://github.com/example/primal-code/issues/new';

suite('Primal problem report - delivery', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the issue URL carries an encoded title and body', () => {
		const url = buildIssueUrl(ISSUE_URL, 'Bug: a & b #1', 'line 1\nline 2');
		assert.strictEqual(url, `${ISSUE_URL}?title=Bug%3A%20a%20%26%20b%20%231&body=line%201%0Aline%202`);
	});

	test('a base URL that already has a query keeps it', () => {
		const url = buildIssueUrl(`${ISSUE_URL}?labels=bug`, 't', 'b');
		assert.strictEqual(url, `${ISSUE_URL}?labels=bug&title=t&body=b`);
	});

	test('a short report travels in the URL', () => {
		const plan = planProblemReportDelivery(ISSUE_URL, 'title', 'short body');
		assert.strictEqual(plan.mode, 'url');
		assert.strictEqual(plan.url, buildIssueUrl(ISSUE_URL, 'title', 'short body'));
		assert.ok(plan.url.length <= PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH);
	});

	test('a long report goes to the clipboard and the URL gets a short body that says so', () => {
		const body = 'x'.repeat(PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH);
		const plan = planProblemReportDelivery(ISSUE_URL, 'title', body);
		assert.strictEqual(plan.mode, 'clipboard');
		if (plan.mode === 'clipboard') {
			assert.strictEqual(plan.clipboardText, body);
		}
		assert.strictEqual(plan.url, buildIssueUrl(ISSUE_URL, 'title', PRIMAL_REPORT_CLIPBOARD_BODY));
		assert.ok(plan.url.length <= PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH);
		assert.ok(PRIMAL_REPORT_CLIPBOARD_BODY.toLowerCase().includes('clipboard'));
		assert.ok(PRIMAL_REPORT_CLIPBOARD_BODY.toLowerCase().includes('paste'));
	});

	test('a report that only just fits still travels in the URL', () => {
		const prefix = buildIssueUrl(ISSUE_URL, 't', '');
		const body = 'y'.repeat(PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH - prefix.length);
		const plan = planProblemReportDelivery(ISSUE_URL, 't', body);
		assert.strictEqual(plan.mode, 'url');
		assert.strictEqual(plan.url.length, PRIMAL_REPORT_MAX_ISSUE_URL_LENGTH);
	});
});
