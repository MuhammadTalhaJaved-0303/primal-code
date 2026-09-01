/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { PRIMAL_HARNESS_PROVIDER_SETTING_ID, providerById } from '../../../../platform/agentHost/common/primalProviders.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { isHighContrast } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPrimalVibeService } from '../../primalVibes/browser/primalVibes.js';

/**
 * Timings, in milliseconds. TypeScript owns them: the numbers below are pushed
 * onto the overlay element as custom properties so the stylesheet and the
 * schedule here cannot drift apart.
 *
 * On-screen budget (atmosphere-spec.md section A): `HOLD + FADE` must stay at or
 * under 1400ms. Normal motion: 900 + 260 = 1160ms. Reduced motion: 400 + 260 =
 * 660ms. The staged reveal finishes well inside the hold — the last of at most
 * four lines starts at 3 * 90 = 270ms and completes at 450ms.
 */
const REVEAL_MS = 180;
const STAGGER_MS = 90;
const HOLD_MS = 900;
const REDUCED_HOLD_MS = 400;
const FADE_MS = 260;

/** One `key value` row of the readout. Both halves are real state. */
interface IBootStatusLine {
	readonly key: string;
	readonly value: string;
}

/**
 * The boot sequence overlay — a brief, skippable status readout painted over the
 * workbench once per window open (atmosphere-spec.md, "A. Boot sequence").
 *
 * Three properties are load-bearing rather than decorative:
 *
 * - **It never takes anything from the user.** The element is `pointer-events:
 *   none`, `inert` and `aria-hidden`, holds nothing focusable, and is therefore
 *   absent from the tab order. The dismissal listeners are capture-phase
 *   *observers* on the window that never call `preventDefault` or
 *   `stopPropagation`, so the keystroke that dismisses the overlay still lands
 *   in the workbench underneath. This mirrors how Screencast Mode watches
 *   keyboard input (`browser/actions/developerActions.ts`, which attaches
 *   capture-phase `keydown` emitters purely to display what was typed).
 *
 * - **Every rendered line is true.** See {@link collectStatusLines}: each row is
 *   read straight off a service, synchronously. Anything that would need an
 *   async read is dropped rather than faked or waited on.
 *
 * - **It disposes completely.** The DOM node, both timers and all three
 *   listeners live in this object's store, so a window closing mid-animation
 *   tears everything down through the normal contribution shutdown path.
 */
export class PrimalBootOverlay extends Disposable {

	private readonly timers = this._register(new DisposableStore());
	private readonly dismissListeners = this._register(new DisposableStore());

	private overlay: HTMLElement | undefined;
	private fading = false;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
		@IProductService private readonly productService: IProductService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILabelService private readonly labelService: ILabelService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();

		// High contrast opts out of the whole atmosphere layer. The stylesheet
		// guards on the same theme classes, but bailing here means no DOM node
		// and no listeners at all rather than an invisible one.
		if (isHighContrast(themeService.getColorTheme().type)) {
			return;
		}

		// Main window only. `mainContainer` is by definition the container of the
		// main window (`browser/layout.ts` returns it for the main document and
		// looks the element up in the target document for auxiliary ones), so the
		// check below states the invariant rather than discovering it: a floating
		// editor window must never get a boot screen. The test is identity against
		// the known main window rather than `isAuxiliaryWindow`, whose type
		// predicate is over `CodeWindow` — the very type `getWindow` returns — and
		// so would narrow this branch's `targetWindow` to `never`.
		const container = layoutService.mainContainer;
		const targetWindow = getWindow(container);
		if (targetWindow !== mainWindow) {
			return;
		}

		const overlay = this.render(container);
		this.overlay = overlay;
		this._register(toDisposable(() => overlay.remove()));

		// Reduced motion has two independent sources: the workbench setting
		// (which the accessibility service folds together with the OS preference)
		// and the media query the stylesheet itself keys off. Either one shortens
		// the hold, so the readout is never left sitting still on screen after the
		// staged reveal has been styled away.
		const reduceMotion = accessibilityService.isMotionReduced() || targetWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;

