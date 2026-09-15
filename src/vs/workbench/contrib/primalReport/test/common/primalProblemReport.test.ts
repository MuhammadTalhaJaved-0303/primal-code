/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildProblemReport, buildProblemReportTitle, IProblemReportInput, newestCrashReportName, PRIMAL_REPORT_LOG_TAIL_LINES, PRIMAL_REPORT_MAX_LINE_LENGTH, PRIMAL_REPORT_REDACTED, sanitiseReportText, tailLines } from '../../common/primalProblemReport.js';

const HOME = '/Users/jane';

/** A key that must never survive into a report, wherever it is planted. */
const FAKE_KEY = 'sk-ant-api03-FAKEKEYFAKEKEYFAKEKEY1234567890abcdef';

function baseInput(overrides: Partial<IProblemReportInput> = {}): IProblemReportInput {
	return {
		product: { name: 'Primal Code', version: '1.135.2', commit: '0123456789abcdef0123456789abcdef01234567', date: '2026-09-14T10:00:00.000Z' },
		os: { name: 'macOS', release: '25.6.0', arch: 'arm64', hostname: 'janes-mac' },
		colorTheme: 'Primal Basalt',
		vibe: 'basalt',
		motif: { id: 'static', motion: 'settle' },
		wallpaperMode: 'ambient',
		providerIds: ['anthropic', 'deepseek'],
		harnessProviderId: 'anthropic',
		mainLog: { text: 'main line 1\nmain line 2\n' },
		rendererLog: { text: 'renderer line 1\n' },
		crashReport: { kind: 'none' },
		homeDir: HOME,
		...overrides
	};
}

suite('Primal problem report - sanitise', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the home directory becomes ~ in both slash forms', () => {
		const text = `read ${HOME}/project/a.ts and C:\\Users\\other\\x.ts and file://${HOME}/y and \\Users\\jane\\z`;
		const out = sanitiseReportText(text, { homeDir: HOME });
		assert.strictEqual(out, 'read ~/project/a.ts and C:\\Users\\other\\x.ts and file://~/y and ~\\z');

		const win = sanitiseReportText('at C:\\Users\\jane\\x.ts and C:/Users/jane/y.ts', { homeDir: 'C:\\Users\\jane' });
		assert.strictEqual(win, 'at ~\\x.ts and ~/y.ts');
	});

	test('the hostname is replaced by a placeholder', () => {
		const out = sanitiseReportText('crash on janes-mac at noon', { homeDir: HOME, hostname: 'janes-mac' });
		assert.strictEqual(out, 'crash on [hostname] at noon');
	});

	test('provider style keys are redacted', () => {
		const samples = [
			'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end',
			'key sk-proj-abcdefghijklmnop end',
			'key ghp_abcdefghijklmnopqrstuvwxyz0123456789 end',
			'key github_pat_11ABCDEFG_abcdefghijklmnop end',
			'key xoxb-1234567890-abcdefghij end',
			'key AKIAIOSFODNN7EXAMPLE end',
			'key AIzaSyA1234567890abcdefghijklmnop end',
			'key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end'
		];
		for (const sample of samples) {
			assert.strictEqual(sanitiseReportText(sample, { homeDir: HOME }), `key ${PRIMAL_REPORT_REDACTED} end`, sample);
		}
	});

	test('bearer headers, key=value pairs and query parameters are redacted', () => {
		assert.strictEqual(sanitiseReportText('Authorization: Bearer abc.def-123 end', { homeDir: HOME }), `Authorization: Bearer ${PRIMAL_REPORT_REDACTED} end`);
		assert.strictEqual(sanitiseReportText('api_key=hunter22 end', { homeDir: HOME }), `api_key=${PRIMAL_REPORT_REDACTED} end`);
		assert.strictEqual(sanitiseReportText('"apiKey": "hunter22", next', { homeDir: HOME }), `"apiKey": "${PRIMAL_REPORT_REDACTED}", next`);
		assert.strictEqual(sanitiseReportText('password: hunter22 end', { homeDir: HOME }), `password: ${PRIMAL_REPORT_REDACTED} end`);
		assert.strictEqual(sanitiseReportText('GET https://x.test/a?key=abc123&b=1', { homeDir: HOME }), `GET https://x.test/a?key=${PRIMAL_REPORT_REDACTED}&b=1`);
		assert.strictEqual(sanitiseReportText('GET https://x.test/a?b=1&access_token=abc123', { homeDir: HOME }), `GET https://x.test/a?b=1&access_token=${PRIMAL_REPORT_REDACTED}`);
	});

	test('long hex and mixed base64 blobs are redacted, ordinary text is not', () => {
		const hex = '0123456789abcdef0123456789abcdef01234567';
		assert.strictEqual(sanitiseReportText(`commit ${hex} done`, { homeDir: HOME }), `commit ${PRIMAL_REPORT_REDACTED} done`);
		const blob = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1A=';
		assert.strictEqual(sanitiseReportText(`blob ${blob} done`, { homeDir: HOME }), `blob ${PRIMAL_REPORT_REDACTED} done`);

		const plain = '2026-09-14 19:52:26.123 [info] Started local extension host with pid 4242 in ~/Library/logs/20260914T195226/window1';
		assert.strictEqual(sanitiseReportText(plain, { homeDir: HOME }), plain);
		const lowerOnly = 'proactive_event_tracker-com_apple_trial-com_apple_triald_system_keeps_its_name';
		assert.strictEqual(sanitiseReportText(lowerOnly, { homeDir: HOME }), lowerOnly);
		const shortHash = 'commit 0123456789ab (short) version 1.135.2';
		assert.strictEqual(sanitiseReportText(shortHash, { homeDir: HOME }), shortHash);
	});
});

