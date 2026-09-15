/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { PRIMAL_HARNESS_PROVIDER_SETTING_ID, PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY, PRIMAL_PROVIDERS, providerSecretKey } from '../../../../platform/agentHost/common/primalProviders.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IPrimalMotifService } from '../../primalMotif/browser/primalMotif.js';
import { IPrimalVibeService } from '../../primalVibes/browser/primalVibes.js';
import { PRIMAL_WALLPAPER_DEFAULT_MODE, PRIMAL_WALLPAPER_MODE_SETTING_ID } from '../../primalWallpaper/browser/primalWallpaper.js';
import { IProblemReportInput, newestCrashReportName, ProblemReportCrashInfo, ProblemReportLogSource } from '../common/primalProblemReport.js';

/** Where macOS keeps crash reports, relative to the user's home. */
const DARWIN_CRASH_REPORT_SEGMENTS: readonly string[] = ['Library', 'Logs', 'DiagnosticReports'];

/** The main process log inside the current session's log folder. */
const MAIN_LOG_FILE_NAME = 'main.log';

/** Shown when the active colour theme has no settings id, which the theme service allows. */
const UNNAMED_THEME = 'unnamed theme';

/** Shown when the active colour theme belongs to no vibe. */
const CUSTOM_VIBE = 'custom';

function osName(): string {
	if (isMacintosh) {
		return 'macOS';
	}
	if (isWindows) {
		return 'Windows';
	}
	if (isLinux) {
		return 'Linux';
	}
	return 'unknown OS';
}

/**
 * Reads live workbench state into a {@link IProblemReportInput}. This is the
 * only impure half of the feature: it touches services and the disk, and it
 * never passes a secret value on -- provider keys are checked for presence
 * and reduced to the provider's id.
 */
export class PrimalProblemReportGatherer {

	constructor(
		@IProductService private readonly productService: IProductService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IPrimalVibeService private readonly vibeService: IPrimalVibeService,
		@IPrimalMotifService private readonly motifService: IPrimalMotifService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IFileService private readonly fileService: IFileService
	) { }

	async gather(): Promise<IProblemReportInput> {
		const [providerIds, mainLog, rendererLog, crashReport] = await Promise.all([
			this.configuredProviderIds(),
			this.readLog(joinPath(this.environmentService.logsHome, MAIN_LOG_FILE_NAME)),
			this.readLog(this.environmentService.logFile),
			this.newestCrashReport()
		]);

		return {
			product: {
				name: this.productService.nameShort,
				version: this.productService.version,
				commit: this.productService.commit,
				date: this.productService.date
			},
			os: {
				name: osName(),
				release: this.environmentService.os.release,
				arch: this.environmentService.os.arch,
				hostname: this.environmentService.os.hostname
			},
			colorTheme: this.themeService.getColorTheme().settingsId ?? UNNAMED_THEME,
			vibe: this.vibeService.currentVibe?.id ?? CUSTOM_VIBE,
			motif: { id: this.motifService.activeMotifId, motion: this.motifService.motion },
			wallpaperMode: this.configurationService.getValue<string>(PRIMAL_WALLPAPER_MODE_SETTING_ID) ?? PRIMAL_WALLPAPER_DEFAULT_MODE,
			providerIds,
			harnessProviderId: this.configurationService.getValue<string | undefined>(PRIMAL_HARNESS_PROVIDER_SETTING_ID) || undefined,
			mainLog,
			rendererLog,
			crashReport,
			homeDir: this.environmentService.userHome.fsPath
		};
	}

	/** Ids of providers with a saved key. The values are only tested for presence. */
	private async configuredProviderIds(): Promise<readonly string[]> {
		const checks = await Promise.all(PRIMAL_PROVIDERS.map(async provider => {
			const saved = await this.hasSecret(providerSecretKey(provider.id))
				|| (provider.id === 'anthropic' && await this.hasSecret(PRIMAL_LEGACY_ANTHROPIC_SECRET_KEY));
			return saved ? provider.id : undefined;
		}));
		return checks.filter((id): id is string => id !== undefined);
	}

	private async hasSecret(key: string): Promise<boolean> {
		try {
			return !!(await this.secretStorageService.get(key));
		} catch {
			// A locked or unavailable keychain means "not known", which the report
			// must not mistake for "configured".
			return false;
		}
	}

	private async readLog(resource: URI): Promise<ProblemReportLogSource> {
		try {
			const content = await this.fileService.readFile(resource);
			return { text: content.value.toString() };
		} catch (error) {
			return { error: toErrorMessage(error) };
		}
	}

	private async newestCrashReport(): Promise<ProblemReportCrashInfo> {
		if (!isMacintosh) {
			return { kind: 'skipped', reason: 'only checked on macOS' };
		}
		const folder = joinPath(this.environmentService.userHome, ...DARWIN_CRASH_REPORT_SEGMENTS);
		try {
			const stat = await this.fileService.resolve(folder, { resolveMetadata: true });
			const entries = (stat.children ?? []).filter(child => !child.isDirectory).map(child => ({ name: child.name, mtime: child.mtime }));
			const fileName = newestCrashReportName(entries, this.productService.nameShort);
			return fileName ? { kind: 'found', fileName } : { kind: 'none' };
		} catch (error) {
			return { kind: 'skipped', reason: `could not list ${DARWIN_CRASH_REPORT_SEGMENTS.join('/')}: ${toErrorMessage(error)}` };
		}
	}
}
