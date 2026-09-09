/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService, ThemeSettingTarget } from '../../../../services/themes/common/workbenchThemeService.js';
import { PRIMAL_THEME_PREVIEW_DELAY_MS, PrimalThemePreviewer } from '../../common/primalThemePreviewer.js';

/** One recorded call to `setColorTheme`. */
interface IRecordedCall {
	readonly settingsId: string;
	readonly target: ThemeSettingTarget;
}

function theme(settingsId: string): IWorkbenchColorTheme {
	return { settingsId, label: settingsId } as unknown as IWorkbenchColorTheme;
}

/**
 * A theme service that records what it is asked to do.
 *
 * The point of the whole suite is the TARGET each path uses: 'preview' is
 * transient, `undefined` applies without persisting, and 'auto' is the only one
 * that writes the user's settings.
 */
class RecordingThemeService {

	readonly calls: IRecordedCall[] = [];
	current: IWorkbenchColorTheme = theme('Baseline');

	private listeners: ((theme: IWorkbenchColorTheme) => void)[] = [];

	/**
	 * The real service fires this from `applyTheme` for EVERY target, preview
	 * included, so the stub does too — the previewer's whole superseded-preview
	 * path hangs off telling its own repaint apart from somebody else's.
	 */
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme> = (listener, thisArgs?: unknown): IDisposable => {
		const bound = thisArgs ? listener.bind(thisArgs) : listener;
		this.listeners = [...this.listeners, bound];
		return { dispose: () => { this.listeners = this.listeners.filter(entry => entry !== bound); } };
	};

	getColorTheme(): IWorkbenchColorTheme {
		return this.current;
	}

	async setColorTheme(value: string | undefined | IWorkbenchColorTheme, target: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null> {
		const applied = typeof value === 'object' && value !== null ? value : theme(String(value));
		this.calls.push({ settingsId: applied.settingsId, target });
		this.current = applied;
		for (const listener of this.listeners) {
			listener(applied);
		}
		return applied;
	}

	asService(): IWorkbenchThemeService {
		return this as unknown as IWorkbenchThemeService;
	}
}

/** Waits past the debounce, plus a margin for a slow machine. */
function settle(): Promise<void> {
	return timeout(PRIMAL_THEME_PREVIEW_DELAY_MS + 60);
}

suite('Primal theme previewer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a preview uses the transient target and never persists', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await settle();

		assert.deepStrictEqual(themeService.calls, [{ settingsId: 'Primal Tide', target: 'preview' }]);
	});

	test('a preview is debounced, so arrowing does not repaint per keystroke', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		previewer.preview(theme('Primal Dusk'));
		previewer.preview(theme('Primal Fern'));
		await settle();

		assert.deepStrictEqual(themeService.calls.map(call => call.settingsId), ['Primal Fern']);
	});

	test('reverting restores the baseline WITHOUT persisting it', async () => {
		// The bug this guards: the vibe picker reverted through its apply path,
		// whose target resolves to 'auto', so pressing Escape wrote
		// workbench.colorTheme into the user's settings.json.
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await settle();
		await previewer.revert();

		assert.deepStrictEqual(themeService.calls, [
			{ settingsId: 'Primal Tide', target: 'preview' },
			{ settingsId: 'Baseline', target: undefined }
		]);
		assert.ok(!themeService.calls.some(call => call.target === 'auto'), 'a preview/revert cycle never persists');
	});

	test('reverting with nothing previewed does nothing at all', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		await previewer.revert();
		await previewer.revert();

		assert.strictEqual(themeService.calls.length, 0);
	});

	test('reverting cancels a preview that has not fired yet', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await previewer.revert();
		await settle();

		assert.strictEqual(themeService.calls.length, 0);
	});

	test('applying is the only path that persists, and it moves the baseline', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await settle();
		await previewer.apply(theme('Primal Dusk'));
		await previewer.revert();

		assert.deepStrictEqual(themeService.calls, [
			{ settingsId: 'Primal Tide', target: 'preview' },
			{ settingsId: 'Primal Dusk', target: 'auto' }
		]);
		assert.strictEqual(previewer.baselineTheme.settingsId, 'Primal Dusk');
	});

	test('previewing the applied theme does nothing', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Baseline'));
		await settle();

		assert.strictEqual(themeService.calls.length, 0);
	});

	test('adopting an externally applied theme makes it the baseline without a write', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await settle();
		themeService.current = theme('Primal Fern'); // as applyVibe would leave it
		previewer.adoptAppliedTheme();
		await previewer.revert();

		assert.deepStrictEqual(themeService.calls.map(call => call.target), ['preview']);
		assert.strictEqual(previewer.baselineTheme.settingsId, 'Primal Fern');
	});

	test('a theme applied by another route supersedes the preview, and revert leaves it alone', async () => {
		// The bug this guards: the pane only reverts on Escape, on being hidden and
		// on being closed. Between an in-flight preview and any of those, a vibe
		// cycle or the built-in picker can apply and PERSIST a theme. A previewer
		// that still believed its own preview was on screen would then revert to a
		// stale baseline, leaving the workbench wearing a theme that disagrees with
		// workbench.colorTheme until the next reload.
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await settle();
		await themeService.setColorTheme(theme('Primal Ridge'), 'auto');
		await previewer.revert();

		assert.deepStrictEqual(themeService.calls, [
			{ settingsId: 'Primal Tide', target: 'preview' },
			{ settingsId: 'Primal Ridge', target: 'auto' }
		], 'revert added no call of its own');
		assert.strictEqual(previewer.baselineTheme.settingsId, 'Primal Ridge');
	});

	test('a theme applied by another route also abandons a preview that has not fired yet', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await themeService.setColorTheme(theme('Primal Ridge'), 'auto');
		await settle();

		assert.deepStrictEqual(themeService.calls.map(call => call.settingsId), ['Primal Ridge']);
		assert.strictEqual(previewer.baselineTheme.settingsId, 'Primal Ridge');
	});

	test('capturing a baseline mid-preview does not adopt the previewed theme', async () => {
		const themeService = new RecordingThemeService();
		const previewer = store.add(new PrimalThemePreviewer(themeService.asService(), new NullLogService()));

		previewer.preview(theme('Primal Tide'));
		await settle();
		previewer.captureBaseline();

		assert.strictEqual(previewer.baselineTheme.settingsId, 'Baseline');
	});
});
