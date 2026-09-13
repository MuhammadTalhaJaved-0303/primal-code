/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ThermalState } from '../../../services/power/common/powerService.js';
import {
	PRIMAL_MOTIF_BATTERY_FPS,
	PRIMAL_MOTIF_INPUT_QUIET_MS,
	PRIMAL_MOTIF_MAX_FPS,
	PRIMAL_MOTIF_STATIC_ID,
	PrimalMotifMotion,
	PrimalMotifRole,
	PrimalMotifState
} from './primalMotif.js';

/**
 * Primal Code - the motif degradation ladder.
 *
 * A pure function of an explicit set of readings. Nothing here touches the DOM,
 * a service, a clock or a timer, so the whole of "when is motion allowed" can be
 * read, reviewed and reasoned about in one screen, and the scheduler is left
 * with the job of gathering the readings and obeying the answer.
 *
 * MOST RESTRICTIVE WINS. Each rung returns as soon as it matches, so the first
 * match is the answer and the rest of the ladder is not consulted. The order is
 * the order of the design table, with the terminal conditions first.
 */

/**
 * What the ladder decided the scheduler should be doing.
 *
 * `off` is not "paused": it means tear everything down, because the pixels
 * cannot be seen by anybody. `rest` keeps the last painted frame on screen but
 * schedules nothing. `run` is the only mode that costs anything per frame.
 */
export type MotifRunMode = 'off' | 'rest' | 'run';

export interface IMotifPlan {
	readonly mode: MotifRunMode;
	/** Frames per second to schedule. 0 unless `mode` is `run`. */
	readonly fps: number;
	readonly state: PrimalMotifState;
	/**
	 * Localized sentence for the status bar tooltip: why motion is not running,
	 * or - on the one `run` rung that is a degradation, the budget guard - why
	 * it runs at half the rate. `undefined` while motion runs unthrottled.
	 */
	readonly reason: string | undefined;
	/** True when the burst has no end: perpetual mode, on a motif that allows it. */
	readonly perpetual: boolean;
}

/**
 * Whether this machine is on battery.
 *
 * `unknown` is a real answer, not a missing one. `powerMonitor`'s `on-ac` and
 * `on-battery` events only exist on macOS and Windows
 * (`platform/native/electron-main/nativeHostMainService.ts`, which is what
 * `IPowerService` forwards), so on Linux there is no signal at all and a
 * `false` there would be a guess rather than a reading. The ladder therefore
 * treats `unknown` exactly like `battery`: motion runs only if the user
 * explicitly opted in. That is the safe default - we never spend somebody's
 * battery on the strength of an assumption.
 */
export type MotifPowerSource = 'mains' | 'battery' | 'unknown';

/** The speed limit `powerMonitor` reports; 100 means "no throttling". */
export const SPEED_LIMIT_NOMINAL = 100;

/** Everything the ladder is allowed to know. */
export interface IMotifLadderInputs {
	readonly motifId: string;
	/** False when the id is unknown, or when the motif opted out of perpetual motion. */
	readonly motifAllowsPerpetual: boolean;
	/** True when no motif with this id is registered at all. */
	readonly motifMissing: boolean;
	/**
	 * True when this motif's `create()` declined under the current palette.
	 *
	 * Distinct from {@link unavailable}: a refusal is about one motif and one
	 * palette, and switching motif or theme is the recovery. It never takes the
	 * layer down with it.
	 */
	readonly motifRefused: boolean;

