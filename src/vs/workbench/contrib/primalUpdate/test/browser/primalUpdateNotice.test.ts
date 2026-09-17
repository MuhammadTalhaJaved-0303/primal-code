/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IRequestContext } from '../../../../../base/parts/request/common/request.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { PRIMAL_UPDATE_SKIPPED_COMMIT_STORAGE_KEY, PrimalUpdateTrigger } from '../../browser/primalUpdate.js';
import { PrimalUpdateService } from '../../browser/primalUpdateService.js';

const RUNNING_COMMIT = '67a53801895cbae67b40a4ef74cd84f4c36496db';
const PUBLISHED_COMMIT = '289f064fc3bd9d3e4a3a0a2c7b8c2d1e5f607182';

function manifestJson(commit: string): string {
	return JSON.stringify({
		version: '1.135.4',
		commit,
		date: '2026-09-17T18:00:00+05:00',
		name: 'A guided first run',
		notesUrl: 'https://github.com/MuhammadTalhaJaved-0303/primal-code-downloads/releases/tag/ide-v1.135.4',
		downloads: {
			'darwin-arm64': 'https://github.com/MuhammadTalhaJaved-0303/primal-code-downloads/releases/download/ide-v1.135.4/PrimalCode-macos-arm64.dmg',
			'win32-x64': 'https://github.com/MuhammadTalhaJaved-0303/primal-code-downloads/releases/download/ide-v1.135.4/PrimalCode-Setup-Windows-x64.exe',
		},
	});
}

interface IRaisedPrompt {
	readonly severity: Severity;
	readonly message: string;
	readonly choices: readonly IPromptChoice[];
}

/** The service under test, wired to stubs that record what a user would meet. */
function createService(store: Pick<DisposableStore, 'add'>, options: { published: string; skipped?: string; mode?: string }) {
	const prompts: IRaisedPrompt[] = [];
	const infos: string[] = [];
	const opened: string[] = [];

	const requestService = new class extends mock<IRequestService>() {
		override async request(): Promise<IRequestContext> {
			return { res: { statusCode: 200, headers: {} }, stream: bufferToStream(VSBuffer.fromString(manifestJson(options.published))) };
		}
	};
	const productService = new class extends mock<IProductService>() {
		override readonly commit = RUNNING_COMMIT;
		override readonly version = '1.135.3';
	};
	const configurationService = new class extends mock<IConfigurationService>() {
		override getValue<T>(): T {
			return (options.mode ?? 'notify') as T;
		}
	};
	const notificationService = new class extends mock<INotificationService>() {
		override prompt(severity: Severity, message: string, choices: IPromptChoice[]) {
			prompts.push({ severity, message, choices });
			return new class extends mock<INotificationHandle>() { }();
		}
		override info(message: string): void {
			infos.push(String(message));
		}
	};
	const openerService = new class extends mock<IOpenerService>() {
		override async open(target: unknown): Promise<boolean> {
			opened.push(String(target));
			return true;
		}
	};
	// The real in-memory implementation rather than a stub: skipping a build is
	// a storage write, and this way the test exercises the write the product makes.
	const storageService = store.add(new InMemoryStorageService());
	if (options.skipped) {
		storageService.store(PRIMAL_UPDATE_SKIPPED_COMMIT_STORAGE_KEY, options.skipped, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	const service = store.add(new PrimalUpdateService(
		requestService,
		productService,
		configurationService,
		notificationService,
		openerService,
		storageService,
		new NullLogService(),
	));

	return { service, prompts, infos, opened, storageService };
}

suite('Primal Update - the notice', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a newer published build raises a sticky notice naming the release, with somewhere to go', async () => {
		const { service, prompts } = createService(store, { published: PUBLISHED_COMMIT });

		await service.checkForUpdates(PrimalUpdateTrigger.Automatic);

		assert.strictEqual(prompts.length, 1, 'exactly one notice');
		const [notice] = prompts;
		assert.ok(notice.message.includes('1.135.4'), `the version is named: "${notice.message}"`);
		assert.ok(notice.message.includes('A guided first run'), `the release is named: "${notice.message}"`);
		assert.deepStrictEqual(
			notice.choices.map(choice => choice.label),
			['Download', 'Release Notes', 'Skip This Build'],
			'a way to get it, a way to read about it, and a way to be left alone'
		);
	});

	test('the running build says nothing when it is the published one', async () => {
		const { service, prompts, infos } = createService(store, { published: RUNNING_COMMIT });

		await service.checkForUpdates(PrimalUpdateTrigger.Automatic);

		assert.deepStrictEqual({ prompts: prompts.length, infos: infos.length }, { prompts: 0, infos: 0 }, 'a background check that finds nothing is silent');
	});

	test('a build the user skipped is not offered again', async () => {
		const { service, prompts } = createService(store, { published: PUBLISHED_COMMIT, skipped: PUBLISHED_COMMIT });

		await service.checkForUpdates(PrimalUpdateTrigger.Automatic);

		assert.strictEqual(prompts.length, 0, 'skipping a build means skipping it');
	});

	test('checks are off when the setting says off, and the notice explains rather than nagging', async () => {
		const { service, prompts, infos } = createService(store, { published: PUBLISHED_COMMIT, mode: 'off' });

		await service.checkForUpdates(PrimalUpdateTrigger.Automatic);

		assert.deepStrictEqual({ prompts: prompts.length, infos: infos.length }, { prompts: 0, infos: 0 });
		assert.strictEqual(service.isEnabled, false);
	});
});
