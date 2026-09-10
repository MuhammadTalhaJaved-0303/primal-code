/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IMotifRenderer, isMotifCanvas, PRIMAL_MOTIF_BUFFER_HEIGHT, PRIMAL_MOTIF_BUFFER_WIDTH, PRIMAL_MOTIF_SURFACE_CLASS, PrimalMotifRole } from './primalMotif.js';

/**
 * One motif surface: exactly one per workbench container, and therefore exactly
 * one per window.
 *
 * That is the whole performance argument made structural. A no-op passthrough
 * shader at 120fps took an M3 Pro from ~2% to 95% GPU and each additional
 * surface added ~25%; the cost is the loop, not the work inside it. There is no
 * API here that could produce a second surface for an editor, a split or a
 * panel, because there is no such API anywhere in this contrib.
 *
 * The mutable fields are the scheduler's frame bookkeeping. They live on the
 * surface rather than in the scheduler because they are per window, and the
 * scheduler is per workbench.
 */
export class MotifSurface extends Disposable {

	/** The `<canvas>` or `<div>` the renderer paints into. */
	readonly element: HTMLElement;

	/** The single animation frame handle for this window. Cleared to stop the loop. */
	readonly frame = this._register(new MutableDisposable<IDisposable>());

	/** Wall-clock time the next frame is due, in this window's `performance` epoch. */
	nextFrameAt = 0;

	/** Wall-clock time the current burst started. */
	burstStartedAt = 0;

	/** Eased motif time handed to the renderer, in milliseconds. */
	motifTime = 0;

	/** Wall-clock time of the previously rendered frame; 0 before the first. */
	lastRenderedAt = 0;

	/** Consecutive rendered frames whose `render()` blew the main-thread budget. */
	budgetStrikes = 0;

	/** Last CSS size handed to `resize()`, so a layout that changed nothing costs nothing. */
	private width = 0;
	private height = 0;

	constructor(
		readonly container: HTMLElement,
		readonly targetWindow: CodeWindow,
		readonly renderer: IMotifRenderer,
		/** The scheduler's content generation at the moment this was built. */
		readonly contentGeneration: number,
		/**
		 * The element the canvas is appended to. Ordinarily the wallpaper's own
		 * layer; a code-free pane that offered itself as a stage otherwise. Kept
		 * as a field so the scheduler can notice the host has changed under an
		 * existing surface and rebuild rather than leave the canvas orphaned in
		 * the element it used to live in.
		 */
		readonly host: HTMLElement,
		/**
		 * Which kind of ground {@link host} is.
		 *
		 * Carried on the surface because the scheduler has to restate it on the
		 * workbench container every pass - `media/primalMotif.css` has two rules
		 * that may only fire while the wallpaper's own layer is the host - and
		 * `applyTo` holds the surface rather than the mount that produced it.
		 */
		readonly role: PrimalMotifRole,
		/**
		 * The element whose CSS box the renderer is sized from.
		 *
		 * Defaults to the container, which is what every ground surface uses and
		 * therefore leaves the existing behaviour untouched. A stage is a pane
		 * inside the window rather than the window itself, and `placement()` in
		 * `motifs/globe.ts` divides by this size to correct the fixed 640x360
		 * buffer being stretched to the host: measuring the whole window for a
		 * surface that only covers a pane would draw the disc as an ellipse.
		 */
		private readonly measure: HTMLElement = container
	) {
		super();

		// A `<canvas>` for both canvas kinds; a plain element for `css`, which
		// animates through custom properties rather than pixels.
		this.element = renderer.kind === 'css'
			? $<HTMLElement>(`div.${PRIMAL_MOTIF_SURFACE_CLASS}`, { 'aria-hidden': 'true' })
			: $<HTMLCanvasElement>(`canvas.${PRIMAL_MOTIF_SURFACE_CLASS}`, { 'aria-hidden': 'true' });

		if (isMotifCanvas(this.element)) {
			// Fixed buffer, upscaled by CSS. A 5K panel costs exactly what a
			// laptop panel costs: 640 * 360 * 4 bytes of backing store.
			this.element.width = PRIMAL_MOTIF_BUFFER_WIDTH;
			this.element.height = PRIMAL_MOTIF_BUFFER_HEIGHT;
		}

		// Inside the host, not beside it. For the wallpaper's own layer - which
		// is the host in every window that has not offered a stage - that layer
		// already carries `z-index: -1`, the clamped opacity ceiling and the
		// grain pseudo-element that paints above its children. The motif
		// inherits all three, and the four opaque slabs still sit on top of the
		// whole stratum, so art can never end up behind code. A stage host is
		// outside that layer and inherits none of them, which is why
		// `media/primalMotif.css` restates each one for the stage rule and why a
		// stage may only ever be offered by a pane that shows no code.
		host.appendChild(this.element);
		this._register(toDisposable(() => this.element.remove()));

		this._register(renderer);
	}

	/**
	 * Registers a disposable with this surface's lifetime.
	 *
	 * `Disposable._register` is protected, and the scheduler has to attach the
	 * context-loss listener from outside, so the surface exposes exactly this
	 * much of its store and nothing else.
	 */
	add<T extends IDisposable>(disposable: T): T {
		return this._register(disposable);
	}

	/** Tells the renderer about a new CSS size, at most once per actual change. */
	layout(): void {
		const width = Math.max(0, this.measure.clientWidth);
		const height = Math.max(0, this.measure.clientHeight);
		if (width === this.width && height === this.height) {
			return;
		}

		this.width = width;
		this.height = height;
		this.renderer.resize(width, height);
	}

	/**
	 * Frees the backing store before the element goes away. Setting a canvas to
	 * zero by zero is the only portable way to make the browser drop the pixels
	 * immediately rather than at the next garbage collection.
	 */
	override dispose(): void {
		if (isMotifCanvas(this.element)) {
			this.element.width = 0;
			this.element.height = 0;
		}
		super.dispose();
	}
}
