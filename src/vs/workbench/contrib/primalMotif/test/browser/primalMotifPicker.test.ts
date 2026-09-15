/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService, IConfigurationValue } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import {
	IQuickInputService,
	IQuickPick,
	IQuickPickDidAcceptEvent,
	IQuickPickItem,
	IQuickPickSeparator,
	QuickInputHideReason
} from '../../../../../platform/quickinput/common/quickInput.js';
import { PRIMAL_MOTIF_ID_SETTING_ID, PRIMAL_MOTIF_STATIC_ID, getMotifDescriptors } from '../../browser/primalMotif.js';
import { PRIMAL_MOTIF_WORLD_ID } from '../../browser/motifs/globe.js';
import { STARFIELD_MOTIF_ID } from '../../browser/motifs/starfield.js';
import { composeMotifChoices } from '../../browser/primalMotifChoices.js';
import { IMotifQuickPickItem, PrimalMotifPicker, composeMotifPicks } from '../../browser/primalMotifPicker.js';
// The shipping set, imported the way the workbench imports it, so the picker is
// tested against exactly what the product offers.
import '../../browser/motifs/motifs.js';

/**
 * The narrowest quick pick the picker needs: items, an active item, and the
 * three events it listens to. Everything else on `IQuickPick` is unused by the
 * picker and left off, and the cast in {@link asQuickPick} says so.
 */
class FakeQuickPick<T extends IQuickPickItem> extends Disposable {

	title: string | undefined;
	placeholder: string | undefined;
	canSelectMany = false;
	matchOnDescription = false;
	items: ReadonlyArray<T | IQuickPickSeparator> = [];
	activeItems: ReadonlyArray<T> = [];
	selectedItems: ReadonlyArray<T> = [];
	visible = false;

	private readonly _onDidChangeActive = this._register(new Emitter<T[]>());
	readonly onDidChangeActive = this._onDidChangeActive.event;
	private readonly _onDidAccept = this._register(new Emitter<IQuickPickDidAcceptEvent>());
	readonly onDidAccept = this._onDidAccept.event;
	private readonly _onDidHide = this._register(new Emitter<{ reason: QuickInputHideReason }>());
	readonly onDidHide = this._onDidHide.event;

	show(): void {
		this.visible = true;
	}

	hide(reason: QuickInputHideReason = QuickInputHideReason.Other): void {
		if (!this.visible) {
			return;
		}
		this.visible = false;
		this._onDidHide.fire({ reason });
	}

	/** What arrowing onto an item does. */
	highlight(item: T): void {
		this.activeItems = [item];
		this._onDidChangeActive.fire([item]);
	}

	/** What Enter does. */
	accept(item: T): void {
		this.selectedItems = [item];
		this._onDidAccept.fire({ inBackground: false });
	}
}

function asQuickPick<T extends IQuickPickItem>(fake: FakeQuickPick<T>): IQuickPick<T, { useSeparators: boolean }> {
	return fake as unknown as IQuickPick<T, { useSeparators: boolean }>;
}

/**
 * A configuration service that actually keeps what is written to it, and
 * remembers the order, so a preview followed by a revert can be read back as
 * the sequence it was.
 */
class RecordingConfigurationService extends TestConfigurationService {

	readonly writes: (unknown)[] = [];

	override updateValue(key: string, value: unknown): Promise<void> {
		this.writes.push(value);
		return this.setUserConfiguration(key, value);
	}

	override inspect<T>(key: string): IConfigurationValue<T> {
		const value = this.getValue<T>(key);
		return { value, defaultValue: undefined, userValue: value, userLocalValue: value };
	}
}