		this.registerDismissListeners(targetWindow);
		disposableTimeout(() => this.beginFade(), reduceMotion ? REDUCED_HOLD_MS : HOLD_MS, this.timers);
	}

	/**
	 * Builds the overlay. No per-frame work happens anywhere in this class: the
	 * wordmark and the staged reveal are CSS keyframe animations that start when
	 * the element enters the document, and the fade-out is a CSS transition
	 * triggered by a single class flip.
	 */
	private render(container: HTMLElement): HTMLElement {
		const overlay = $('.primal-boot-overlay', { 'aria-hidden': 'true', 'inert': '' });

		overlay.style.setProperty('--primal-boot-reveal', `${REVEAL_MS}ms`);
		overlay.style.setProperty('--primal-boot-stagger', `${STAGGER_MS}ms`);
		overlay.style.setProperty('--primal-boot-fade', `${FADE_MS}ms`);

		const panel = append(overlay, $('.primal-boot-panel'));
		append(panel, $('.primal-boot-wordmark', undefined, this.productService.nameLong));

		const list = append(panel, $('.primal-boot-lines'));
		const lines = this.collectStatusLines();
		for (let index = 0; index < lines.length; index++) {
			const row = append(list, $('.primal-boot-line'));
			row.style.setProperty('--primal-boot-line-index', String(index));
			append(row, $('span.primal-boot-key', undefined, lines[index].key));
			append(row, $('span.primal-boot-value', undefined, lines[index].value));
		}

		return append(container, overlay);
	}

	/**
	 * The readout. Every line is derived from live state through a synchronous
	 * call — nothing here can block startup, and nothing here is invented.
	 *
	 * A "configured providers" count is deliberately absent. Whether a provider
	 * is configured means whether its API key is in secret storage, and that is
	 * an `await`ed read (see the settings editor's provider rows, which await
	 * `ISecretStorageService.get` per provider). Waiting on it would delay the
	 * boot and guessing it would be a fake readout, so the line the settings
	 * actually hold synchronously — which provider drives the coding agent — is
	 * shown instead, and dropped entirely when that setting resolves to nothing.
	 */
	private collectStatusLines(): IBootStatusLine[] {
		const lines: IBootStatusLine[] = [];

		// Product identity: true by construction, straight off the product configuration.
		lines.push({
			key: localize('primalBoot.key.version', "version"),
			value: this.productService.version
		});

		// Active vibe. `currentVibe` is undefined when the user is on a color theme
		// outside the vibe set; the vibes status bar entry calls that state "Custom".
		const vibe = this.vibeService.currentVibe;
		lines.push({
			key: localize('primalBoot.key.vibe', "vibe"),
			value: vibe ? vibe.label : localize('primalBoot.value.customVibe', "custom")
		});

		lines.push({
			key: localize('primalBoot.key.workspace', "workspace"),
			value: this.workspaceLabel()
		});

		// The provider selected to drive the coding agent, from the plain
		// (non-secret) setting that names it. The key is "provider" rather than
		// "agent" on purpose: this states which provider is selected, which is all
		// the setting knows. Whether that provider holds a key is the secret read
		// this line refuses to make, so the line must not imply readiness.
		const provider = providerById(this.configurationService.getValue<string>(PRIMAL_HARNESS_PROVIDER_SETTING_ID));
		if (provider) {
			lines.push({
				key: localize('primalBoot.key.provider', "provider"),
				value: provider.label
			});
		}

		return lines;
	}

	/** The workspace name, or an explicit "no folder" for an empty window. */
	private workspaceLabel(): string {
		const none = localize('primalBoot.value.noFolder', "no folder");
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return none;
		}

		// `getWorkspaceLabel` also answers with an empty string for a workspace it
		// cannot name, so the fallback covers both shapes of "nothing open".
		return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace()) || none;
	}

	/**
	 * Any key, pointer or wheel input dismisses the overlay.
	 *
	 * These are pure observers. They run in the capture phase so they see the
	 * event before anything else can stop it, and they neither cancel it nor stop
	 * its propagation — the keystroke continues to the workbench exactly as if
	 * the overlay were not there. `passive: true` makes that structural rather
	 * than a matter of discipline: the browser refuses `preventDefault` on a
	 * passive listener, and it also keeps the wheel listener off the scrolling
	 * critical path.
	 */
	private registerDismissListeners(targetWindow: Window): void {
		const options: AddEventListenerOptions = { capture: true, passive: true };
		const dismiss = () => this.beginFade();

		this.dismissListeners.add(addDisposableListener(targetWindow, EventType.KEY_DOWN, dismiss, options));
		this.dismissListeners.add(addDisposableListener(targetWindow, EventType.POINTER_DOWN, dismiss, options));
		this.dismissListeners.add(addDisposableListener(targetWindow, EventType.MOUSE_WHEEL, dismiss, options));
	}

	/** Starts the fade-out and schedules the teardown that ends this object's life. */
	private beginFade(): void {
		if (!this.overlay || this.fading) {
			return;
		}

		this.fading = true;
		this.dismissListeners.clear(); // nothing left to dismiss

		this.overlay.classList.add('fading');
		disposableTimeout(() => this.dispose(), FADE_MS, this.timers);
	}
}
