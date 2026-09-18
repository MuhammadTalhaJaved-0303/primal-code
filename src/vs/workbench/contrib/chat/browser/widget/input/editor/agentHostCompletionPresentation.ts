/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../base/common/uri.js';
import { CompletionItemKind, CompletionItemLabel } from '../../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../../nls.js';

/**
 * Primal Code - how a `/` completion from the agent host is presented.
 *
 * The host hands back one flat list: built-in commands, the user's own
 * skills, skills and commands that plugins contribute, and prompts that MCP
 * servers expose, all as `/name` with a description. Shown as they arrive,
 * that is a wall of identical rows whose only difference is a long sentence
 * truncated to fit - which is what the owner saw, and called badly formatted.
 *
 * This puts structure on it without asking the host for anything new:
 *
 * - WHERE IT CAME FROM is read off the name and, for a skill, its path. A plugin
 *   command is `plugin:name`; an MCP prompt is `mcp__server__name`; a plugin's
 *   skill lives under the plugin cache. Everything else is a command or a skill.
 * - THE GROUPS SORT IN A FIXED ORDER - commands, skills, plugins, MCP - and
 *   alphabetically within, so the list reads the same way every time.
 * - A ROW IS THREE THINGS: the name, one short sentence inline, and the source
 *   at the right in words ("skill", "plugin · vercel", "MCP · github"). The
 *   whole description goes to the details pane, where there is room for it.
 * - EACH GROUP HAS ITS OWN ICON. The owner is colour blind and the suggest
 *   widget's icons are shapes, so the grouping is legible without hue.
 */

export type AgentHostCompletionSource =
	| { readonly group: 'command'; readonly shortName: string }
	| { readonly group: 'skill'; readonly shortName: string }
	| { readonly group: 'plugin'; readonly plugin: string; readonly shortName: string }
	| { readonly group: 'mcp'; readonly server: string; readonly shortName: string };

/** The slice of a completion attachment this module reads. */
export type AgentHostCompletionSubject =
	| { readonly kind: 'command'; readonly command: string; readonly description?: string }
	| { readonly kind: 'skill'; readonly uri: URI | string; readonly displayName?: string; readonly name?: string; readonly description?: string };

export interface IAgentHostCompletionPresentation {
	readonly label: CompletionItemLabel;
	readonly kind: CompletionItemKind;
	readonly sortText: string;
	readonly documentation: string | undefined;
}

const MCP_PREFIX = 'mcp__';
const MCP_SEPARATOR = '__';
const PLUGIN_SEPARATOR = ':';
/** A plugin's full name is `plugin@marketplace`; the marketplace is not what the reader picks by. */
const MARKETPLACE_SEPARATOR = '@';
const PLUGIN_CACHE_SEGMENT = '/plugins/cache/';

/** The order the groups appear in, and the icon each wears. */
const GROUP_ORDER: Readonly<Record<AgentHostCompletionSource['group'], number>> = { command: 0, skill: 1, plugin: 2, mcp: 3 };
const GROUP_ICON: Readonly<Record<AgentHostCompletionSource['group'], CompletionItemKind>> = {
	command: CompletionItemKind.Keyword,
	skill: CompletionItemKind.Snippet,
	plugin: CompletionItemKind.Module,
	mcp: CompletionItemKind.Interface,
};

/** How much of a description rides in the row before it is cut, leaving room for the source tag. */
const SUMMARY_MAX_CHARS = 72;
// allow-any-unicode-next-line
const ELLIPSIS = '…';