suite('Primal Motif - picker', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const descriptors = getMotifDescriptors();

	test('the choices are every registered motif, static first and named as the way to no motion', () => {
		const choices = composeMotifChoices(descriptors, PRIMAL_MOTIF_STATIC_ID);

		assert.deepStrictEqual(
			[...choices.map(choice => choice.id)].sort(),
			[...descriptors.map(descriptor => descriptor.id)].sort(),
			'every registered motif is a choice, and nothing else is'
		);
		assert.strictEqual(choices[0].id, PRIMAL_MOTIF_STATIC_ID, 'static leads, so the way to switch motion off is never scrolled for');
		assert.ok(/no motion/i.test(choices[0].label), `static says in its label what it is for, got '${choices[0].label}'`);

		for (const choice of choices) {
			const descriptor = descriptors.find(candidate => candidate.id === choice.id);
			assert.ok(descriptor);
			assert.strictEqual(choice.description, descriptor.description, `'${choice.id}' carries its own description`);
			assert.ok(choice.label.length > 0, `'${choice.id}' has a label`);
		}
	});

	test('exactly one choice is current, and it is the one asked for', () => {
		const choices = composeMotifChoices(descriptors, PRIMAL_MOTIF_WORLD_ID);
		const current = choices.filter(choice => choice.current);

		assert.strictEqual(current.length, 1);
		assert.strictEqual(current[0].id, PRIMAL_MOTIF_WORLD_ID);
	});

	test('the current motif is marked in the label, in words', () => {
		const picks = composeMotifPicks(descriptors, PRIMAL_MOTIF_WORLD_ID);
		const marked = picks.filter(pick => /current/i.test(pick.label));

		assert.strictEqual(marked.length, 1, 'one pick says it is current');
		assert.strictEqual(marked[0].motifId, PRIMAL_MOTIF_WORLD_ID);
		for (const pick of picks) {
			assert.strictEqual(pick.description, descriptors.find(descriptor => descriptor.id === pick.motifId)?.description);
		}
	});

	interface IHarness {
		readonly quickPick: FakeQuickPick<IMotifQuickPickItem>;
		readonly configuration: RecordingConfigurationService;
		readonly done: Promise<void>;
	}

	function open(initialMotifId: string | undefined): IHarness {
		const quickPick = new FakeQuickPick<IMotifQuickPickItem>();
		// A test that leaves the picker open has it closed on teardown, and
		// BEFORE the fake's emitters go, so the picker's own store hears the
		// hide and releases itself. The leak store disposes in insertion order.
		store.add({ dispose: () => quickPick.hide() });
		store.add(quickPick);

		const configuration = new RecordingConfigurationService(initialMotifId === undefined ? {} : { [PRIMAL_MOTIF_ID_SETTING_ID]: initialMotifId });
		const quickInputService: Partial<IQuickInputService> = {
			createQuickPick: (() => asQuickPick(quickPick)) as IQuickInputService['createQuickPick']
		};

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, configuration);
		instantiationService.stub(IQuickInputService, quickInputService);
		instantiationService.stub(ILogService, new NullLogService());

		const picker = instantiationService.createInstance(PrimalMotifPicker);
		const done = picker.pick();

		return { quickPick, configuration, done };
	}

	function itemFor(quickPick: FakeQuickPick<IMotifQuickPickItem>, motifId: string): IMotifQuickPickItem {
		const item = quickPick.items.find((candidate): candidate is IMotifQuickPickItem => candidate.type !== 'separator' && candidate.motifId === motifId);
		assert.ok(item, `the picker lists '${motifId}'`);
		return item;
	}

	test('opens on the current motif, listing every registered one', () => {
		const { quickPick } = open(PRIMAL_MOTIF_WORLD_ID);

		assert.ok(quickPick.visible);
		assert.strictEqual(quickPick.activeItems[0]?.motifId, PRIMAL_MOTIF_WORLD_ID);
		for (const descriptor of descriptors) {
			itemFor(quickPick, descriptor.id);
		}
	});

	test('highlighting a motif previews it by writing the setting', async () => {
		const { quickPick, configuration } = open(PRIMAL_MOTIF_WORLD_ID);

		quickPick.highlight(itemFor(quickPick, STARFIELD_MOTIF_ID));
		await Promise.resolve();

		assert.deepStrictEqual(configuration.writes, [STARFIELD_MOTIF_ID]);
		assert.strictEqual(configuration.getValue(PRIMAL_MOTIF_ID_SETTING_ID), STARFIELD_MOTIF_ID);
	});

	test('highlighting the motif that is already applied writes nothing', async () => {
		const { quickPick, configuration } = open(PRIMAL_MOTIF_WORLD_ID);

		quickPick.highlight(itemFor(quickPick, PRIMAL_MOTIF_WORLD_ID));
		await Promise.resolve();

		assert.deepStrictEqual(configuration.writes, []);
	});

	test('escape puts back what was there', async () => {
		const { quickPick, configuration, done } = open(PRIMAL_MOTIF_WORLD_ID);

		quickPick.highlight(itemFor(quickPick, STARFIELD_MOTIF_ID));
		quickPick.highlight(itemFor(quickPick, PRIMAL_MOTIF_STATIC_ID));
		quickPick.hide(QuickInputHideReason.Gesture);
		await done;

		assert.deepStrictEqual(configuration.writes, [STARFIELD_MOTIF_ID, PRIMAL_MOTIF_STATIC_ID, PRIMAL_MOTIF_WORLD_ID]);
		assert.strictEqual(configuration.getValue(PRIMAL_MOTIF_ID_SETTING_ID), PRIMAL_MOTIF_WORLD_ID);
	});

	test('escape on a profile that never set the motif removes the preview rather than pinning it', async () => {
		const { quickPick, configuration, done } = open(undefined);

		quickPick.highlight(itemFor(quickPick, STARFIELD_MOTIF_ID));
		quickPick.hide(QuickInputHideReason.Gesture);
		await done;

		assert.deepStrictEqual(configuration.writes, [STARFIELD_MOTIF_ID, undefined]);
		assert.strictEqual(configuration.getValue(PRIMAL_MOTIF_ID_SETTING_ID), undefined);
	});

	test('accepting keeps the highlighted motif and does not revert', async () => {
		const { quickPick, configuration, done } = open(PRIMAL_MOTIF_WORLD_ID);

		const galaxy = itemFor(quickPick, STARFIELD_MOTIF_ID);
		quickPick.highlight(galaxy);
		quickPick.accept(galaxy);
		await done;

		assert.strictEqual(quickPick.visible, false, 'the picker closes on accept');
		assert.strictEqual(configuration.getValue(PRIMAL_MOTIF_ID_SETTING_ID), STARFIELD_MOTIF_ID);
		assert.ok(!configuration.writes.includes(PRIMAL_MOTIF_WORLD_ID), 'nothing was reverted');
	});
});
