/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The first-run guide's step logic: inputs in, step states out.
 *
 * This file is PURE on purpose - no services, no DOM, no strings for the eye.
 * Everything that observes the world (storage, secrets, the model catalogue,
 * the vibe engine) lives in `primalFirstRunService.ts`; everything that talks
 * to the reader lives in `primalFirstRunStrip.ts`. What is left here is the
 * one decision worth testing exhaustively: given what is true, which step is
 * done, which is the one to do now, and whether the guide is finished.
 */

/** The three steps, in the order the strip shows them. */
export const enum FirstRunStepId {
	Vibe = 'vibe',
	Model = 'model',
	Start = 'start',
}

export const FIRST_RUN_STEP_ORDER: readonly FirstRunStepId[] = [FirstRunStepId.Vibe, FirstRunStepId.Model, FirstRunStepId.Start];

/**
 * A step is `Done`, or it is the single `Current` one (the first that is not
 * done), or it is `Next` (waiting behind the current one). The strip states
 * these in words and a glyph; nothing here is a colour.
 */
export const enum FirstRunStepStatus {
	Done = 'done',
	Current = 'current',
	Next = 'next',
}

/**
 * Where the agent's model access comes from, as detected - never assumed.
 * `checking` is the first look still under way: the agent host answers the
 * model pull a few seconds after launch, and until it has, or the wait is
 * up, the guide must not claim that nothing is there.
 */
export type FirstRunModelSource =
	| { readonly kind: 'claudeLogin' }
	| { readonly kind: 'keys'; readonly providerIds: readonly string[]; readonly claudeLogin: boolean }
	| { readonly kind: 'checking' }
	| { readonly kind: 'none' };

export interface IFirstRunInputs {
	/** The user changed the vibe, or explicitly kept the default. */
	readonly vibeChosen: boolean;
	/** An existing Claude Code login was detected on this machine. */
	readonly claudeLoginDetected: boolean;
	/** Provider ids that have an API key in secret storage. */
	readonly configuredProviderIds: readonly string[];
	/** A session was started or a folder / repository was opened. */
	readonly started: boolean;
	/** The first look at secrets and the model catalogue has finished (or timed out). */
	readonly detectionSettled: boolean;
}

export interface IFirstRunStep {
	readonly id: FirstRunStepId;
	readonly status: FirstRunStepStatus;
}

export interface IFirstRunGuide {
	readonly steps: readonly IFirstRunStep[];
	readonly modelSource: FirstRunModelSource;
	/** Every step is done. */
	readonly complete: boolean;
}

/**
 * The provider ids that actually carry a key: blanks dropped, duplicates
 * removed, first-seen order kept. Secret storage is external data.
 */
function sanitizeProviderIds(ids: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const id of ids) {
		const trimmed = id.trim();
		if (trimmed.length > 0 && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}

export function resolveModelSource(claudeLoginDetected: boolean, configuredProviderIds: readonly string[], detectionSettled: boolean): FirstRunModelSource {
	const providerIds = sanitizeProviderIds(configuredProviderIds);
	if (providerIds.length > 0) {
		return { kind: 'keys', providerIds, claudeLogin: claudeLoginDetected };
	}
	if (claudeLoginDetected) {
		return { kind: 'claudeLogin' };
	}
	return detectionSettled ? { kind: 'none' } : { kind: 'checking' };
}

/** A model is connected when something real was found; looking is not finding. */
function isModelConnected(source: FirstRunModelSource): boolean {
	return source.kind === 'claudeLogin' || source.kind === 'keys';
}

/** Whether each step is done, before the current marker is placed. */
function doneByStep(inputs: IFirstRunInputs, modelSource: FirstRunModelSource): ReadonlyMap<FirstRunStepId, boolean> {
	return new Map([
		[FirstRunStepId.Vibe, inputs.vibeChosen],
		[FirstRunStepId.Model, isModelConnected(modelSource)],
		[FirstRunStepId.Start, inputs.started],
	]);
}

export function computeFirstRunGuide(inputs: IFirstRunInputs): IFirstRunGuide {
	const modelSource = resolveModelSource(inputs.claudeLoginDetected, inputs.configuredProviderIds, inputs.detectionSettled);
	const done = doneByStep(inputs, modelSource);

	let currentPlaced = false;
	const steps: IFirstRunStep[] = FIRST_RUN_STEP_ORDER.map(id => {
		if (done.get(id)) {
			return { id, status: FirstRunStepStatus.Done };
		}
		if (!currentPlaced) {
			currentPlaced = true;
			return { id, status: FirstRunStepStatus.Current };
		}
		return { id, status: FirstRunStepStatus.Next };
	});

	return { steps, modelSource, complete: !currentPlaced };
}
