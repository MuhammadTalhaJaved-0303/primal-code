/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPrimalVibe } from '../../primalVibes/browser/primalVibes.js';

/** Vibe labels are product names ('Primal Ink'); the page shows the short half. */
const VIBE_LABEL_PREFIX = 'Primal ';

/** The vibe's short name as the Start page shows it: 'Basalt' for 'Primal Basalt'. */
export function shortVibeName(vibe: IPrimalVibe): string {
	return vibe.label.startsWith(VIBE_LABEL_PREFIX) ? vibe.label.substring(VIBE_LABEL_PREFIX.length) : vibe.label;
}
