/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { arch, platform } from '../../../../base/common/process.js';

/**
 * `platform` and `arch` come from `vs/base/common/process`, which reads the
 * sandboxed `vscode.process` globals in the renderer and falls back to `undefined`
 * for `arch` on web. `emergencyAlert.contribution.ts` matches its payloads against
 * the exact same pair, and the resulting `<platform>-<arch>` spelling is the one
 * `getTargetPlatform` in `platform/extensionManagement/common/extensionManagement.ts`
 * uses for extension assets.
 */
const SUPPORTED_PLATFORMS: readonly string[] = ['darwin', 'win32', 'linux'];

const SUPPORTED_ARCHITECTURES: readonly string[] = ['x64', 'arm64'];

/**
 * The `downloads` key of the running app, e.g. `darwin-arm64`, or `undefined`
 * when this runtime cannot be named with confidence (web, or an architecture we
 * do not publish for). Callers must omit the download affordance in that case
 * rather than fall back to some other platform's installer.
 */
export const getPrimalDownloadPlatformKey = (): string | undefined => {
	if (!SUPPORTED_PLATFORMS.includes(platform)) {
		return undefined;
	}

	if (!arch || !SUPPORTED_ARCHITECTURES.includes(arch)) {
		return undefined;
	}

	return `${platform}-${arch}`;
};
