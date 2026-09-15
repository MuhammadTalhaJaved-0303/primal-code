/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IFileService } from '../../../files/common/files.js';
import { NullLogService } from '../../../log/common/log.js';
import { buildBranchChangesetUri } from '../../common/changesetUri.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { SessionStatus } from '../../common/state/sessionState.js';
import { AgentHostGitService } from '../../node/agentHostGitService.js';
import { AgentHostMergeOperationHandler } from '../../node/agentHostMergeOperationHandler.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';

/**
 * Drives the real merge-back code path — {@link AgentHostMergeOperationHandler} over the real
 * {@link AgentHostGitService} — against a throwaway repository created for each test, so the
 * assertions are about what git actually did to the project branch.
 */
const FIXTURE_ROOT = '/tmp/pc-coreloop/fixtures';
const session = URI.parse('agent:/session');
const SOURCE_BRANCH = 'agents/session';
const TARGET_BRANCH = 'main';
const FILE = 'notes.txt';

interface IFixture {
	readonly project: string;
	readonly worktree: string;
}

const gitEnv = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.com',
	GIT_COMMITTER_NAME: 'Fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
}

function write(dir: string, content: string): void {
	fs.writeFileSync(join(dir, FILE), content);
}

function createFixture(root: string): IFixture {
	const project = join(root, 'project');
	const worktree = join(root, 'project.worktrees', 'session');
	fs.mkdirSync(project, { recursive: true });
	git(project, 'init', '-b', TARGET_BRANCH);
	// The handler commits inside the worktree with the process environment, so the identity has to
	// live in the repository configuration rather than only in this test's spawn environment.
	git(project, 'config', 'user.name', 'Fixture');
	git(project, 'config', 'user.email', 'fixture@example.com');
	write(project, 'line 1\n');
	git(project, 'add', '-A');
	git(project, 'commit', '-m', 'initial');
	git(project, 'worktree', 'add', '-b', SOURCE_BRANCH, worktree, TARGET_BRANCH);
	return { project, worktree };
}

