/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILanguageModelChatMetadataAndIdentifier } from '../../../common/languageModels.js';
import { findBestMatchingModel } from './chatInputModelUtils.js';

/**
 * Whether the selected chat model can answer in the session the input is bound to, and what to
 * do when it cannot. Every outcome other than {@link ModelSessionFitKind.Fits} used to be a
 * silent state: the picker kept showing a model the session would never run, and Enter either
 * did nothing (submit precondition false) or quietly answered with a different model.
 */
export const enum ModelSessionFitKind {
	/** The selected model (or the session default, when nothing is selected) can answer here. */
	Fits = 'fits',
	/** The same model is published in this session's pool under another identifier: use that one. */
	UseMatchingModel = 'useMatchingModel',
	/** The model cannot answer here; the session default answers instead, and the user is told. */
	UseSessionDefault = 'useSessionDefault',
	/** Nothing here can answer, but the model runs in another session type: offer to switch. */
	SwitchSession = 'switchSession',
	/** The session owns its model pool and has not published it yet; sending is blocked meanwhile. */
	AwaitingSessionModels = 'awaitingSessionModels',
	/** No model can answer in this session and there is nothing to wait for. */
	NoModelAvailable = 'noModelAvailable',
}

export type ModelSessionFit =
	| { readonly kind: ModelSessionFitKind.Fits }
	| { readonly kind: ModelSessionFitKind.UseMatchingModel; readonly model: ILanguageModelChatMetadataAndIdentifier }
	| {
		readonly kind: ModelSessionFitKind.UseSessionDefault;
		readonly rejectedModel: ILanguageModelChatMetadataAndIdentifier;
		/** The model that answers instead, or `undefined` when the session picks its own default. */
		readonly defaultModel: ILanguageModelChatMetadataAndIdentifier | undefined;
		/** A session type known to run the rejected model, when it declares one. */
		readonly runsInSessionType: string | undefined;
	}
	| { readonly kind: ModelSessionFitKind.SwitchSession; readonly rejectedModel: ILanguageModelChatMetadataAndIdentifier; readonly targetSessionType: string }
	| { readonly kind: ModelSessionFitKind.AwaitingSessionModels; readonly rejectedModel: ILanguageModelChatMetadataAndIdentifier | undefined }
	| { readonly kind: ModelSessionFitKind.NoModelAvailable; readonly rejectedModel: ILanguageModelChatMetadataAndIdentifier | undefined };

export interface IModelSessionFitInput {
	readonly selectedModel: ILanguageModelChatMetadataAndIdentifier | undefined;
	readonly sessionType: string | undefined;
	/** The models that can answer in the session, already filtered by session, mode and visibility. */
	readonly sessionPool: readonly ILanguageModelChatMetadataAndIdentifier[];
	/** The pool's default (declared for the location, else its first entry). */
	readonly defaultModel: ILanguageModelChatMetadataAndIdentifier | undefined;
	/** Whether the session type owns its pool, so an empty pool means "not published yet". */
	readonly sessionRequiresCustomModels: boolean;
	/** Whether the session can answer with its synthetic Auto model when nothing is selected. */
	readonly sessionSupportsAutoModel: boolean;
}

/** The session type a model declares itself for, when that is not the session at hand. */
function otherSessionTypeRunning(model: ILanguageModelChatMetadataAndIdentifier, sessionType: string | undefined): string | undefined {
	const target = model.metadata.targetChatSessionType;
	return target && target !== sessionType ? target : undefined;
}

export function resolveModelSessionFit(input: IModelSessionFitInput): ModelSessionFit {
	const { selectedModel, sessionType, sessionPool } = input;

	if (sessionPool.length > 0) {
		if (!selectedModel || sessionPool.some(model => model.identifier === selectedModel.identifier)) {
			return { kind: ModelSessionFitKind.Fits };
		}
		const match = findBestMatchingModel(selectedModel, sessionPool);
		if (match) {
			return { kind: ModelSessionFitKind.UseMatchingModel, model: match };
		}
		return {
			kind: ModelSessionFitKind.UseSessionDefault,
			rejectedModel: selectedModel,
			defaultModel: input.defaultModel,
			runsInSessionType: otherSessionTypeRunning(selectedModel, sessionType),
		};
	}

	const runsElsewhere = selectedModel ? otherSessionTypeRunning(selectedModel, sessionType) : undefined;
	if (selectedModel && runsElsewhere) {
		return { kind: ModelSessionFitKind.SwitchSession, rejectedModel: selectedModel, targetSessionType: runsElsewhere };
	}
	if (input.sessionSupportsAutoModel) {
		// Sending is not blocked, but a foreign selection is dropped by the session and its own
		// default answers: say so rather than keep showing a model that will not be answering.
		return selectedModel
			? { kind: ModelSessionFitKind.UseSessionDefault, rejectedModel: selectedModel, defaultModel: undefined, runsInSessionType: undefined }
			: { kind: ModelSessionFitKind.Fits };
	}
	return input.sessionRequiresCustomModels
		? { kind: ModelSessionFitKind.AwaitingSessionModels, rejectedModel: selectedModel }
		: { kind: ModelSessionFitKind.NoModelAvailable, rejectedModel: selectedModel };
}