	/** Rule 7, terminal: a graphics context could not be created or was lost. */
	readonly unavailable: boolean;
	readonly highContrast: boolean;
	readonly motion: PrimalMotifMotion;
	/** Rule 2: the workbench setting or `prefers-reduced-motion`. */
	readonly reducedMotion: boolean;
	readonly paused: boolean;
	/** Rule 3: this window has keyboard focus. */
	readonly focused: boolean;
	/** Rule 5: macOS only; `unknown` everywhere else, and `unknown` is not throttled. */
	readonly thermal: ThermalState;
	/** Rule 5: macOS and Windows; stays at {@link SPEED_LIMIT_NOMINAL} elsewhere. */
	readonly speedLimit: number;
	/** Rule 4. */
	readonly power: MotifPowerSource;
	readonly perpetualOnBattery: boolean;
	/** Rule 6: milliseconds since the last keystroke or wheel event. */
	readonly quietForMs: number;
	/**
	 * The self-imposed rung: THIS motif, in a role it is mounted in now, could
	 * not hold the frame budget. Keyed by {@link motifBudgetKey} in the
	 * scheduler, so a strike earned by one motif on a stage is not paid by
	 * another motif, or by the same motif in a strip.
	 */
	readonly overBudget: boolean;
}

/**
 * What a budget strike is recorded against: a motif in a role.
 *
 * A role and not only a motif, because the same renderer is a different
 * workload in each: `world` measures 0.019ms in the 35px strip and 0.360ms on
 * a Start stage, twenty times more, and a strike on the stage says nothing
 * about the strip. Pure, so the scheduler's bookkeeping can be tested without
 * the scheduler.
 */
export function motifBudgetKey(motifId: string, role: PrimalMotifRole): string {
	return `${motifId}@${role}`;
}

