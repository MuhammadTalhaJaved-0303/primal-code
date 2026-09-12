/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Primal Code - every motif that ships, in one list.
 *
 * A motif registers itself as a side effect of being imported (`registerMotif`
 * in `../primalMotif.js`), so what is imported IS what the product offers: the
 * `primalCode.motif.id` enum is generated from the registry, and nothing else in
 * the workbench names a motif.
 *
 * The list is here rather than in `primalMotif.contribution.ts` because the
 * tests need exactly the same set. `test/browser/motifRegistry.test.ts` and
 * `test/browser/motifBudget.test.ts` are written over `getMotifDescriptors()`
 * and import this file, so every rule they enforce - one ink and no hue, a label
 * and a description, a measured frame cost - is enforced against the shipping
 * set rather than against a list somebody remembered to extend. A motif that is
 * added here is tested; a motif that is not added here does not exist.
 *
 * `static` is not in this list: it is registered by `../primalMotif.js` itself,
 * because the contract file is where the default has to be true even if no motif
 * file is ever imported.
 */

import './globe.js';
import './starfield.js';
import './contours.js';
import './orbit.js';
import './horizon.js';
