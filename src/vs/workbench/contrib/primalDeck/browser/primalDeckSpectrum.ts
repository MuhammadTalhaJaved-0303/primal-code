/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { descriptionForeground, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { clampFraction } from './primalDeckFormat.js';

const $ = DOM.$;

/** Per-frame weight of the exponential average that smooths the DISPLAYED values only. */
const EMA_ALPHA = 0.25;
/** Points of rate history drawn across the plot (about 2.7 s at 60 Hz). */
const TRACE_POINTS = 160;
/** Chars/s that fill the plot height when nothing faster has been seen lately. */
const RATE_FLOOR = 40;
/** Per-frame relaxation of the auto-range back toward the floor. */
const RATE_SCALE_DECAY = 0.995;
/** Room reserved at the top for the on-canvas labels. */
const LABEL_HEIGHT = 16;
const BAR_ALPHA = 0.35;

/** Distinguishes the readouts of two Decks open in two editor groups. */
let readoutIdCounter = 0;

/**
 * The spectrum: one bar per CPU core from the latest telemetry sample, and a
 * trace of the agent's output rate, both labelled on the canvas.
 *
 * The frame loop exists only between `start()` and `stop()`; the pane calls
 * them from its visibility gate. In reduced motion the pane never starts the
 * loop and instead `setSample()` repaints once per telemetry tick, with no
 * smoothing at all. The canvas is sized in `layout()` and never per frame.
 *
 * Canvas pixels are not in the accessibility tree, so the one number that lives
 * nowhere else in the pane - the agent's output rate - is mirrored into an
 * off-screen readout the canvas points at. That mirror is written once per
 * telemetry sample, never from `draw()`.
 */
export class PrimalDeckSpectrum extends Disposable {

	private readonly host: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly readout: HTMLElement;
	private readonly frame = this._register(new MutableDisposable<IDisposable>());
	private readonly sourceLabel = localize('primalDeck.spectrum.source', "cpu · stream rate");

	private running = false;
	private frames = 0;
	private width = 0;
	private height = 0;
	private ratio = 1;
	private font = '11px monospace';
	private ink = '';
	private dim = '';

	private cores: readonly number[] = [];
	private displayedCores = new Float64Array(0);
	private displayedRate = 0;
	private rateScale = RATE_FLOOR;
	private readonly trace = new Float32Array(TRACE_POINTS);
	private traceHead = 0;

	constructor(
		container: HTMLElement,
		private readonly targetWindow: Window,
		private readonly readRate: () => number,
		@IThemeService private readonly themeService: IThemeService
	) {
		super();

		const panel = DOM.append(container, $('.primal-deck-panel.primal-deck-spectrum'));
		DOM.append(panel, $('h2.primal-deck-panel-label', undefined, localize('primalDeck.spectrum', "Spectrum")));
		this.host = DOM.append(panel, $('.primal-deck-spectrum-host'));
		this.canvas = DOM.append(this.host, $('canvas.primal-deck-spectrum-canvas')) as HTMLCanvasElement;
		this.canvas.setAttribute('role', 'img');
		this.canvas.setAttribute('aria-label', localize('primalDeck.spectrum.aria', "Spectrum: one bar per CPU core, and a trace of the agent's output rate in characters per second"));

		// The per-core bars are already readable as the telemetry panel's meter
		// rows; the rate is not readable anywhere else, so it goes here.
		this.readout = DOM.append(panel, $('span.primal-deck-spectrum-readout'));
		this.readout.id = `primal-deck-spectrum-readout-${readoutIdCounter++}`;
		this.canvas.setAttribute('aria-describedby', this.readout.id);
		this.updateReadout();

		this.readColors();
		this._register(this.themeService.onDidColorThemeChange(() => {
			this.readColors();
			this.draw();
		}));
	}

	/** Frames drawn so far; stops advancing the moment the loop is stopped. */
	get framesDrawn(): number {
		return this.frames;
	}

	private readColors(): void {
		const theme = this.themeService.getColorTheme();
		this.ink = theme.getColor(foreground)?.toString() ?? '';
		this.dim = theme.getColor(descriptionForeground)?.toString() ?? this.ink;
	}

	/** Reads the host's size once, here, and sizes the backing store for the device pixel ratio. */
	layout(): void {
		const ratio = this.targetWindow.devicePixelRatio || 1;
		this.width = Math.max(0, this.host.clientWidth);
		this.height = Math.max(0, this.host.clientHeight);
		this.ratio = ratio;
		this.canvas.width = Math.floor(this.width * ratio);
		this.canvas.height = Math.floor(this.height * ratio);
		this.canvas.style.width = `${this.width}px`;
		this.canvas.style.height = `${this.height}px`;
		this.font = this.targetWindow.getComputedStyle(this.canvas).font || this.font;
		this.draw();
	}

	/** The latest per-core busy fractions. While the loop is not running this repaints once, unsmoothed. */
	setSample(cores: readonly number[]): void {
		this.cores = cores;
		if (this.displayedCores.length !== cores.length) {
			this.displayedCores = Float64Array.from(cores);
		}
		if (!this.running) {
			this.snapToTargets();
			this.draw();
		}
		// Once per sample, never per frame: `draw()` runs at the display's rate.
		this.updateReadout();
	}

	/** The text form of the number the trace draws, for readers the canvas cannot reach. */
	private updateReadout(): void {
		this.readout.textContent = localize(
			'primalDeck.spectrum.readout',
			"Agent output rate {0} characters per second; plot scale tops out at {1}.",
			Math.round(this.readRate()),
			Math.round(this.rateScale));
	}

	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.scheduleFrame();
	}

	stop(): void {
		this.running = false;
		this.frame.clear();
	}

	private scheduleFrame(): void {
		this.frame.value = DOM.scheduleAtNextAnimationFrame(this.targetWindow, () => {
			if (!this.running) {
				return;
			}
			this.step();
			this.draw();
			this.scheduleFrame();
		});
	}

	/** One smoothing step toward the real values. The samples themselves are untouched. */
	private step(): void {
		const displayed = this.displayedCores;
		for (let index = 0; index < displayed.length; index++) {
			displayed[index] += (this.cores[index] - displayed[index]) * EMA_ALPHA;
		}
		const rate = this.readRate();
		this.displayedRate += (rate - this.displayedRate) * EMA_ALPHA;
		this.rateScale = Math.max(RATE_FLOOR, this.displayedRate, this.rateScale * RATE_SCALE_DECAY);
		this.pushTrace(this.displayedRate);
	}

	private snapToTargets(): void {
		this.displayedCores.set(this.cores);
		this.displayedRate = this.readRate();
		this.rateScale = Math.max(RATE_FLOOR, this.displayedRate, this.rateScale * RATE_SCALE_DECAY);
		this.pushTrace(this.displayedRate);
	}

	private pushTrace(value: number): void {
		this.trace[this.traceHead] = value;
		this.traceHead = (this.traceHead + 1) % TRACE_POINTS;
	}

	private draw(): void {
		const context = this.canvas.getContext('2d');
		const width = this.width;
		const height = this.height;
		if (!context || width === 0 || height === 0 || !this.ink) {
			return;
		}
		this.frames++;

		context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
		context.clearRect(0, 0, width, height);

		const plotTop = LABEL_HEIGHT;
		const plotHeight = Math.max(1, height - plotTop - 2);

		// Bars: one per core, height = that core's busy fraction.
		const count = this.displayedCores.length;
		if (count > 0) {
			const gap = count > 32 ? 1 : 2;
			const barWidth = Math.max(1, (width - gap * (count - 1)) / count);
			context.fillStyle = this.ink;
			context.globalAlpha = BAR_ALPHA;
			for (let index = 0; index < count; index++) {
				const barHeight = clampFraction(this.displayedCores[index]) * plotHeight;
				context.fillRect(index * (barWidth + gap), plotTop + plotHeight - barHeight, barWidth, barHeight);
			}
			context.globalAlpha = 1;
		}

		// Trace: the output rate over the recent past, scaled to `rateScale` at full height.
		context.strokeStyle = this.ink;
		context.lineWidth = 1.25;
		context.beginPath();
		for (let point = 0; point < TRACE_POINTS; point++) {
			const value = this.trace[(this.traceHead + point) % TRACE_POINTS];
			const x = (point / (TRACE_POINTS - 1)) * width;
			const y = plotTop + plotHeight - clampFraction(value / this.rateScale) * plotHeight;
			if (point === 0) {
				context.moveTo(x, y);
			} else {
				context.lineTo(x, y);
			}
		}
		context.stroke();

		// Labels: what is drawn, and the scale the trace is drawn against.
		context.fillStyle = this.dim;
		context.font = this.font;
		context.textBaseline = 'top';
		context.textAlign = 'left';
		context.fillText(this.sourceLabel, 0, 0);
		context.textAlign = 'right';
		context.fillText(localize('primalDeck.spectrum.rate', "{0} chars/s · top {1}", Math.round(this.displayedRate), Math.round(this.rateScale)), width, 0);
		context.textAlign = 'left';
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