export const resolveMotifPlan = (inputs: IMotifLadderInputs): IMotifPlan => {

	// Rule 7. Terminal, and checked before anything that could restart work: a
	// lost context stays lost for the session and is never retried.
	if (inputs.unavailable) {
		return { mode: 'off', fps: 0, state: 'unavailable', perpetual: false, reason: localize('primalCode.motif.reason.unavailable', "The graphics context was lost, so the motif is static for the rest of this session.") };
	}

	// The `static` motif and `motion: 'off'` are the same outcome by different
	// routes, and both come through this function, so the default configuration
	// is exercised by the same code as everything else.
	if (inputs.motifMissing || inputs.motifId === PRIMAL_MOTIF_STATIC_ID) {
		return { mode: 'off', fps: 0, state: 'static', perpetual: false, reason: undefined };
	}

	// This motif said it could not be drawn from the active palette. Only this
	// motif, and only until the palette changes - which is why the reason names
	// both the motif and the recovery rather than reading as a failure.
	if (inputs.motifRefused) {
		return { mode: 'off', fps: 0, state: 'static', perpetual: false, reason: localize('primalCode.motif.reason.refused', "'{0}' cannot be drawn from the active theme, so the ground keeps the wallpaper's own wash. Another theme or another motif will paint.", inputs.motifId) };
	}

	if (inputs.highContrast) {
		return { mode: 'off', fps: 0, state: 'static', perpetual: false, reason: localize('primalCode.motif.reason.highContrast', "High contrast themes opt out of the motif entirely.") };
	}

	if (inputs.motion === 'off') {
		return { mode: 'off', fps: 0, state: 'static', perpetual: false, reason: undefined };
	}

	// Rule 2. Permanently static: `rest` paints the motif's resting frame exactly
	// once and schedules nothing, so the art is still there and the loop never
	// starts. There is nothing to ease and nothing to pause.
	if (inputs.reducedMotion) {
		return { mode: 'rest', fps: 0, state: 'static', perpetual: false, reason: localize('primalCode.motif.reason.reducedMotion', "Reduced motion is on, so the motif stays on a single static frame.") };
	}

	// The pause is checked before anything else that could let motion run, and
	// unconditionally - not only in perpetual mode.
	//
	// `primalCode.motif.togglePause` is in the command palette in every motion
	// mode, and WCAG 2.2.2 asks that a pause mechanism actually pause. Reading
	// `paused` only when perpetual motion happened to be resolved made the
	// command a silent no-op during a settle burst, and made the status bar item
	// a no-op for a motif whose descriptor declines perpetual motion. Paused now
	// means paused, whichever route the user took to it.
	if (inputs.paused) {
		return {
			mode: 'rest', fps: 0, state: 'paused',
			// Still reported honestly, so the status bar knows whether resuming
			// gives back a perpetual loop or another settling burst.
			perpetual: inputs.motion === 'perpetual' && inputs.motifAllowsPerpetual,
			reason: localize('primalCode.motif.reason.paused', "Paused. Select this item to resume.")
		};
	}

	// Perpetual motion is a per-motif opt-in, not a global switch: a motif that
	// says no settles whatever the setting says.
	const perpetual = inputs.motion === 'perpetual' && inputs.motifAllowsPerpetual;

	// Rule 3. We park on blur ourselves because Electron only tracks occlusion in
	// `visibilityState` on macOS; on Windows and Linux a fully buried window
	// keeps animating, so the platform cannot be trusted to tell us.
	if (!inputs.focused) {
		return { mode: 'rest', fps: 0, state: 'parked', perpetual, reason: localize('primalCode.motif.reason.blurred', "The window is not focused, so the motif is parked on a static frame.") };
	}

	// Rule 5. Serious or critical heat, or any reported throttling, parks.
	if (inputs.thermal === 'serious' || inputs.thermal === 'critical') {
		return { mode: 'rest', fps: 0, state: 'parked', perpetual, reason: localize('primalCode.motif.reason.thermal', "The system is running hot, so the motif is parked until it cools.") };
	}
	if (inputs.speedLimit < SPEED_LIMIT_NOMINAL) {
		return { mode: 'rest', fps: 0, state: 'parked', perpetual, reason: localize('primalCode.motif.reason.speedLimit', "The system is throttling the processor, so the motif is parked.") };
	}

	// Rule 4. `unknown` is treated as `battery`: see MotifPowerSource.
	const onBattery = inputs.power !== 'mains';
	if (onBattery && !inputs.perpetualOnBattery) {
		return {
			mode: 'rest', fps: 0, state: 'parked', perpetual,
			reason: inputs.power === 'battery'
				? localize('primalCode.motif.reason.battery', "On battery power, so the motif stays static. Turn on 'Motif: Perpetual On Battery' to allow it at {0} frames per second.", PRIMAL_MOTIF_BATTERY_FPS)
				: localize('primalCode.motif.reason.unknownPower', "This platform does not report whether it is on battery, so the motif stays static. Turn on 'Motif: Perpetual On Battery' to allow it at {0} frames per second.", PRIMAL_MOTIF_BATTERY_FPS)
		};
	}

	// Rule 6. Input latency is the product; art is not.
	if (inputs.quietForMs < PRIMAL_MOTIF_INPUT_QUIET_MS) {
		return { mode: 'rest', fps: 0, state: 'parked', perpetual, reason: localize('primalCode.motif.reason.input', "Suppressed while you are typing.") };
	}

	// The self-imposed rung: a motif that cannot hold the main-thread budget gets
	// half the frames rather than the benefit of the doubt. It is the one rung
	// that runs and still owes the status bar a reason, because a reader who
	// sees 15 rather than 30 has to be able to find out why.
	const ceiling = onBattery ? PRIMAL_MOTIF_BATTERY_FPS : PRIMAL_MOTIF_MAX_FPS;
	if (inputs.overBudget) {
		const fps = Math.min(ceiling, PRIMAL_MOTIF_BATTERY_FPS);
		return { mode: 'run', fps, state: 'moving', perpetual, reason: localize('primalCode.motif.reason.overBudget', "'{0}' could not hold its frame budget where it is painting, so it runs at {1} frames per second there for the rest of this session. Another motif, or this one elsewhere, is not affected.", inputs.motifId, fps) };
	}

	return { mode: 'run', fps: ceiling, state: 'moving', perpetual, reason: undefined };
};
