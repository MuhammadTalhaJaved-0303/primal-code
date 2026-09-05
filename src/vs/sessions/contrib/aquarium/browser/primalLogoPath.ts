/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Primal Code mark as a silhouette path in a 96x96 box — the same P that
// is the app icon (primal/icon.svg). The aquarium renders each fish as live,
// same-document SVG geometry: fish.ts stores this path in a shared <symbol>,
// then renders clipped <use> slices with staggered CSS animations. That keeps
// the swimming-strip effect, currentColor species tinting, and auxiliary-window
// support while avoiding duplicate path parsing per fish.
export const PRIMAL_LOGO_PATH = 'M22 22Q22 14 30 14L52 14A24 24 0 0 1 52 62L38 62L38 74Q38 82 30 82Q22 82 22 74ZM44 48L64 38L44 28Z';
