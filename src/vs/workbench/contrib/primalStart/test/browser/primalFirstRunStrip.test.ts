/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PRIMAL_MANAGE_PROVIDERS_COMMAND_ID } from '../../../../../platform/agentHost/common/primalProviders.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IPrimalVibe, IPrimalVibeService, PRIMAL_VIBES } from '../../../primalVibes/browser/primalVibes.js';
import { IPrimalFirstRunService } from '../../browser/primalFirstRunService.js';
import { PrimalFirstRunStrip } from '../../browser/primalFirstRunStrip.js';
import { computeFirstRunGuide, IFirstRunGuide, IFirstRunInputs } from '../../common/primalFirstRunSteps.js';

const NOTHING: IFirstRunInputs = { vibeChosen: false, claudeLoginDetected: false, configuredProviderIds: [], started: false, detectionSettled: true };

/** A first-run service the test steers directly; the strip only reads it. */
class TestFirstRunService implements Partial<IPrimalFirstRunService> {
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private inputs: IFirstRunInputs = NOTHING;
	private complete = false;
	private noticeOwed = false;
	keepCalls = 0;
	refreshCalls = 0;

	get guide(): IFirstRunGuide {
		return computeFirstRunGuide(this.inputs);
	}

	get isGuideVisible(): boolean {
		return !this.complete;
	}

	/** Steers the world the way the real service would after detection or progress. */
	become(inputs: IFirstRunInputs): void {
		this.inputs = inputs;
		const guide = computeFirstRunGuide(inputs);
		if (guide.complete && !this.complete) {
			this.complete = true;
			this.noticeOwed = true;
		}
		this._onDidChange.fire();
	}

	keepCurrentVibe(): void {
		this.keepCalls++;
		this.become({ ...this.inputs, vibeChosen: true });
	}

	takeCompletionNotice(): boolean {
		const owed = this.noticeOwed;
		this.noticeOwed = false;
		return owed;
	}

