/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IAgentSession } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';
import { IChatDetail, ResponseModelState, convertLegacyChatSessionTiming } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { IChatModel } from '../../chat/common/model/chatModel.js';

/**
 * One row of the Rig's "Agent activity" list.
 *
 * Everything here is read off recorded state. `status` is deliberately
 * `undefined` whenever no source can report it truthfully — the page renders no
 * chip at all rather than defaulting a row to "done".
 */
export interface IRigSessionRow {
	/** The session's resource; also the row's identity when merging sources. */
	readonly resource: URI;
	readonly label: string;
	/** `undefined` means "not knowable yet" — render no status chip. */
	readonly status: ChatSessionStatus | undefined;
	/** Epoch ms: the most recent request start, else session creation. */
	readonly timestamp: number | undefined;
	/** Present when the row came from the agent sessions model; used to open it. */
	readonly session: IAgentSession | undefined;
}

/** The timing shape shared by `IChatModel.timing` and `IAgentSession.timing`. */
interface ISessionTiming {
	readonly created: number;
	readonly lastRequestStarted: number | undefined;
}

/**
 * Prefers the most recent request start and falls back to session creation —
 * both are real epoch-ms values recorded by the chat service. Never invents one.
 */
function timestampOf(timing: ISessionTiming | undefined): number | undefined {
	const value = timing?.lastRequestStarted ?? timing?.created;
	return typeof value === 'number' && value > 0 ? value : undefined;
}

/**
 * Running / waiting / done for a live in-window model.
 *
 * This is the only synchronous source that can report in-flight state: the
 * agent sessions cache rewrites in-progress sessions to "completed" before
 * storing them, and the persisted chat index rewrites pending responses to
 * "cancelled". Returns `undefined` for a session with no response yet.
 */
export function liveSessionStatus(model: IChatModel): ChatSessionStatus | undefined {
	if (model.requestInProgress.get()) {
		return ChatSessionStatus.InProgress;
	}

	if (model.requestNeedsInput.get()) {
		return ChatSessionStatus.NeedsInput;
	}

	const state = model.getRequests().at(-1)?.response?.state;
	switch (state) {
		case ResponseModelState.Pending:
			return ChatSessionStatus.InProgress;
		case ResponseModelState.NeedsInput:
			return ChatSessionStatus.NeedsInput;
		case ResponseModelState.Failed:
			return ChatSessionStatus.Failed;
		case ResponseModelState.Cancelled:
		case ResponseModelState.Complete:
			return ChatSessionStatus.Completed;
		default:
			return undefined; // no response recorded: nothing truthful to say
	}
}

/**
 * Rows for the chat sessions that are live in this window: real chat sessions
 * only, and only once they have actually run something. That second half is the
 * same `hasRequests` line upstream's own session list draws
 * (`localAgentSessionsController.toChatSessionItem`, "ignore sessions without
 * requests") - the workbench keeps an empty session around whenever the chat
 * view is shown with nothing to restore, and an empty session is not activity.
 */
export function liveSessionRows(models: Iterable<IChatModel>): IRigSessionRow[] {
	const rows: IRigSessionRow[] = [];

	for (const model of models) {
		if (model.initialLocation !== ChatAgentLocation.Chat || !model.hasRequests) {
			continue;
		}

		rows.push({
			resource: model.sessionResource,
			label: model.title,
			status: liveSessionStatus(model),
			timestamp: timestampOf(model.timing),
			session: undefined
		});
	}

	return rows;
}

/**
 * Rows for the sessions the agent sessions model knows about.
 *
 * `resolvedProviders` gates the status on purpose, and it is deliberately a set
 * of provider types rather than one flag: until a given provider has resolved,
 * its sessions are still the ones the model's constructor read out of the
 * synchronous cache, and that cache stores every in-progress session as
 * "completed", so a status read there could only lie. Providers resolve
 * independently and at wildly different speeds - one is local, another is an
 * extension host round trip, another is a network call - so a session is only
 * given a chip once its own provider has reported.
 */
export function agentSessionRows(sessions: readonly IAgentSession[], resolvedProviders: ReadonlySet<string>): IRigSessionRow[] {
	const rows: IRigSessionRow[] = [];

	for (const session of sessions) {
		if (session.isArchived()) {
			continue;
		}

		rows.push({
			resource: session.resource,
			label: session.label,
			status: resolvedProviders.has(session.providerType) ? session.status : undefined,
			timestamp: timestampOf(session.timing),
			session
		});
	}

	return rows;
}

/**
 * Merges both sources into one most-recent-first list. A live model wins on
 * status and timing — it is the only truthful in-flight source — while the
 * agent session it shadows is carried along so the row can still be opened.
 */
export function mergeSessionRows(live: readonly IRigSessionRow[], fromModel: readonly IRigSessionRow[], max: number): IRigSessionRow[] {
	const byResource = new Map<string, IRigSessionRow>();

	for (const row of fromModel) {
		byResource.set(row.resource.toString(), row);
	}

	for (const row of live) {
		const key = row.resource.toString();
		const shadowed = byResource.get(key);
		byResource.set(key, shadowed ? { ...row, session: shadowed.session } : row);
	}

	return Array.from(byResource.values())
		.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
		.slice(0, max);
}

/**
 * How many of the given chat sessions actually ran a request during the local
 * day containing `now`.
 *
 * The only field that can carry that claim is `lastRequestStarted` - the
 * epoch-ms start of the session's most recent request, recorded by the chat
 * model itself. A session that never ran a request has none, and is not
 * counted: the workbench opens an empty session whenever the chat view is shown
 * with nothing to restore, so falling back to a creation-time stamp would turn
 * merely opening chat into a claim of a day's work. Nothing real is lost -
 * every session that has run something has the field set, including legacy
 * persisted entries, whose start time `convertLegacyChatSessionTiming` maps
 * onto it.
 */
export function countSessionsToday(details: readonly IChatDetail[], now: number): number {
	const dayStart = new Date(now);
	dayStart.setHours(0, 0, 0, 0);
	const nextDayStart = new Date(dayStart);
	nextDayStart.setDate(nextDayStart.getDate() + 1);

	const start = dayStart.getTime();
	const end = nextDayStart.getTime();

	const seen = new Set<string>();
	let count = 0;

	for (const detail of details) {
		const key = detail.sessionResource.toString();
		if (seen.has(key)) {
			continue; // live and history lists are disjoint, but never count twice
		}
		seen.add(key);

		const when = convertLegacyChatSessionTiming(detail.timing).lastRequestStarted;
		if (typeof when === 'number' && when >= start && when < end) {
			count++;
		}
	}

	return count;
}
