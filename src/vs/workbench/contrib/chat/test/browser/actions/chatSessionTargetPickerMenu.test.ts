/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IMenuItem, isIMenuItem, MenuId, MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { ContextKeyValue, IContext } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../../../common/contextkeys.js';
import { OpenSessionTargetPickerAction, registerChatExecuteActions } from '../../../browser/actions/chatExecuteActions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../../common/constants.js';

/**
 * The session-target picker is how an empty session gets an agent behind it. This product ships
 * no default chat participant: `chatIsEnabled` only turns true once an agent-host dynamic agent has
 * registered, so the picker must be offered — and usable — before that, or the user has no way to
 * pick the agent that would enable chat.
 */
suite('Chat input — session target picker menu contribution', () => {

	const disposables = new DisposableStore();

	suiteSetup(() => {
		disposables.add(registerChatExecuteActions());
	});

	suiteTeardown(() => {
		disposables.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** An empty chat session in the main window's chat view, before any agent has registered. */
	const emptyMainWindowSessionContext: Record<string, ContextKeyValue> = {
		[ChatContextKeys.location.key]: ChatAgentLocation.Chat,
		[ChatContextKeys.inQuickChat.key]: false,
		[ChatContextKeys.chatSessionIsEmpty.key]: true,
		[IsSessionsWindowContext.key]: false,
		[ChatContextKeys.enabled.key]: false,
		[ChatContextKeys.currentlyEditingInput.key]: false,
		[ChatContextKeys.currentlyEditing.key]: false,
	};

	function createContext(overrides: Record<string, ContextKeyValue> = {}): IContext {
		const values: Record<string, ContextKeyValue> = { ...emptyMainWindowSessionContext, ...overrides };
		return { getValue: <T extends ContextKeyValue>(key: string): T | undefined => values[key] as T | undefined };
	}

	function pickerItems(ctx: IContext): { readonly shown: IMenuItem[]; readonly enabled: IMenuItem[] } {
		const shown = MenuRegistry.getMenuItems(MenuId.ChatInput)
			.filter(isIMenuItem)
			.filter(item => item.command.id === OpenSessionTargetPickerAction.ID)
			.filter(item => !item.when || item.when.evaluate(ctx));
		const enabled = shown.filter(item => !item.command.precondition || item.command.precondition.evaluate(ctx));
		return { shown, enabled };
	}

	test('is shown and enabled on the input toolbar of an empty main-window session before any agent has registered', () => {
		const { shown, enabled } = pickerItems(createContext());
		assert.deepStrictEqual({ shown: shown.length, enabled: enabled.length }, { shown: 1, enabled: 1 });
	});

	test('is shown and enabled in the sessions window too', () => {
		const { shown, enabled } = pickerItems(createContext({ [IsSessionsWindowContext.key]: true }));
		assert.deepStrictEqual({ shown: shown.length, enabled: enabled.length }, { shown: 1, enabled: 1 });
	});

	test('is not offered once the session has a request', () => {
		const { shown } = pickerItems(createContext({ [ChatContextKeys.chatSessionIsEmpty.key]: false }));
		assert.strictEqual(shown.length, 0);
	});

	test('is not offered in quick chat', () => {
		const { shown } = pickerItems(createContext({ [ChatContextKeys.inQuickChat.key]: true }));
		assert.strictEqual(shown.length, 0);
	});
});