export function classifyAgentHostCompletion(subject: AgentHostCompletionSubject): AgentHostCompletionSource {
	const name = subject.kind === 'command' ? subject.command : (subject.displayName ?? subject.name ?? '');

	// `mcp__server__prompt`: the server goes in the tag, the prompt is the name.
	if (name.startsWith(MCP_PREFIX)) {
		const rest = name.slice(MCP_PREFIX.length);
		const cut = rest.indexOf(MCP_SEPARATOR);
		const server = cut > 0 ? rest.slice(0, cut) : rest;
		const shortName = cut > 0 ? rest.slice(cut + MCP_SEPARATOR.length) : rest;
		return { group: 'mcp', server: server || name, shortName: shortName || name };
	}

	// `plugin@marketplace:name`: the plugin goes in the tag, the name is the name.
	const separator = name.indexOf(PLUGIN_SEPARATOR);
	if (separator > 0) {
		return { group: 'plugin', plugin: withoutMarketplace(name.slice(0, separator)), shortName: name.slice(separator + 1) || name };
	}

	if (subject.kind === 'skill') {
		const plugin = pluginFromPath(typeof subject.uri === 'string' ? subject.uri : subject.uri.path);
		return plugin ? { group: 'plugin', plugin: withoutMarketplace(plugin), shortName: name } : { group: 'skill', shortName: name };
	}

	return { group: 'command', shortName: name };
}

function withoutMarketplace(plugin: string): string {
	const at = plugin.indexOf(MARKETPLACE_SEPARATOR);
	return at > 0 ? plugin.slice(0, at) : plugin;
}

/**
 * A plugin's skills live under `<cache>/<marketplace>/<plugin>/<version>/…`.
 * A skill the plugin did not name with its prefix is still the plugin's.
 */
function pluginFromPath(uri: string): string | undefined {
	const index = uri.indexOf(PLUGIN_CACHE_SEGMENT);
	if (index === -1) {
		return undefined;
	}
	const [, plugin] = uri.slice(index + PLUGIN_CACHE_SEGMENT.length).split('/');
	return plugin || undefined;
}

/** The first sentence, then a width, never cut mid-word. */
export function summarise(description: string | undefined): string {
	const text = (description ?? '').trim();
	if (!text) {
		return '';
	}

	const sentenceEnd = text.search(/[.!?](\s|$)/);
	const sentence = sentenceEnd === -1 ? text : text.slice(0, sentenceEnd + 1);
	if (sentence.length <= SUMMARY_MAX_CHARS) {
		return sentence;
	}

	const cut = sentence.lastIndexOf(' ', SUMMARY_MAX_CHARS);
	return `${sentence.slice(0, cut > 0 ? cut : SUMMARY_MAX_CHARS).trimEnd()}${ELLIPSIS}`;
}

function sourceTag(source: AgentHostCompletionSource): string {
	switch (source.group) {
		case 'command': return localize('agentHostCompletion.source.command', "command");
		case 'skill': return localize('agentHostCompletion.source.skill', "skill");
		// allow-any-unicode-next-line
		case 'plugin': return localize('agentHostCompletion.source.plugin', "plugin · {0}", source.plugin);
		// allow-any-unicode-next-line
		case 'mcp': return localize('agentHostCompletion.source.mcp', "MCP · {0}", source.server);
	}
}

/**
 * The presentation of one item. `insertText` is what the host wants inserted
 * (`/name `, trailing space and all) and is left alone: it is what actually
 * runs. The LABEL is the short name - `/brainstorming`, not
 * `/superpowers@claude-plugins-official:brainstorming` - because the plugin or
 * server is already in the tag, and a row that repeats it three times has no
 * room left for what the item does. Filtering still matches the full text.
 */
export function presentAgentHostCompletion(subject: AgentHostCompletionSubject, insertText: string): IAgentHostCompletionPresentation {
	const source = classifyAgentHostCompletion(subject);
	const full = insertText.trim();
	const label = full.startsWith('/') ? `/${source.shortName}` : source.shortName;
	const summary = summarise(subject.description);

	return {
		label: {
			label,
			detail: summary ? `  ${summary}` : undefined,
			description: sourceTag(source),
		},
		kind: GROUP_ICON[source.group],
		sortText: `${GROUP_ORDER[source.group]} ${label.toLowerCase()} ${full.toLowerCase()}`,
		documentation: subject.description,
	};
}
