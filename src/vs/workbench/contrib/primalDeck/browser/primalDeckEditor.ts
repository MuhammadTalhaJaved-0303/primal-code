/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/primalDeck.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPrimalMediaService, MEDIA_LEASE_RENEW_INTERVAL_MS } from '../../../../platform/primalMedia/common/primalMedia.js';
import { IPrimalTelemetrySample, IPrimalTelemetryService, LEASE_EXPIRY_MS, LEASE_RENEW_INTERVAL_MS } from '../../../../platform/primalTelemetry/common/primalTelemetry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CHAT_OPEN_ACTION_ID } from '../../chat/browser/actions/chatActions.js';
import { IChatModel } from '../../chat/common/model/chatModel.js';
import { IPrimalVibe, IPrimalVibeService, PRIMAL_VIBE_CYCLE_COMMAND_ID, PRIMAL_VIBE_PICK_COMMAND_ID } from '../../primalVibes/browser/primalVibes.js';
import { IPrimalDeckService, PRIMAL_DECK_TOGGLE_COMMAND_ID } from './primalDeck.js';
import { createClockFormatter } from './primalDeckFormat.js';
import { PrimalDeckInput } from './primalDeckInput.js';
import { PrimalDeckLease } from './primalDeckLease.js';
import { PrimalDeckNowPlayingPanel } from './primalDeckNowPlaying.js';
import { PrimalDeckSessionsPanel } from './primalDeckSessions.js';
import { PrimalDeckSpectrum } from './primalDeckSpectrum.js';
import { PrimalDeckStream } from './primalDeckStream.js';
import { PrimalDeckStreamView } from './primalDeckStreamView.js';
import { PrimalDeckTelemetryPanel } from './primalDeckTelemetry.js';

const $ = DOM.$;

/** Below this editor width the left column folds away: stream and telemetry only. */
const NARROW_WIDTH_THRESHOLD = 900;

/** Below this editor width only the stream remains. */
const COMPACT_WIDTH_THRESHOLD = 640;

/** The clock, and the now-playing position, tick once a second - only while live. */
const CLOCK_INTERVAL_MS = 1000;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** One shortcut hint in the footer row. */
interface IShortcutHint {
	readonly commandId: string;
	readonly text: string;
}

/**
 * The Deck - the full-window console for watching an agent work
 * (`primal/design/deck-spec.md`). Music left, the live stream centre, machine
 * telemetry right; every moving thing on screen is driven by something real.
 *
 * Visibility is one choke point: `updateLoops()`, reached from
 * `setEditorVisible`, `setInput`, `clearInput`, the document's
 * `visibilitychange` and `dispose`. Everything that costs anything - both
 * leases, the stream subscriptions, the sessions listeners, the clock and the
 * spectrum's frame loop - is started there when the pane is the visible pane
 * in a visible document, and stopped there otherwise. Nothing else starts a
 * loop. The one thing the clock does beyond the clock face is watch for a
 * telemetry lease that expired behind the renderer's back (`checkLeases`), and
 * that too runs only while live.
 */