	async refreshDetection(): Promise<void> {
		this.refreshCalls++;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

class TestVibeService implements Partial<IPrimalVibeService> {
	private readonly _onDidChangeVibe = new Emitter<IPrimalVibe | undefined>();
	readonly onDidChangeVibe = this._onDidChangeVibe.event;
	currentVibe: IPrimalVibe | undefined = PRIMAL_VIBES[1]; // Basalt

	dispose(): void {
		this._onDidChangeVibe.dispose();
	}
}

class TestCommandService implements Partial<ICommandService> {
	readonly executed: string[] = [];

	async executeCommand<T>(id: string): Promise<T | undefined> {
		this.executed.push(id);
		return undefined;
	}
}

suite('PrimalFirstRunStrip', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let container: HTMLElement;
	let firstRun: TestFirstRunService;
	let vibes: TestVibeService;
	let commands: TestCommandService;

	setup(() => {
		container = $('div');
		firstRun = disposables.add(new TestFirstRunService());
		vibes = disposables.add(new TestVibeService());
		commands = new TestCommandService();
	});

	function createStrip(): PrimalFirstRunStrip {
		return disposables.add(new PrimalFirstRunStrip(
			container,
			firstRun as unknown as IPrimalFirstRunService,
			vibes as unknown as IPrimalVibeService,
			commands as unknown as ICommandService,
		));
	}

	function section(): HTMLElement {
		const element = container.firstElementChild;
		assert.ok(element instanceof HTMLElement, 'the strip renders one section');
		return element;
	}

	function steps(): HTMLElement[] {
		return Array.from(section().getElementsByClassName('primal-start-firstrun-step')).filter((el): el is HTMLElement => el instanceof HTMLElement);
	}

	function stateWords(): string[] {
		return Array.from(section().getElementsByClassName('primal-start-firstrun-state')).map(el => el.textContent);
	}

	function buttons(): HTMLButtonElement[] {
		return Array.from(section().getElementsByTagName('button'));
	}

	test('a fresh install renders three steps, their state in words, and a way to keep the vibe', () => {
		createStrip();
		assert.strictEqual(steps().length, 3);
		assert.deepStrictEqual(stateWords(), ['now', 'next', 'next']);
		assert.deepStrictEqual(steps().map(step => step.classList.contains('current')), [true, false, false]);
		assert.ok(section().textContent.includes('Pick a vibe'));
		assert.ok(section().textContent.includes('Connect a model'));
		assert.ok(section().textContent.includes('Start'));
		// Nothing is gated: a provider can be added before the vibe is picked.
		assert.deepStrictEqual(buttons().map(button => button.textContent), ['Keep Basalt', 'Add a provider...']);
	});

	test('each step carries a glyph as well as the word', () => {
		createStrip();
		const glyphs = Array.from(section().getElementsByClassName('primal-start-firstrun-glyph'));
		assert.strictEqual(glyphs.length, 3);
		assert.ok(glyphs.every(glyph => glyph.classList.contains('codicon')));
	});

	test('Keep Basalt records the choice and the strip moves on', () => {
		createStrip();
		buttons()[0].click();
		assert.strictEqual(firstRun.keepCalls, 1);
		assert.deepStrictEqual(stateWords(), ['done', 'now', 'next']);
		assert.ok(section().textContent.includes('Basalt.'));
	});

	test('with no theme of ours applied, the affordance keeps the theme the user has', () => {
		vibes.currentVibe = undefined;
		createStrip();
		assert.deepStrictEqual(buttons().map(button => button.textContent), ['Keep this theme', 'Add a provider...']);
	});

	test('nothing detected: the model step explains, and its button opens the provider manager', async () => {
		createStrip();
		firstRun.become({ ...NOTHING, vibeChosen: true });
		assert.ok(section().textContent.includes('The agent needs a provider'));
		assert.ok(section().textContent.includes('nothing is sent anywhere'));
		const addButton = buttons().find(button => button.textContent.startsWith('Add a provider'));
		assert.ok(addButton, 'an Add a provider button is offered');
		addButton.click();
		await Promise.resolve();
		assert.deepStrictEqual(commands.executed, [PRIMAL_MANAGE_PROVIDERS_COMMAND_ID]);
	});

	test('while detection is still running, the model step says it is looking and claims nothing', () => {
		createStrip();
		firstRun.become({ ...NOTHING, detectionSettled: false });
		assert.ok(section().textContent.includes('Looking for an existing setup'));
		assert.ok(!section().textContent.includes('The agent needs a provider'));
		assert.ok(buttons().some(button => button.textContent.startsWith('Add a provider')), 'a provider can still be added while looking');
	});

	test('an existing Claude login is named as such, with no button', () => {
		createStrip();
		firstRun.become({ ...NOTHING, vibeChosen: true, claudeLoginDetected: true });
		assert.ok(section().textContent.includes('Using your Claude Code login'));
		assert.ok(section().textContent.includes('nothing to set up'));
		assert.deepStrictEqual(stateWords(), ['done', 'done', 'now']);
		assert.strictEqual(buttons().length, 0);
	});

	test('configured keys are listed by provider name, never by value', () => {
		createStrip();
		firstRun.become({ ...NOTHING, configuredProviderIds: ['anthropic', 'deepseek'] });
		assert.ok(section().textContent.includes('Keys for Anthropic (Claude), DeepSeek.'));
		assert.ok(!section().textContent.includes('sk-'));
	});

	test('keys next to a Claude login mention both', () => {
		createStrip();
		firstRun.become({ ...NOTHING, claudeLoginDetected: true, configuredProviderIds: ['openai'] });
		assert.ok(section().textContent.includes('Using your Claude Code login, plus keys for OpenAI (GPT / Codex).'));
	});

	test('a done start step covers both ways of starting: the service records one flag for a folder and a session', () => {
		createStrip();
		firstRun.become({ ...NOTHING, started: true });
		assert.ok(section().textContent.includes('A project is open or a session has started.'));
		assert.ok(!section().textContent.includes('First session started.'));
	});

	test('completion collapses the strip to one line, which the next open removes', () => {
		const strip = createStrip();
		firstRun.become({ vibeChosen: true, claudeLoginDetected: true, configuredProviderIds: [], started: true, detectionSettled: true });
		assert.strictEqual(steps().length, 0);
		assert.ok(section().textContent.includes('You\'re set.'));
		assert.strictEqual(section().classList.contains('empty'), false);

		// A re-render within the same open keeps the line up.
		firstRun.become({ vibeChosen: true, claudeLoginDetected: true, configuredProviderIds: [], started: true, detectionSettled: true });
		assert.ok(section().textContent.includes('You\'re set.'));

		strip.onDidOpen();
		assert.strictEqual(section().textContent, '');
		assert.strictEqual(section().classList.contains('empty'), true);
	});

	test('a guide completed before this page opened shows the line once, then nothing', () => {
		firstRun.become({ vibeChosen: true, claudeLoginDetected: true, configuredProviderIds: [], started: true, detectionSettled: true });
		const strip = createStrip();
		assert.ok(section().textContent.includes('You\'re set.'));
		strip.onDidOpen();
		assert.strictEqual(section().classList.contains('empty'), true);
	});

	test('opening the page re-reads the world', () => {
		const strip = createStrip();
		const before = firstRun.refreshCalls;
		strip.onDidOpen();
		assert.strictEqual(firstRun.refreshCalls, before + 1);
	});

	test('disposing the strip stops it reacting', () => {
		const strip = createStrip();
		strip.dispose();
		firstRun.become({ ...NOTHING, vibeChosen: true });
		assert.deepStrictEqual(stateWords(), ['now', 'next', 'next']);
	});
});