suite('AgentHostMergeOperationHandler (real git)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(() => {
		fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
		root = fs.mkdtempSync(join(FIXTURE_ROOT, 'merge-back-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function createHandler(fixture: IFixture) {
		const stateManager = disposables.add(new AgentHostStateManager(new NullLogService()));
		stateManager.createSession({
			resource: session.toString(),
			provider: 'codex',
			title: 'Session',
			status: SessionStatus.Idle,
			createdAt: new Date(1).toISOString(),
			modifiedAt: new Date(1).toISOString(),
			workingDirectories: [URI.file(fixture.worktree).toString()],
			project: { uri: URI.file(fixture.project).toString(), displayName: 'project' },
		});
		stateManager.setSessionConfig(session.toString(), {
			schema: { type: 'object', properties: {} },
			values: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: TARGET_BRANCH },
		});
		const gitService = new AgentHostGitService(
			new class extends mock<IFileService>() { }(),
			new class extends mock<INativeEnvironmentService>() { override readonly tmpDir = URI.file(root); }(),
			new NullLogService(),
		);
		const refreshed: string[] = [];
		const merged: { readonly sessionKey: string; readonly commit: string }[] = [];
		const handler = new AgentHostMergeOperationHandler(
			sessionKey => stateManager.getSessionState(sessionKey),
			async () => TARGET_BRANCH,
			async sessionKey => { refreshed.push(sessionKey); },
			async (sessionKey, commit) => { merged.push({ sessionKey, commit }); },
			gitService,
			new NullLogService(),
		);
		const invoke = () => handler.invoke({
			channel: buildBranchChangesetUri(session.toString()),
			operationId: AgentHostMergeOperationHandler.OPERATION_MERGE,
		}, CancellationToken.None);
		const invokeExpectingError = async (): Promise<string> => {
			try {
				await invoke();
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			assert.fail('expected the merge to be rejected');
		};
		return { invoke, invokeExpectingError, refreshed, merged };
	}

	test('commits the worktree change and lands it on the project branch', async () => {
		const fixture = createFixture(root);
		write(fixture.worktree, 'line 1\nline 2 from session\n');
		const { invoke, refreshed, merged } = createHandler(fixture);

		const result = await invoke();

		assert.deepStrictEqual({
			message: typeof result.message === 'string' ? result.message : result.message?.markdown,
			fileOnProjectBranch: git(fixture.project, 'show', `${TARGET_BRANCH}:${FILE}`),
			projectBranch: git(fixture.project, 'branch', '--show-current'),
			projectStatus: git(fixture.project, 'status', '--porcelain'),
			worktreeStatus: git(fixture.worktree, 'status', '--porcelain'),
			worktreeCommitSubject: git(fixture.worktree, 'log', '-1', '--format=%s', SOURCE_BRANCH),
			merged,
			refreshed,
		}, {
			message: `Merged changes from '${SOURCE_BRANCH}' into '${TARGET_BRANCH}'.`,
			fileOnProjectBranch: 'line 1\nline 2 from session',
			projectBranch: TARGET_BRANCH,
			projectStatus: '',
			worktreeStatus: '',
			worktreeCommitSubject: `Agent Host changes for ${SOURCE_BRANCH}`,
			merged: [{ sessionKey: session.toString(), commit: git(fixture.project, 'rev-parse', 'HEAD') }],
			refreshed: [session.toString()],
		});
	});

	test('reports a conflict by name, leaves the project branch untouched, and keeps the worktree commit', async () => {
		const fixture = createFixture(root);
		write(fixture.project, 'line 1\nline 2 from main\n');
		git(fixture.project, 'commit', '-am', 'main moves on');
		write(fixture.worktree, 'line 1\nline 2 from session\n');
		const { invokeExpectingError, refreshed, merged } = createHandler(fixture);

		const errorMessage = await invokeExpectingError();

		assert.ok(
			errorMessage.startsWith(`The worktree changes were committed, but merging into '${TARGET_BRANCH}' failed.`),
			`unexpected message: ${errorMessage}`,
		);
		assert.ok(/CONFLICT/.test(errorMessage) && errorMessage.includes(FILE), `the conflict is not named: ${errorMessage}`);
		assert.deepStrictEqual({
			fileOnProjectBranch: git(fixture.project, 'show', `${TARGET_BRANCH}:${FILE}`),
			projectStatus: git(fixture.project, 'status', '--porcelain'),
			mergeInProgress: fs.existsSync(join(fixture.project, '.git', 'MERGE_HEAD')),
			worktreeCommitSubject: git(fixture.worktree, 'log', '-1', '--format=%s', SOURCE_BRANCH),
			merged,
			refreshed,
		}, {
			fileOnProjectBranch: 'line 1\nline 2 from main',
			projectStatus: '',
			mergeInProgress: false,
			worktreeCommitSubject: `Agent Host changes for ${SOURCE_BRANCH}`,
			merged: [],
			refreshed: [session.toString()],
		});
	});

	test('refuses to merge into a project checkout with uncommitted changes', async () => {
		const fixture = createFixture(root);
		write(fixture.project, 'line 1\nunsaved work\n');
		write(fixture.worktree, 'line 1\nline 2 from session\n');
		const { invokeExpectingError, refreshed, merged } = createHandler(fixture);

		const errorMessage = await invokeExpectingError();

		assert.deepStrictEqual({
			errorMessage,
			fileInProject: fs.readFileSync(join(fixture.project, FILE), 'utf8'),
			worktreeStatus: git(fixture.worktree, 'status', '--porcelain'),
			merged,
			refreshed,
		}, {
			errorMessage: `Commit or stash the changes in the parent repository before merging into '${TARGET_BRANCH}'.`,
			fileInProject: 'line 1\nunsaved work\n',
			// `git()` trims, so the leading "unstaged" column of ` M` is gone.
			worktreeStatus: `M ${FILE}`,
			merged: [],
			refreshed: [],
		});
	});
});
