/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { PRIMAL_OPEN_SETTINGS_COMMAND_ID } from '../../../../../../platform/agentHost/common/primalProviders.js';
import { getAgentSessionProviderName } from '../../agentSessions/agentSessions.js';
import { ModelSessionFit, ModelSessionFitKind } from './chatInputModelSessionFit.js';
import { ChatInputNotificationActionKind, ChatInputNotificationSeverity, IChatInputNotification, IChatInputNotificationAction, IChatInputNotificationService } from './chatInputNotificationService.js';

/** Re-queries the bound session type's model provider; argument: the session resource. */
export const ReloadSessionModelsCommandId = 'workbench.action.chat.reloadSessionModels';

const NOTIFICATION_ID_PREFIX = 'chat.input.modelSessionFit';
let instanceCounter = 0;

export interface IChatInputModelFitNoticeScope {
	readonly sessionResource: URI | undefined;
	readonly sessionType: string | undefined;
	/** Where a replacement session opens when the user takes the switch action. */
	readonly newSessionPosition: 'sidebar' | 'editor';
}

function switchSessionAction(sessionType: string, position: 'sidebar' | 'editor'): IChatInputNotificationAction {
	return {
		kind: ChatInputNotificationActionKind.Command,
		label: localize('chat.modelFit.switchSession', "Switch to {0} session", getAgentSessionProviderName(sessionType)),
		commandId: `workbench.action.chat.openNewChatSessionInPlace.${sessionType}`,
		commandArgs: [position],
	};
}

const chooseModelAction: IChatInputNotificationAction = {
	kind: ChatInputNotificationActionKind.OpenModelPicker,
	label: localize('chat.modelFit.chooseModel', "Choose model"),
	keepOpen: true,
};

/**
 * The words for a fit that is not a fit. `undefined` for outcomes that need no notice: a fit, or
 * a same-model re-route the user does not need to hear about.
 */
export function describeModelSessionFit(fit: ModelSessionFit, scope: IChatInputModelFitNoticeScope): Pick<IChatInputNotification, 'severity' | 'message' | 'description' | 'actions'> | undefined {
	const sessionName = scope.sessionType ? getAgentSessionProviderName(scope.sessionType) : undefined;
	const thisSession = sessionName
		? localize('chat.modelFit.thisNamedSession', "this {0} session", sessionName)
		: localize('chat.modelFit.thisSession', "this session");
	switch (fit.kind) {
		case ModelSessionFitKind.Fits:
		case ModelSessionFitKind.UseMatchingModel:
			return undefined;
		case ModelSessionFitKind.SwitchSession: {
			const targetName = getAgentSessionProviderName(fit.targetSessionType);
			return {
				severity: ChatInputNotificationSeverity.Warning,
				message: localize('chat.modelFit.runsElsewhere', "{0} runs in a {1} session, not {2}.", fit.rejectedModel.metadata.name, targetName, thisSession),
				description: localize('chat.modelFit.runsElsewhere.detail', "Switch to a {0} session to use it, or choose a model this session can run.", targetName),
				actions: [
					{ ...chooseModelAction, label: localize('chat.modelFit.chooseAnotherModel', "Choose another model") },
					switchSessionAction(fit.targetSessionType, scope.newSessionPosition),
				],
			};
		}
		case ModelSessionFitKind.UseSessionDefault:
			return {
				severity: ChatInputNotificationSeverity.Warning,
				message: localize('chat.modelFit.useDefault', "{0} can't answer in {1}.", fit.rejectedModel.metadata.name, thisSession),
				description: fit.defaultModel
					? localize('chat.modelFit.useDefault.named', "{0} will answer instead.", fit.defaultModel.metadata.name)
					: localize('chat.modelFit.useDefault.unnamed', "This session's default model will answer instead."),
				actions: [
					chooseModelAction,
					...(fit.runsInSessionType ? [switchSessionAction(fit.runsInSessionType, scope.newSessionPosition)] : []),
				],
			};
		case ModelSessionFitKind.AwaitingSessionModels:
			return {
				severity: ChatInputNotificationSeverity.Warning,
				message: sessionName
					? localize('chat.modelFit.awaiting.named', "No {0} model has loaded yet, so this session can't send.", sessionName)
					: localize('chat.modelFit.awaiting', "No model has loaded yet, so this session can't send."),
				description: fit.rejectedModel
					? (sessionName
						? localize('chat.modelFit.awaiting.rejected.named', "{0} can't answer here. Sending is blocked until a {1} model is available.", fit.rejectedModel.metadata.name, sessionName)
						: localize('chat.modelFit.awaiting.rejected', "{0} can't answer here. Sending is blocked until a model is available.", fit.rejectedModel.metadata.name))
					: (sessionName
						? localize('chat.modelFit.awaiting.detail.named', "Sending is blocked until a {0} model is available.", sessionName)
						: localize('chat.modelFit.awaiting.detail', "Sending is blocked until a model is available.")),
				actions: [
					chooseModelAction,
					{
						kind: ChatInputNotificationActionKind.Command,
						label: localize('chat.modelFit.retry', "Retry loading models"),
						commandId: ReloadSessionModelsCommandId,
						commandArgs: scope.sessionResource ? [scope.sessionResource] : [],
						keepOpen: true,
					},
				],
			};
		case ModelSessionFitKind.NoModelAvailable:
			return {
				severity: ChatInputNotificationSeverity.Warning,
				message: localize('chat.modelFit.none', "No model can answer in {0}.", thisSession),
				description: fit.rejectedModel
					? localize('chat.modelFit.none.rejected', "{0} can't answer here, and this session has no model of its own.", fit.rejectedModel.metadata.name)
					: localize('chat.modelFit.none.detail', "Add a model in Settings, or switch to another session."),
				actions: [
					chooseModelAction,
					{
						kind: ChatInputNotificationActionKind.Command,
						label: localize('chat.modelFit.openSettings', "Open Settings"),
						commandId: PRIMAL_OPEN_SETTINGS_COMMAND_ID,
					},
				],
			};
	}
}

