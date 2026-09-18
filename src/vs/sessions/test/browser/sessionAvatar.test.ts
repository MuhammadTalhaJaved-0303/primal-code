/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { SESSION_AVATAR_CLASS, SessionAvatar, avatarExpressionFor, avatarFeaturesFor } from '../../browser/sessionAvatar.js';
import { SessionStatus } from '../../services/sessions/common/session.js';

suite('Sessions - avatar', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the same session always gets the same face', () => {
		assert.deepStrictEqual(avatarFeaturesFor('session:abc'), avatarFeaturesFor('session:abc'));
	});

	test('different sessions get different faces, spread across the whole range of features', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			seen.add(JSON.stringify(avatarFeaturesFor(`claude:/${i}-${i * 7919}`)));
		}
		// Three eye shapes, two spacings, three mouths and a brow give 36 faces;
		// two hundred sessions should meet most of them, not cluster on a few.
		assert.ok(seen.size >= 30, `only ${seen.size} distinct faces from 200 sessions`);
	});

	test('the expression is the state, said in a word', () => {
		const word = (status: SessionStatus) => avatarExpressionFor(status, true, false).mood;
		assert.deepStrictEqual({
			untitled: word(SessionStatus.Untitled),
			inProgress: word(SessionStatus.InProgress),
			needsInput: word(SessionStatus.NeedsInput),
			completed: word(SessionStatus.Completed),
			error: word(SessionStatus.Error),
		}, {
			untitled: 'ready',
			inProgress: 'working',
			needsInput: 'waiting',
			completed: 'done',
			error: 'failed',
		});
	});

	test('unread and archived ride along as their own flags, never as a colour', () => {
		assert.deepStrictEqual(avatarExpressionFor(SessionStatus.Completed, false, true), { mood: 'done', unread: true, archived: true });
	});

	test('renders one face per session that changes expression in place, and says its state', () => {
		const container = mainWindow.document.createElement('div');
		const avatar = store.add(new SessionAvatar(container, avatarFeaturesFor('session:one')));
		const svg = container.querySelector(`.${SESSION_AVATAR_CLASS}`);
		assert.ok(svg, 'an avatar is rendered');

		avatar.update(avatarExpressionFor(SessionStatus.InProgress, true, false), false);
		const working = { classes: [...svg!.classList], label: svg!.getAttribute('aria-label') };
		avatar.update(avatarExpressionFor(SessionStatus.NeedsInput, false, false), false);
		const waiting = { classes: [...svg!.classList], label: svg!.getAttribute('aria-label') };

		assert.strictEqual(container.querySelectorAll(`.${SESSION_AVATAR_CLASS}`).length, 1, 'the same element, not a replacement');
		assert.ok(working.classes.includes('mood-working') && !working.classes.includes('unread'));
		assert.ok(waiting.classes.includes('mood-waiting') && waiting.classes.includes('unread'));
		assert.notStrictEqual(working.label, waiting.label, 'the state is spoken, so it changes with the state');
		assert.ok(/wait/i.test(waiting.label ?? ''), `got '${waiting.label}'`);
	});

	test('reduced motion is a class the stylesheet keys every animation on', () => {
		const container = mainWindow.document.createElement('div');
		const avatar = store.add(new SessionAvatar(container, avatarFeaturesFor('session:two')));
		avatar.update(avatarExpressionFor(SessionStatus.InProgress, true, false), true);
		assert.ok(container.querySelector(`.${SESSION_AVATAR_CLASS}`)!.classList.contains('still'));
		avatar.update(avatarExpressionFor(SessionStatus.InProgress, true, false), false);
		assert.ok(!container.querySelector(`.${SESSION_AVATAR_CLASS}`)!.classList.contains('still'));
	});

	test('the features are carried as classes, so the stylesheet can draw the face', () => {
		const container = mainWindow.document.createElement('div');
		const features = avatarFeaturesFor('session:three');
		store.add(new SessionAvatar(container, features));
		const classes = [...container.querySelector(`.${SESSION_AVATAR_CLASS}`)!.classList];
		assert.ok(classes.includes(`eyes-${features.eyes}`) && classes.includes(`mouth-${features.mouth}`) && classes.includes(`gap-${features.gap}`), classes.join(' '));
	});
});
