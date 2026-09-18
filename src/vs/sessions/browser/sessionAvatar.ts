/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { StringSHA1 } from '../../base/common/hash.js';
import { localize } from '../../nls.js';
import { SessionStatus } from '../services/sessions/common/session.js';

/**
 * Primal Code - a small face for a session row.
 *
 * The reference the owner pointed at (Grok's session list) gives each chat a
 * bright coloured blob that bounces while it works. The idea is right: a row
 * should have a face, and the face should show what the session is doing. The
 * colour is not - the product is for a colour-blind reader, so meaning here is
 * carried by SHAPE and MOTION, in one ink, and the state is also written into
 * the label so a screen reader gets it too.
 *
 * The FACE is the session's identity: a hash of its resource picks the eyes,
 * their spacing, the mouth and a brow, so the same session always wears the
 * same face and two rows are told apart at a glance without reading a word. It
 * is drawn once.
 *
 * The EXPRESSION is the session's state, and it changes in place on the one
 * element: working blinks and bobs, waiting tilts and raises a brow, done
 * settles into a smile, failed into a flat mouth. Every motion is CSS keyed on
 * a `mood-*` class and switched off by a `still` class under reduced motion, so
 * the row costs nothing to keep on screen and stops moving when it should.
 */

export const SESSION_AVATAR_CLASS = 'session-avatar';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The parts of a face, each a small enum so a hash can pick one of each. */
export interface ISessionAvatarFeatures {
	readonly eyes: 'dot' | 'round' | 'line';
	readonly gap: 'near' | 'far';
	readonly mouth: 'flat' | 'open' | 'curve';
	readonly brow: 'none' | 'raised';
}

export type SessionAvatarMood = 'ready' | 'working' | 'waiting' | 'done' | 'failed';

export interface ISessionAvatarExpression {
	readonly mood: SessionAvatarMood;
	readonly unread: boolean;
	readonly archived: boolean;
}

const EYES: ISessionAvatarFeatures['eyes'][] = ['dot', 'round', 'line'];
const GAPS: ISessionAvatarFeatures['gap'][] = ['near', 'far'];
const MOUTHS: ISessionAvatarFeatures['mouth'][] = ['flat', 'open', 'curve'];
const BROWS: ISessionAvatarFeatures['brow'][] = ['none', 'raised'];

/**
 * A stable face for a session resource. A SHA-1 of the resource gives four
 * independent indices, one per feature, so the choice is deterministic and
 * spread rather than clustered on the first few bytes.
 */
export function avatarFeaturesFor(sessionResource: string): ISessionAvatarFeatures {
	const hash = new StringSHA1();
	hash.update(sessionResource);
	const digest = hash.digest();
	const at = (offset: number) => parseInt(digest.slice(offset, offset + 4), 16);

	return {
		eyes: EYES[at(0) % EYES.length],
		gap: GAPS[at(4) % GAPS.length],
		mouth: MOUTHS[at(8) % MOUTHS.length],
		brow: BROWS[at(12) % BROWS.length],
	};
}

/** The mood for a status. Independent of the face, and written in one word. */
export function avatarExpressionFor(status: SessionStatus, isRead: boolean, isArchived: boolean): ISessionAvatarExpression {
	return { mood: moodFor(status), unread: !isRead, archived: isArchived };
}

function moodFor(status: SessionStatus): SessionAvatarMood {
	switch (status) {
		case SessionStatus.Untitled: return 'ready';
		case SessionStatus.InProgress: return 'working';
		case SessionStatus.NeedsInput: return 'waiting';
		case SessionStatus.Completed: return 'done';
		case SessionStatus.Error: return 'failed';
	}
}

const MOOD_LABEL: Readonly<Record<SessionAvatarMood, string>> = {
	ready: localize('sessionAvatar.ready', "Ready"),
	working: localize('sessionAvatar.working', "Working"),
	waiting: localize('sessionAvatar.waiting', "Waiting for you"),
	done: localize('sessionAvatar.done', "Done"),
	failed: localize('sessionAvatar.failed', "Failed"),
};

export class SessionAvatar extends Disposable {

	private readonly svg: SVGSVGElement;
	private mood: SessionAvatarMood | undefined;

	constructor(container: HTMLElement, features: ISessionAvatarFeatures) {
		super();

		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('aria-hidden', 'false');
		svg.setAttribute('role', 'img');
		svg.classList.add(SESSION_AVATAR_CLASS, `eyes-${features.eyes}`, `gap-${features.gap}`, `mouth-${features.mouth}`, `brow-${features.brow}`);

		// One head, two eyes, a brow and a mouth. The stylesheet decides which of
		// each is shown from the feature and mood classes, so the geometry lives
		// there and the DOM is the same for every face.
		svg.append(
			shape('circle', { class: 'avatar-head', cx: '12', cy: '12', r: '10' }),
			shape('circle', { class: 'avatar-eye avatar-eye-left', cx: '9', cy: '11', r: '1.4' }),
			shape('circle', { class: 'avatar-eye avatar-eye-right', cx: '15', cy: '11', r: '1.4' }),
			shape('path', { class: 'avatar-brow avatar-brow-left', d: 'M7.4 8.3 Q9 7.4 10.6 8.3' }),
			shape('path', { class: 'avatar-brow avatar-brow-right', d: 'M13.4 8.3 Q15 7.4 16.6 8.3' }),
			shape('path', { class: 'avatar-mouth', d: 'M9 15.5 Q12 17 15 15.5' }),
		);

		container.classList.add('has-session-avatar');
		container.appendChild(svg);
		this.svg = svg;
		this._register({ dispose: () => svg.remove() });
	}

	/** Move the expression to `expression`; the face never changes. */
	update(expression: ISessionAvatarExpression, reducedMotion: boolean): void {
		if (this.mood !== undefined) {
			this.svg.classList.remove(`mood-${this.mood}`);
		}
		this.mood = expression.mood;
		this.svg.classList.add(`mood-${expression.mood}`);
		this.svg.classList.toggle('unread', expression.unread);
		this.svg.classList.toggle('archived', expression.archived);
		this.svg.classList.toggle('still', reducedMotion);
		this.svg.setAttribute('aria-label', MOOD_LABEL[expression.mood]);
	}
}

function shape(tag: 'circle' | 'path', attrs: Record<string, string>): SVGElement {
	const element = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attrs)) {
		element.setAttribute(name, value);
	}
	return element;
}