suite('Primal problem report - tail', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the last N lines and reports the total', () => {
		const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
		const tail = tailLines(text, 3);
		assert.deepStrictEqual(tail.lines, ['line 8', 'line 9', 'line 10']);
		assert.strictEqual(tail.total, 10);
	});

	test('a short text is returned whole and empty text has no lines', () => {
		assert.deepStrictEqual(tailLines('a\r\nb', 5), { lines: ['a', 'b'], total: 2 });
		assert.deepStrictEqual(tailLines('', 5), { lines: [], total: 0 });
	});
});

suite('Primal problem report - collector', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the report states product, OS, look and provider ids in words', () => {
		const report = buildProblemReport(baseInput());
		assert.ok(report.includes('Primal Code 1.135.2'), report);
		assert.ok(report.includes('commit 0123456789ab'), 'short commit');
		assert.ok(report.includes('2026-09-14'), 'build date');
		assert.ok(report.includes('macOS 25.6.0 arm64'), 'os');
		assert.ok(report.includes('Primal Basalt'), 'theme');
		assert.ok(report.includes('basalt'), 'vibe');
		assert.ok(report.includes('static'), 'motif id');
		assert.ok(report.includes('settle'), 'motif motion');
		assert.ok(report.includes('ambient'), 'wallpaper');
		assert.ok(report.includes('anthropic, deepseek'), 'provider ids');
		assert.ok(report.includes('ids only'), 'the report says keys are not included');
		assert.ok(report.includes('main line 2'), 'main log');
		assert.ok(report.includes('renderer line 1'), 'renderer log');
		assert.ok(report.includes('No crash report'), 'crash report line');
	});

	test('a key planted in every input never reaches the report or the title', () => {
		const input = baseInput({
			product: { name: `Primal ${FAKE_KEY}`, version: `1.0 ${FAKE_KEY}`, commit: FAKE_KEY, date: FAKE_KEY },
			os: { name: FAKE_KEY, release: FAKE_KEY, arch: FAKE_KEY, hostname: FAKE_KEY },
			colorTheme: FAKE_KEY,
			vibe: FAKE_KEY,
			motif: { id: FAKE_KEY, motion: FAKE_KEY },
			wallpaperMode: FAKE_KEY,
			providerIds: [FAKE_KEY, 'openai'],
			harnessProviderId: FAKE_KEY,
			mainLog: { text: `saved ${FAKE_KEY}\nAuthorization: Bearer ${FAKE_KEY}\n` },
			rendererLog: { error: `cannot read ${FAKE_KEY}` },
			crashReport: { kind: 'found', fileName: `Primal Code-${FAKE_KEY}.ips` },
			homeDir: `/Users/${FAKE_KEY}`
		});
		const report = buildProblemReport(input);
		const title = buildProblemReportTitle(input);
		assert.ok(!report.includes(FAKE_KEY), report);
		assert.ok(!report.includes('FAKEKEY'), report);
		assert.ok(!title.includes(FAKE_KEY), title);
		assert.ok(!title.includes('FAKEKEY'), title);
		assert.ok(report.includes(PRIMAL_REPORT_REDACTED));
	});

	test('logs are truncated to the last lines and long lines are cut', () => {
		const total = PRIMAL_REPORT_LOG_TAIL_LINES + 50;
		const text = Array.from({ length: total }, (_, i) => `m${i + 1}`).join('\n') + '\n';
		const longLine = 'x'.repeat(PRIMAL_REPORT_MAX_LINE_LENGTH + 100);
		const report = buildProblemReport(baseInput({ mainLog: { text }, rendererLog: { text: `${longLine}\n` } }));
		assert.ok(report.includes(`last ${PRIMAL_REPORT_LOG_TAIL_LINES} of ${total} lines`), report);
		assert.ok(!report.includes('\nm50\n'), 'line 50 was dropped');
		assert.ok(report.includes('\nm51\n'), 'line 51 is the first kept');
		assert.ok(report.includes(`\nm${total}\n`), 'the last line is kept');
		assert.ok(!report.includes(longLine), 'over-long line was cut');
		assert.ok(report.includes('x'.repeat(PRIMAL_REPORT_MAX_LINE_LENGTH) + ' [line cut]'), 'cut marker');
	});

	test('an unreadable log says so instead of pretending it was empty', () => {
		const report = buildProblemReport(baseInput({ mainLog: { error: 'ENOENT: no such file' } }));
		assert.ok(report.includes('Could not read main.log: ENOENT: no such file'), report);
	});

	test('the crash report line names a file, says none, or says why it was not checked', () => {
		assert.ok(buildProblemReport(baseInput({ crashReport: { kind: 'found', fileName: 'Primal Code-2026-09-14-101010.ips' } })).includes('Newest crash report: Primal Code-2026-09-14-101010.ips (file name only)'));
		assert.ok(buildProblemReport(baseInput({ crashReport: { kind: 'none' } })).includes('No crash report for this app was found'));
		assert.ok(buildProblemReport(baseInput({ crashReport: { kind: 'skipped', reason: 'only checked on macOS' } })).includes('Crash reports not checked: only checked on macOS'));
	});

	test('missing commit and date, no providers and a custom vibe are stated in words', () => {
		const report = buildProblemReport(baseInput({
			product: { name: 'Primal Code', version: '1.135.2' },
			providerIds: [],
			harnessProviderId: undefined,
			vibe: 'custom'
		}));
		assert.ok(report.includes('commit unknown'), report);
		assert.ok(report.includes('build date unknown'), report);
		assert.ok(report.includes('Providers with a saved key: none'), report);
		assert.ok(report.includes('Agent provider: not set'), report);
		assert.ok(report.includes('custom'), report);
	});

	test('the title names product, version and OS', () => {
		assert.strictEqual(buildProblemReportTitle(baseInput()), 'Problem report: Primal Code 1.135.2 on macOS arm64');
	});
});

suite('Primal problem report - crash report file', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks the newest file whose name starts with the product name', () => {
		const entries = [
			{ name: 'Safari-2026-09-14-090000.ips', mtime: 900 },
			{ name: 'Primal Code-2026-09-13-090000.ips', mtime: 100 },
			{ name: 'Primal Code Helper (Renderer)-2026-09-14-090000.ips', mtime: 300 },
			{ name: 'primal code-2026-09-14-080000.ips', mtime: 200 }
		];
		assert.strictEqual(newestCrashReportName(entries, 'Primal Code'), 'Primal Code Helper (Renderer)-2026-09-14-090000.ips');
	});

	test('returns undefined when nothing belongs to the app', () => {
		assert.strictEqual(newestCrashReportName([{ name: 'Safari-1.ips', mtime: 1 }], 'Primal Code'), undefined);
		assert.strictEqual(newestCrashReportName([], 'Primal Code'), undefined);
	});
});