interface IShownNotice {
	readonly scopeKey: string;
	readonly kind: ModelSessionFitKind;
	readonly message: string;
	readonly description: string;
}

/**
 * Puts a model/session mismatch into words above the chat input, using the input's own
 * notification lane, and takes it down again when the mismatch is gone.
 */
export class ChatInputModelFitNotice extends Disposable {

	private readonly _notificationId = `${NOTIFICATION_ID_PREFIX}.${++instanceCounter}`;
	private _shown: IShownNotice | undefined;

	constructor(
		@IChatInputNotificationService private readonly _notificationService: IChatInputNotificationService,
	) {
		super();
		this._register(toDisposable(() => this.clear()));
	}

	update(fit: ModelSessionFit, scope: IChatInputModelFitNoticeScope): void {
		const scopeKey = `${scope.sessionResource?.toString() ?? ''}|${scope.sessionType ?? ''}`;
		const content = describeModelSessionFit(fit, scope);
		if (!content) {
			// A fallback that was applied and explained reads as a fit on the next check; the
			// explanation stays until the user acts on it or sends.
			const keepExplainedFallback = fit.kind === ModelSessionFitKind.Fits
				&& this._shown?.kind === ModelSessionFitKind.UseSessionDefault
				&& this._shown.scopeKey === scopeKey;
			if (!keepExplainedFallback) {
				this.clear();
			}
			return;
		}
		const message = typeof content.message === 'string' ? content.message : content.message.value;
		const description = typeof content.description === 'string' ? content.description : content.description?.value ?? '';
		if (this._shown && this._shown.scopeKey === scopeKey && this._shown.kind === fit.kind && this._shown.message === message && this._shown.description === description) {
			return; // unchanged: re-setting would clear a dismissal and re-render
		}
		this._notificationService.setNotification({
			id: this._notificationId,
			...content,
			dismissible: true,
			autoDismissOnMessage: true,
			sessionResources: scope.sessionResource ? [scope.sessionResource] : undefined,
			sessionTypes: !scope.sessionResource && scope.sessionType ? [scope.sessionType] : undefined,
		});
		this._shown = { scopeKey, kind: fit.kind, message, description };
	}

	clear(): void {
		if (this._shown) {
			this._shown = undefined;
			this._notificationService.deleteNotification(this._notificationId);
		}
	}
}
