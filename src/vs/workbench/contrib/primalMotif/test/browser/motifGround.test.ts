/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_WALLPAPER_ON_CLASS } from '../../../primalWallpaper/browser/primalWallpaper.js';
import { groundPaintsIn, PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES } from '../../browser/primalMotif.js';

/** The class list of a workbench element, as the rule sees it. */
const classes = (...names: readonly string[]) => Object.freeze({ contains: (token: string) => names.includes(token) });

suite('Primal Motif - ground', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Agents window is not a chrome design that opts out of the ground', () => {
		// It loads the same wallpaper and motif contributions as the IDE window,
		// and a motif chosen once is the motif of every window.
		assert.ok(!PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES.includes('agent-sessions-workbench'));
	});

	test('the modern UI chrome still opts out, because its stylesheets hide the layer', () => {
		assert.ok(PRIMAL_MOTIF_CHROME_OPT_OUT_CLASSES.includes('modern-ui'));
	});

	test('paints in the Agents window once the wallpaper is on', () => {
		assert.strictEqual(groundPaintsIn(classes('monaco-workbench', 'agent-sessions-workbench', PRIMAL_WALLPAPER_ON_CLASS)), true);
	});

	test('does not paint while the wallpaper is off', () => {
		assert.strictEqual(groundPaintsIn(classes('monaco-workbench', 'agent-sessions-workbench')), false);
	});

	test('does not paint under a chrome design that opts out, wallpaper or not', () => {
		assert.strictEqual(groundPaintsIn(classes('monaco-workbench', 'modern-ui', PRIMAL_WALLPAPER_ON_CLASS)), false);
	});

	test('reads a live DOMTokenList the same way, so the scheduler can pass classList straight through', () => {
		const element = $('.monaco-workbench.agent-sessions-workbench');
		element.classList.add(PRIMAL_WALLPAPER_ON_CLASS);
		assert.strictEqual(groundPaintsIn(element.classList), true);
		element.classList.add('modern-ui');
		assert.strictEqual(groundPaintsIn(element.classList), false);
	});
});
