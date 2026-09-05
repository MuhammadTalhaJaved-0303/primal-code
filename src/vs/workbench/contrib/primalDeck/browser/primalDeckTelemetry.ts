/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IPrimalTelemetryInfo, IPrimalTelemetrySample } from '../../../../platform/primalTelemetry/common/primalTelemetry.js';
import { clampFraction, formatLoadAverage, formatMemory, formatPercent, formatUptime } from './primalDeckFormat.js';

const $ = DOM.$;

interface IMeterRow {
	readonly root: HTMLElement;
	readonly meter: HTMLElement;
	readonly fill: HTMLElement;
	readonly value: HTMLElement;
}

interface ITextRow {
	readonly root: HTMLElement;
	readonly value: HTMLElement;
}

/**
 * The telemetry readouts: total CPU, one bar per core, memory, load averages
 * and uptime, straight from `IPrimalTelemetrySample`. Rows are built once and
 * patched per sample; nothing here is derived or estimated.
 */
export class PrimalDeckTelemetryPanel extends Disposable {

	private readonly status: HTMLElement;
	private readonly readouts: HTMLElement;
	private readonly cpu: IMeterRow;
	private readonly coresHost: HTMLElement;
	private coreRows: readonly IMeterRow[] = [];
	private readonly memory: IMeterRow;
	private readonly load: ITextRow;
	private readonly uptime: ITextRow;
	private readonly caption: HTMLElement;

	constructor(container: HTMLElement) {
		super();

		const panel = DOM.append(container, $('.primal-deck-panel.primal-deck-telemetry'));
		DOM.append(panel, $('h2.primal-deck-panel-label', undefined, localize('primalDeck.telemetry', "Telemetry")));
		this.status = DOM.append(panel, $('.primal-deck-panel-status', undefined, localize('primalDeck.telemetry.waiting', "Waiting for the first sample…")));

		this.readouts = DOM.append(panel, $('.primal-deck-readouts.pending'));
		this.cpu = this.createMeterRow(this.readouts, localize('primalDeck.telemetry.cpu', "cpu"));
		this.coresHost = DOM.append(this.readouts, $('.primal-deck-cores'));
		this.memory = this.createMeterRow(this.readouts, localize('primalDeck.telemetry.memory', "mem"));
		this.load = this.createTextRow(this.readouts, localize('primalDeck.telemetry.load', "load"));
		this.uptime = this.createTextRow(this.readouts, localize('primalDeck.telemetry.uptime', "up"));

		this.caption = DOM.append(panel, $('.primal-deck-panel-caption'));
	}

	/** Static machine facts, read once. Hides the load row where the platform reports no real values. */
	setInfo(info: IPrimalTelemetryInfo): void {
		this.caption.textContent = localize('primalDeck.telemetry.caption', "{0} · {1} cores · {2}", info.cpuModel, info.coreCount, info.arch);
		this.caption.title = this.caption.textContent;
		this.load.root.classList.toggle('hidden', !info.hasLoadAverage);
	}

	update(sample: IPrimalTelemetrySample): void {
		this.setMeter(this.cpu, sample.cpuTotal, formatPercent(sample.cpuTotal));

		if (this.coreRows.length !== sample.cores.length) {
			this.rebuildCoreRows(sample.cores.length);
		}
		for (let index = 0; index < sample.cores.length; index++) {
			this.setMeter(this.coreRows[index], sample.cores[index], formatPercent(sample.cores[index]));
		}

		const memoryFraction = sample.memoryTotal > 0 ? sample.memoryUsed / sample.memoryTotal : 0;
		this.setMeter(this.memory, memoryFraction, formatMemory(sample.memoryUsed, sample.memoryTotal));
		this.load.value.textContent = formatLoadAverage(sample.loadAverage);
		this.uptime.value.textContent = formatUptime(sample.uptime);

		this.readouts.classList.remove('pending', 'stale');
		this.status.textContent = '';
	}

	/**
	 * No sample is arriving - the lease could not be held, or it expired. The
	 * panel says so, and the last real numbers recede: they stay readable as
	 * the last thing the machine reported, and stop reading as live.
	 */
	setUnavailable(): void {
		this.status.textContent = localize('primalDeck.telemetry.unavailable', "Telemetry unavailable.");
		this.readouts.classList.add('stale');
	}

	private rebuildCoreRows(count: number): void {
		DOM.clearNode(this.coresHost);
		const rows: IMeterRow[] = [];
		for (let index = 0; index < count; index++) {
			rows.push(this.createMeterRow(this.coresHost, localize('primalDeck.telemetry.core', "c{0}", index)));
		}
		this.coreRows = rows;
	}

	private createMeterRow(parent: HTMLElement, key: string): IMeterRow {
		const root = DOM.append(parent, $('.primal-deck-row'));
		DOM.append(root, $('span.primal-deck-row-key', undefined, key));
		const meter = DOM.append(root, $('.primal-deck-meter', { role: 'meter', 'aria-label': key, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }));
		const fill = DOM.append(meter, $('.primal-deck-meter-fill'));
		const value = DOM.append(root, $('span.primal-deck-row-value'));
		return { root, meter, fill, value };
	}

	private createTextRow(parent: HTMLElement, key: string): ITextRow {
		const root = DOM.append(parent, $('.primal-deck-row'));
		DOM.append(root, $('span.primal-deck-row-key', undefined, key));
		const value = DOM.append(root, $('span.primal-deck-row-value.primal-deck-row-text'));
		return { root, value };
	}

	private setMeter(row: IMeterRow, fraction: number, text: string): void {
		const percent = Math.round(clampFraction(fraction) * 1000) / 10;
		row.fill.style.width = `${percent}%`;
		row.meter.setAttribute('aria-valuenow', String(Math.round(percent)));
		row.value.textContent = text;
	}
}
