/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { Location } from '../../../../editor/common/languages.js';
import { localize } from '../../../../nls.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';
import { ChatExternalEditKind, IChatThinkingPart, IChatToolInvocation, IChatToolInvocationSerialized } from '../../chat/common/chatService/chatService.js';
import { IChatProgressResponseContent } from '../../chat/common/model/chatModel.js';
import { IRigSessionRow } from '../../primalRig/browser/primalRigSessions.js';
import { firstLineOf } from './primalDeckFormat.js';

/**
 * Pure helpers over chat response parts and session rows for the stream
 * model. Nothing here subscribes, allocates per token or touches the DOM.
 */

/** Text lines show at most this many trailing characters. */
export const TEXT_TAIL_CHARS = 200;

/** Stream rate: chars/s over the last ~2 s, kept in 100 ms buckets. */
const RATE_BUCKET_MS = 100;
const RATE_BUCKET_COUNT = 20;

/** Keys, in priority order, whose string value is the argument the log shows next to a tool name. */
const ARGUMENT_KEYS: readonly string[] = ['filePath', 'file_path', 'path', 'uri', 'resourceUri', 'notebook_path', 'command', 'pattern', 'query', 'url', 'glob', 'description'];

/**
 * Characters per second over the trailing window, from fixed-width time
 * buckets. Adding is O(1), reading is O(20), and the storage never grows.
 */
export class StreamRateMeter {

	private readonly counts = new Float64Array(RATE_BUCKET_COUNT);
	private readonly slots = new Float64Array(RATE_BUCKET_COUNT).fill(-1);

	add(chars: number, now: number): void {
		const slot = Math.floor(now / RATE_BUCKET_MS);
		const index = slot % RATE_BUCKET_COUNT;
		if (this.slots[index] !== slot) {
			this.slots[index] = slot;
			this.counts[index] = 0;
		}
		this.counts[index] += chars;
	}

	/** Chars/s over the window that ends at `now`. */
	rateAt(now: number): number {
		const slot = Math.floor(now / RATE_BUCKET_MS);
		let total = 0;
		for (let index = 0; index < RATE_BUCKET_COUNT; index++) {
			const age = slot - this.slots[index];
			if (this.slots[index] >= 0 && age >= 0 && age < RATE_BUCKET_COUNT) {
				total += this.counts[index];
			}
		}
		return total / (RATE_BUCKET_COUNT * RATE_BUCKET_MS / 1000);
	}

	reset(): void {
		this.counts.fill(0);
		this.slots.fill(-1);
	}
}

function argumentFromRecord(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of ARGUMENT_KEYS) {
		const candidate = record[key];
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate;
		}
	}
	for (const candidate of Object.values(record)) {
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate;
		}
	}
	return undefined;
}

function resourceLabel(value: URI | Location, labelService: ILabelService): string {
	return labelService.getUriLabel(URI.isUri(value) ? value : value.uri, { relative: true });
}

function argumentFromToolData(data: NonNullable<(IChatToolInvocation | IChatToolInvocationSerialized)['toolSpecificData']>, labelService: ILabelService): string | undefined {
	switch (data.kind) {
		case 'terminal':
			return hasKey(data, { commandLine: true })
				? data.commandLine.forDisplay ?? data.commandLine.toolEdited ?? data.commandLine.original
				: data.command;
		case 'subagent':
			return data.description ?? data.agentName;
		case 'input':
			return argumentFromRecord(data.rawInput);
		case 'resources':
			return data.values.length > 0 ? resourceLabel(data.values[0], labelService) : undefined;
		case 'simpleToolInvocation':
			return data.input;
		default:
			return undefined;
	}
}

/**
 * The one argument shown next to a tool name. No single field carries it, so
 * this walks the sources that are actually populated - tool-specific data
 * first, then the streamed or final parameters, then result paths - and ends
 * at the invocation message the chat card itself shows. Returns `undefined`
 * rather than inventing anything when none of them has a value.
 */
export function primaryArgument(part: IChatToolInvocation | IChatToolInvocationSerialized, labelService: ILabelService): string | undefined {
	const data = part.toolSpecificData;
	let argument = data ? argumentFromToolData(data, labelService) : undefined;

	if (!argument && part.kind === 'toolInvocation') {
		const state = part.state.get();
		argument = state.type === IChatToolInvocation.StateKind.Streaming
			? argumentFromRecord(state.partialInput.get())
			: argumentFromRecord(state.parameters);
	}

	if (!argument) {
		const details = IChatToolInvocation.resultDetails(part);
		if (Array.isArray(details) && details.length > 0) {
			argument = resourceLabel(details[0], labelService);
		}
	}

	if (!argument) {
		const message = part.invocationMessage;
		argument = typeof message === 'string' ? message : message.value;
	}

	return argument ? firstLineOf(argument, TEXT_TAIL_CHARS) || undefined : undefined;
}

/**
 * A part produced inside a subagent; the chat model keeps these out of the
 * parent's markdown merge. Only these four kinds carry the marker, so the
 * discriminator narrows the union without an `in` probe.
 */
export function isNestedPart(part: IChatProgressResponseContent): boolean {
	switch (part.kind) {
		case 'codeblockUri':
		case 'hook':
		case 'toolInvocation':
		case 'toolInvocationSerialized':
			return !!part.subAgentInvocationId;
		default:
			return false;
	}
}

/** Length of a thinking part's text without joining its chunks. */
export function thinkingLength(part: IChatThinkingPart): number {
	if (Array.isArray(part.value)) {
		let length = 0;
		for (const chunk of part.value) {
			length += chunk.length;
		}
		return length;
	}
	return part.value?.length ?? 0;
}

export function thinkingText(part: IChatThinkingPart): string {
	return Array.isArray(part.value) ? part.value.join('') : (part.value ?? '');
}

export function formatDiff(added: number, removed: number): string {
	// allow-any-unicode-next-line
	return localize('primalDeck.diff', "+{0} −{1}", added, removed);
}

/** The word for an external edit that carries no diff counts; a plain edit gets none. */
export function editKindWord(kind: ChatExternalEditKind): string {
	switch (kind) {
		case 'create': return localize('primalDeck.edit.created', "created");
		case 'delete': return localize('primalDeck.edit.deleted', "deleted");
		case 'rename': return localize('primalDeck.edit.renamed', "renamed");
		default: return '';
	}
}

function statusRank(status: ChatSessionStatus | undefined): number {
	switch (status) {
		case ChatSessionStatus.InProgress: return 2;
		case ChatSessionStatus.NeedsInput: return 1;
		default: return 0;
	}
}

/** Most recently active first: a running session beats a waiting one beats the rest; ties go to the latest request. */
export function compareSessionRows(a: IRigSessionRow, b: IRigSessionRow): number {
	return (statusRank(a.status) - statusRank(b.status)) || ((a.timestamp ?? 0) - (b.timestamp ?? 0));
}