export class PrimalDeckEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.primalDeck';

	/** Lives as long as the pane. */
	private readonly editorDisposables = this._register(new DisposableStore());
	/** Lives only while the pane is live; cleared by `stopLive()`. */
	private readonly liveDisposables = this._register(new DisposableStore());
	private readonly clock = this._register(new IntervalTimer());
	private readonly clockFormat = createClockFormatter();
	private readonly telemetryLease: PrimalDeckLease;
	private readonly mediaLease: PrimalDeckLease;

	private targetWindow: Window | undefined;
	private reducedMotionQuery: MediaQueryList | undefined;
	private root: HTMLElement | undefined;
	private leftColumn: HTMLElement | undefined;
	private clockLabel: HTMLElement | undefined;
	private sessionLabel: HTMLElement | undefined;
	private vibeChip: HTMLButtonElement | undefined;
	private vibeChipLabel: HTMLElement | undefined;
	private footer: HTMLElement | undefined;

	private stream: PrimalDeckStream | undefined;
	private streamView: PrimalDeckStreamView | undefined;
	private spectrum: PrimalDeckSpectrum | undefined;
	private telemetryPanel: PrimalDeckTelemetryPanel | undefined;
	private sessionsPanel: PrimalDeckSessionsPanel | undefined;
	/** Exists only once `getCapabilities()` reported support; otherwise the panel is omitted, not stubbed. */
	private nowPlayingPanel: PrimalDeckNowPlayingPanel | undefined;

	private live = false;
	private reduceMotion = false;
	private spectrumCollapsed = false;
	/** Epoch ms of the last telemetry sample; the only input the lease watchdog has. */
	private lastSampleAt = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@ILogService private readonly logService: ILogService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IPrimalDeckService private readonly deckService: IPrimalDeckService,
		@IPrimalTelemetryService private readonly primalTelemetryService: IPrimalTelemetryService,
		@IPrimalMediaService private readonly primalMediaService: IPrimalMediaService,
	) {
		super(PrimalDeckEditor.ID, group, telemetryService, themeService, storageService);

		this.telemetryLease = this._register(new PrimalDeckLease(primalTelemetryService, LEASE_RENEW_INTERVAL_MS));
		this.mediaLease = this._register(new PrimalDeckLease(primalMediaService, MEDIA_LEASE_RENEW_INTERVAL_MS));
		this._register(this.telemetryLease.onDidFail(error => {
			this.logService.warn('[PrimalDeck] telemetry lease failed', error);
			this.telemetryPanel?.setUnavailable();
		}));
		this._register(this.mediaLease.onDidFail(error => {
			this.logService.warn('[PrimalDeck] media lease failed', error);
			this.nowPlayingPanel?.setUnavailable();
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		const targetWindow = DOM.getWindow(parent);
		this.targetWindow = targetWindow;

		const root = DOM.append(parent, $('.primal-deck-editor'));
		this.root = root;
		this.renderHeader(root);

		const body = DOM.append(root, $('.primal-deck-body'));
		const left = DOM.append(body, $('.primal-deck-column.primal-deck-left'));
		const centre = DOM.append(body, $('.primal-deck-column.primal-deck-centre'));
		const right = DOM.append(body, $('.primal-deck-column.primal-deck-right'));
		this.leftColumn = left;

		this.sessionsPanel = this.editorDisposables.add(this.instantiationService.createInstance(PrimalDeckSessionsPanel, left, targetWindow));

		const stream = this.editorDisposables.add(this.instantiationService.createInstance(PrimalDeckStream));
		this.stream = stream;
		this.streamView = this.editorDisposables.add(new PrimalDeckStreamView(centre, stream));
		this.editorDisposables.add(stream.onDidChangeSession(model => this.updateSessionLabel(model)));
		this.editorDisposables.add(stream.onDidChangeTitle(title => this.setSessionLabelText(title)));

		this.telemetryPanel = this.editorDisposables.add(new PrimalDeckTelemetryPanel(right));
		this.spectrum = this.editorDisposables.add(this.instantiationService.createInstance(PrimalDeckSpectrum, right, targetWindow, () => stream.streamRate.get()));

		this.renderFooter(root);

		// A hidden document (minimized, or another window in front) is the same
		// gate as a hidden pane: nothing samples for a screen nobody can see.
		this.editorDisposables.add(DOM.addDisposableListener(targetWindow.document, 'visibilitychange', () => this.updateLoops()));

		// Reduced motion has two sources: the workbench setting (which folds in
		// the OS preference) and the media query itself. Either one stops the
		// frame loop; the spectrum then repaints once per telemetry tick.
		this.reducedMotionQuery = targetWindow.matchMedia(REDUCED_MOTION_QUERY);
		this.editorDisposables.add(DOM.addDisposableListener(this.reducedMotionQuery, 'change', () => this.updateReducedMotion()));
		this.editorDisposables.add(this.accessibilityService.onDidChangeReducedMotion(() => this.updateReducedMotion()));
		this.updateReducedMotion();

		// Two one-time reads at creation, not loops: static machine facts, and
		// whether this platform has a Now Playing implementation at all.
		this.primalTelemetryService.getInfo().then(
			info => this.telemetryPanel?.setInfo(info),
			error => this.logService.warn('[PrimalDeck] telemetry info unavailable', error));
		this.resolveMediaCapabilities();
	}

	//#region Header

	private renderHeader(root: HTMLElement): void {
		const header = DOM.append(root, $('.primal-deck-header'));

		const brand = DOM.append(header, $('.primal-deck-brand'));
		// Product name - deliberately not localized, as on The Rig.
		DOM.append(brand, $('span.primal-deck-wordmark', undefined, 'Primal Code'));
		DOM.append(brand, $('span.primal-deck-title', undefined, localize('primalDeck.title', "The Deck")));

		this.renderVibeChip(header);

		this.clockLabel = DOM.append(header, $('span.primal-deck-clock'));
		this.updateClock();

		this.sessionLabel = DOM.append(header, $('span.primal-deck-session'));
		this.updateSessionLabel(undefined);

		this.renderExitButton(header);
	}

	private renderVibeChip(container: HTMLElement): void {
		const chip = DOM.append(container, $('button.primal-deck-control.primal-deck-vibe-chip')) as HTMLButtonElement;
		chip.type = 'button';
		this.vibeChip = chip;
		DOM.append(chip, $('span.primal-deck-control-icon' + ThemeIcon.asCSSSelector(Codicon.paintcan)));
		this.vibeChipLabel = DOM.append(chip, $('span.primal-deck-vibe-label'));

		this.updateVibeChip(this.vibeService.currentVibe);
		this.editorDisposables.add(this.vibeService.onDidChangeVibe(vibe => this.updateVibeChip(vibe)));
		this.editorDisposables.add(DOM.addDisposableListener(chip, 'click', () => {
			this.commandService.executeCommand(PRIMAL_VIBE_PICK_COMMAND_ID).catch(onUnexpectedError);
		}));
	}

	/** `undefined` is a real state - a theme outside every vibe - and is labelled as such. */
	private updateVibeChip(vibe: IPrimalVibe | undefined): void {
		if (!this.vibeChip || !this.vibeChipLabel) {
			return;
		}
		const label = vibe?.label ?? localize('primalDeck.vibe.custom', "Custom");
		this.vibeChipLabel.textContent = label;
		this.vibeChip.setAttribute('aria-label', localize('primalDeck.vibe.aria', "Vibe: {0}. Pick a vibe", label));
	}

	private renderExitButton(container: HTMLElement): void {
		const button = DOM.append(container, $('button.primal-deck-control.primal-deck-exit')) as HTMLButtonElement;
		button.type = 'button';
		DOM.append(button, $('span.primal-deck-control-icon' + ThemeIcon.asCSSSelector(Codicon.close)));
		DOM.append(button, $('span.primal-deck-exit-label', undefined, localize('primalDeck.leave', "Leave")));
		const keybinding = this.keybindingLabel(PRIMAL_DECK_TOGGLE_COMMAND_ID);
		if (keybinding) {
			DOM.append(button, $('span.primal-deck-kbd', undefined, keybinding));
		}
		button.setAttribute('aria-label', localize('primalDeck.leave.aria', "Leave The Deck"));
		this.editorDisposables.add(DOM.addDisposableListener(button, 'click', () => {
			this.deckService.leave().catch(onUnexpectedError);
		}));
	}

	private updateClock(): void {
		if (this.clockLabel) {
			this.clockLabel.textContent = this.clockFormat.value.format(Date.now());
		}
	}

	private onClockTick(): void {
		const now = Date.now();
		this.updateClock();
		this.nowPlayingPanel?.tick(now);
		this.checkLeases(now);
	}

	private updateSessionLabel(model: IChatModel | undefined): void {
		this.setSessionLabelText(model ? model.title : localize('primalDeck.noSession', "no agent running"));
	}

	private setSessionLabelText(text: string): void {
		if (this.sessionLabel) {
			this.sessionLabel.textContent = text;
			this.sessionLabel.title = text;
		}
	}

	//#endregion

	//#region Footer

	private renderFooter(root: HTMLElement): void {
		this.footer = DOM.append(root, $('.primal-deck-footer'));
		this.renderFooterHints();
		this.editorDisposables.add(this.keybindingService.onDidUpdateKeybindings(() => this.renderFooterHints()));
	}

	/** Hints are resolved from the keybinding service; an unbound command gets no hint. */
	private renderFooterHints(): void {
		const footer = this.footer;
		if (!footer) {
			return;
		}
		DOM.clearNode(footer);

		const hints: readonly IShortcutHint[] = [
			{ commandId: PRIMAL_DECK_TOGGLE_COMMAND_ID, text: localize('primalDeck.hint.leave', "leave") },
			{ commandId: PRIMAL_VIBE_CYCLE_COMMAND_ID, text: localize('primalDeck.hint.vibe', "vibe") },
			{ commandId: CHAT_OPEN_ACTION_ID, text: localize('primalDeck.hint.chat', "chat") }
		];

		let rendered = 0;
		for (const { commandId, text } of hints) {
			const keybinding = this.keybindingLabel(commandId);
			if (!keybinding) {
				continue;
			}
			if (rendered > 0) {
				DOM.append(footer, $('span.primal-deck-footer-separator', undefined, '·'));
			}
			const hint = DOM.append(footer, $('span.primal-deck-footer-hint'));
			DOM.append(hint, $('span.primal-deck-kbd', undefined, keybinding));
			DOM.append(hint, $('span.primal-deck-footer-text', undefined, text));
			rendered++;
		}
	}

	private keybindingLabel(commandId: string): string | undefined {
		return this.keybindingService.lookupKeybinding(commandId)?.getLabel() ?? undefined;
	}

	//#endregion

	//#region Live work and visibility gating

	private resolveMediaCapabilities(): void {
		this.primalMediaService.getCapabilities().then(capabilities => {
			const left = this.leftColumn;
			if (!capabilities.supported || this.nowPlayingPanel || !left || this.editorDisposables.isDisposed) {
				return;
			}
			this.nowPlayingPanel = this.editorDisposables.add(new PrimalDeckNowPlayingPanel(left));
			if (this.live) {
				this.startMedia();
			}
		}, error => this.logService.warn('[PrimalDeck] media capabilities unavailable', error));
	}

	/** The single decision: live iff this pane is the visible pane and its document is visible. */
	private updateLoops(): void {
		const shouldLive = this.isVisible() && this.targetWindow?.document.visibilityState === 'visible';
		if (shouldLive && !this.live) {
			this.startLive();
		} else if (!shouldLive && this.live) {
			this.stopLive();
		}
		this.updateSpectrumLoop();
	}

	private startLive(): void {
		this.live = true;
		this.lastSampleAt = Date.now();

		this.updateClock();
		this.clock.cancelAndSet(() => this.onClockTick(), CLOCK_INTERVAL_MS);

		this.liveDisposables.add(this.primalTelemetryService.onDidSample(sample => this.onSample(sample)));
		this.telemetryLease.start();
		if (this.nowPlayingPanel) {
			this.startMedia();
		}

		this.stream?.attach();
		this.sessionsPanel?.activate();
	}

	private stopLive(): void {
		this.live = false;

		this.clock.cancel();
		this.liveDisposables.clear();
		this.telemetryLease.stop();
		this.mediaLease.stop();

		this.stream?.detach();
		this.sessionsPanel?.deactivate();
	}

	private startMedia(): void {
		const panel = this.nowPlayingPanel;
		if (!panel || this.mediaLease.isActive) {
			return;
		}
		this.liveDisposables.add(this.primalMediaService.onDidChangeNowPlaying(nowPlaying => panel.update(nowPlaying, Date.now())));
		this.mediaLease.start();
		this.seedNowPlaying(panel);
	}

	/**
	 * Takes a fresh media lease without re-subscribing: the change listener
	 * belongs to `startMedia` and lives as long as the pane is live.
	 */
	private restartMedia(): void {
		const panel = this.nowPlayingPanel;
		if (!panel || !this.mediaLease.isActive) {
			return;
		}
		this.mediaLease.stop();
		this.mediaLease.start();
		this.seedNowPlaying(panel);
	}

	/** Seeds from the main process's last known state without waiting for the first poll; `getNowPlaying` does not poll. */
	private seedNowPlaying(panel: PrimalDeckNowPlayingPanel): void {
		this.primalMediaService.getNowPlaying().then(nowPlaying => {
			if (this.live) {
				panel.update(nowPlaying, Date.now());
			}
		}, onUnexpectedError);
	}

	private onSample(sample: IPrimalTelemetrySample): void {
		this.lastSampleAt = Date.now();
		this.telemetryPanel?.update(sample);
		this.spectrum?.setSample(sample.cores);
	}

	/**
	 * The main process drops a lease that goes unrenewed for `LEASE_EXPIRY_MS`,
	 * and it ignores a renewal for an id it no longer knows rather than
	 * reporting it back. A renderer that stalled longer than that - a machine
	 * asleep, a blocked main thread - would therefore renew a dead lease for
	 * ever while these panels went on presenting their last reading as live.
	 *
	 * Samples arrive once a second while the telemetry lease is held, so a
	 * longer gap than the expiry window means that lease is gone. Say so, and
	 * take a fresh one. The media lease is renewed by this same renderer on the
	 * same interval, so if one expired the other did too.
	 */
	private checkLeases(now: number): void {
		if (!this.live || now - this.lastSampleAt <= LEASE_EXPIRY_MS) {
			return;
		}
		this.lastSampleAt = now; // at most one recovery attempt per expiry window
		this.logService.warn(`[PrimalDeck] no telemetry sample in ${LEASE_EXPIRY_MS} ms; re-acquiring both leases`);

		this.telemetryPanel?.setUnavailable();
		this.telemetryLease.stop();
		this.telemetryLease.start();
		this.restartMedia();
	}

	private updateReducedMotion(): void {
		this.reduceMotion = this.accessibilityService.isMotionReduced() || !!this.reducedMotionQuery?.matches;
		this.updateSpectrumLoop();
	}

	/** rAF only while live, motion is not reduced, and the spectrum column is on screen. */
	private updateSpectrumLoop(): void {
		const spectrum = this.spectrum;
		if (!spectrum) {
			return;
		}
		if (this.live && !this.reduceMotion && !this.spectrumCollapsed) {
			spectrum.start();
		} else {
			spectrum.stop();
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		this.updateLoops();
	}

	override async setInput(input: PrimalDeckInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.updateLoops();
	}

	override clearInput(): void {
		super.clearInput();
		if (this.live) {
			this.stopLive();
		}
		this.updateSpectrumLoop();
	}

	//#endregion

	override focus(): void {
		super.focus();
		this.streamView?.focus();
	}

	/** Sizes are read here and only here: the column layout, then the canvas backing store. */
	override layout(dimension: Dimension): void {
		const root = this.root;
		if (!root) {
			return;
		}
		root.classList.toggle('narrow', dimension.width < NARROW_WIDTH_THRESHOLD);
		const compact = dimension.width < COMPACT_WIDTH_THRESHOLD;
		root.classList.toggle('compact', compact);
		this.spectrumCollapsed = compact;
		this.spectrum?.layout();
		this.updateSpectrumLoop();
	}

	override dispose(): void {
		if (this.live) {
			this.stopLive();
		}
		this.spectrum?.stop();
		super.dispose();
	}
}
