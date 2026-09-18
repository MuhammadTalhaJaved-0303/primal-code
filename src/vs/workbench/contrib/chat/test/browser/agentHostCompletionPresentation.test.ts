/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CompletionItemKind } from '../../../../../editor/common/languages.js';
import { classifyAgentHostCompletion, presentAgentHostCompletion, summarise } from '../../browser/widget/input/editor/agentHostCompletionPresentation.js';

suite('Agent host completions - presentation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies by where the item came from', () => {
		assert.deepStrictEqual({
			builtIn: classifyAgentHostCompletion({ kind: 'command', command: 'compact' }),
			pluginCommand: classifyAgentHostCompletion({ kind: 'command', command: 'vercel:deploy' }),
			mcpPrompt: classifyAgentHostCompletion({ kind: 'command', command: 'mcp__github__summarise_pr' }),
			skill: classifyAgentHostCompletion({ kind: 'skill', uri: 'file:///Users/me/.claude/skills/api-design/SKILL.md', displayName: 'api-design' }),
			pluginSkill: classifyAgentHostCompletion({ kind: 'skill', uri: 'file:///Users/me/.claude/plugins/cache/official/superpowers/6.3.0/skills/brainstorming/SKILL.md', displayName: 'superpowers:brainstorming' }),
			pluginSkillByPathOnly: classifyAgentHostCompletion({ kind: 'skill', uri: 'file:///Users/me/.claude/plugins/cache/official/frontend-design/1.0.0/skills/frontend-design/SKILL.md', displayName: 'frontend-design' }),
		}, {
			builtIn: { group: 'command', shortName: 'compact' },
			pluginCommand: { group: 'plugin', plugin: 'vercel', shortName: 'deploy' },
			mcpPrompt: { group: 'mcp', server: 'github', shortName: 'summarise_pr' },
			skill: { group: 'skill', shortName: 'api-design' },
			pluginSkill: { group: 'plugin', plugin: 'superpowers', shortName: 'brainstorming' },
			pluginSkillByPathOnly: { group: 'plugin', plugin: 'frontend-design', shortName: 'frontend-design' },
		});
	});

	test('the groups sort in a fixed order and alphabetically within, whatever order the host sent', () => {
		const items = [
			{ kind: 'skill' as const, uri: 'file:///Users/me/.claude/skills/tdd/SKILL.md', displayName: 'tdd' },
			{ kind: 'command' as const, command: 'mcp__github__summarise_pr' },
			{ kind: 'command' as const, command: 'vercel:deploy' },
			{ kind: 'command' as const, command: 'compact' },
			{ kind: 'skill' as const, uri: 'file:///Users/me/.claude/skills/api-design/SKILL.md', displayName: 'api-design' },
			{ kind: 'command' as const, command: 'clear' },
		];
		const sorted = items
			.map(item => presentAgentHostCompletion(item, `/${item.kind === 'command' ? item.command : item.displayName} `))
			.sort((a, b) => a.sortText.localeCompare(b.sortText))
			.map(p => p.label.label);

		assert.deepStrictEqual(sorted, ['/clear', '/compact', '/api-design', '/tdd', '/deploy', '/summarise_pr']);
	});

	test('a row carries a short summary inline and its source at the right; the whole description goes to the details pane', () => {
		const long = 'REST API design patterns including resource naming, status codes, pagination, filtering, error responses, versioning, and rate limiting for production APIs. A second sentence that nobody needs in a row.';
		const row = presentAgentHostCompletion({ kind: 'skill', uri: 'file:///Users/me/.claude/skills/api-design/SKILL.md', displayName: 'api-design', description: long }, '/api-design ');

		assert.strictEqual(row.label.label, '/api-design');
		assert.ok(row.label.detail!.length < long.length, 'the inline summary is shorter than the description');
		assert.ok(!row.label.detail!.includes('second sentence'), 'only the first sentence rides in the row');
		assert.strictEqual(row.label.description, 'skill');
		assert.strictEqual(row.documentation, long);
	});

	test('each group has its own icon, so the grouping survives without colour', () => {
		const kinds = new Set([
			presentAgentHostCompletion({ kind: 'command', command: 'compact' }, '/compact ').kind,
			presentAgentHostCompletion({ kind: 'skill', uri: 'file:///x/.claude/skills/a/SKILL.md', displayName: 'a' }, '/a ').kind,
			presentAgentHostCompletion({ kind: 'command', command: 'vercel:deploy' }, '/vercel:deploy ').kind,
			presentAgentHostCompletion({ kind: 'command', command: 'mcp__github__x' }, '/mcp__github__x ').kind,
		]);
		assert.strictEqual(kinds.size, 4, 'four groups, four icons');
		assert.ok(!kinds.has(CompletionItemKind.Text), 'none of them is the generic text icon');
	});

	test('the source tag names the plugin or the server, in words, without the marketplace', () => {
		assert.deepStrictEqual({
			plugin: presentAgentHostCompletion({ kind: 'command', command: 'vercel:deploy' }, '/vercel:deploy ').label.description,
			marketplacePlugin: presentAgentHostCompletion({ kind: 'skill', uri: 'file:///x/SKILL.md', displayName: 'superpowers@claude-plugins-official:brainstorming' }, '/superpowers@claude-plugins-official:brainstorming ').label.description,
			mcp: presentAgentHostCompletion({ kind: 'command', command: 'mcp__github__summarise_pr' }, '/mcp__github__summarise_pr ').label.description,
			command: presentAgentHostCompletion({ kind: 'command', command: 'compact' }, '/compact ').label.description,
		}, {
			plugin: 'plugin · vercel',
			marketplacePlugin: 'plugin · superpowers',
			mcp: 'MCP · github',
			command: 'command',
		});
	});

	test('the row shows the short name; what is inserted stays the host\'s full command', () => {
		const full = '/superpowers@claude-plugins-official:brainstorming ';
		const row = presentAgentHostCompletion({ kind: 'skill', uri: 'file:///x/SKILL.md', displayName: 'superpowers@claude-plugins-official:brainstorming' }, full);
		assert.strictEqual(row.label.label, '/brainstorming');
		// The presentation carries no insertText: the callers spread the host's
		// own value in afterwards, so the short label can never change what runs.
		assert.strictEqual(Object.hasOwn(row, 'insertText'), false);
	});

	test('summarise cuts at the first sentence and then at a width, never mid-word', () => {
		assert.deepStrictEqual({
			sentence: summarise('First sentence. Second sentence.'),
			noBreak: summarise('A description with no full stop at all that just keeps going and going and going past any reasonable width for a row'),
			short: summarise('Short.'),
			empty: summarise(undefined),
		}, {
			sentence: 'First sentence.',
			noBreak: 'A description with no full stop at all that just keeps going and going…',
			short: 'Short.',
			empty: '',
		});
	});
});
