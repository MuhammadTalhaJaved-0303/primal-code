#!/usr/bin/env node --experimental-strip-types
/**
 * Write latest.json, the manifest the in-app update notifier reads.
 *
 * Someone who installs today is frozen on that build unless something tells
 * them otherwise, so the app polls a manifest in the public downloads repo
 * (primal/design/update-notifier-spec.md). Every field in it is a claim made
 * to every user at once: get the commit wrong and we either nag people who
 * are already current or stay silent for everyone who is not.
 *
 * So the manifest is generated from state that already exists rather than
 * typed by hand. version, commit and date are read out of the *built* app's
 * product.json — the same file a running Primal Code reads its own identity
 * from, which is the only thing that makes the comparison on the client
 * meaningful. Commit, not version, is the identity: we rebuild 1.135.0 over
 * and over and semver cannot tell two of those builds apart.
 *
 *   node --experimental-strip-types primal/publish-latest.ts \
 *     --release=ide-v1.135.1 --name="Vibes and the new chrome"
 *
 * Anything missing, malformed or merely suspicious is a hard failure. A
 * manifest with a guessed field is worse than no manifest at all: it tells
 * every user a wrong thing, and it does so quietly.
 *
 * Two claims in particular are never taken on faith, because both fail
 * quietly and both hit every user at once:
 *
 *   - that the built app came from this source tree. The build directory lives
 *     outside the worktree and survives rebuilds, so --app happily resolves to
 *     a month-old app. HEAD is read straight out of .git with node:fs (no
 *     subprocess) and has to equal the built commit, and the build has to be
 *     recent; --allow-stale-build is how you say otherwise on purpose.
 *   - that the release assets exist under the names below. Those names are an
 *     upload contract that nothing in this repo enforces — make-dmg.sh emits
 *     primal-code-<version>-macos-<arch>.dmg, and the Windows workflow uploads
 *     whatever gulp produced — so every URL is fetched before it is published.
 *     --no-verify-assets skips the network; --asset-<platform>=<name> corrects
 *     a name without editing this file.
 *
 * That check is the only thing here that touches the network, and it runs on
 * this machine, not on a user's: the client's no-identifiers rule governs the
 * update check, not an operator tool. Uploading the manifest is still the
 * integrator's separate, deliberate step.
 *
 * --check regenerates the manifest and diffs it against the file at --out
 * instead of writing, exiting non-zero on any difference. To check what is
 * actually published, download it first and point --out at the copy.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_APP = join(
	ROOT,
	"..",
	"VSCode-darwin-arm64",
	"Primal Code.app",
	"Contents",
	"Resources",
	"app",
	"product.json"
);
const DEFAULT_REPO = "MuhammadTalhaJaved-0303/primal-code-downloads";
const DEFAULT_OUT = "latest.json";

/** Releases and their assets are served from here and nowhere else. */
const RELEASE_HOST = "github.com";

/**
 * The names the release assets are expected to be uploaded under. Nothing on
 * this machine produces them: make-dmg.sh emits
 * primal-code-<version>-macos-arm64.dmg and the Windows workflow uploads what
 * gulp named, so both are renamed by hand on upload. That makes these defaults
 * rather than facts — --asset-<key>=<name> overrides one, and the reachability
 * check is what turns the guess into something known before it is published.
 *
 * Keys are the client's platform-arch pair. A platform with no entry gets no
 * Download button rather than a wrong one, so leaving one out here is a safe,
 * deliberate choice. Every key needs a matching --asset-<key> option below;
 * adding a row without one is a hard failure rather than a silent gap.
 */
interface ReleaseAsset {
	readonly key: string;
	readonly asset: string;
}

const ASSETS: readonly ReleaseAsset[] = [
	{ key: "darwin-arm64", asset: "PrimalCode-macos-arm64.dmg" },
	{ key: "win32-x64", asset: "PrimalCode-Setup-Windows-x64.exe" },
];

/** What an installer for each platform family has to look like. */
const INSTALLER_SUFFIX: Readonly<Record<string, string>> = {
	darwin: ".dmg",
	win32: ".exe",
};

const PLATFORM_KEY = /^(?:darwin|win32|linux)-(?:x64|arm64)$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
/**
 * The client drops a name containing any of these rather than rejecting the
 * manifest (primalUpdateManifest.ts UNSAFE_DISPLAY_PATTERN), because
 * notification text is run through parseLinkedText and these characters could
 * fabricate a link. Publishing such a name "succeeds" and then silently loses
 * it, so reject it here where the publisher can still see why.
 */
const UNSAFE_DISPLAY = /[[\]()<>`\\]/;

/** The name rides in a single-line notification title. */
const MAX_NAME_LENGTH = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old the build may be before publishing it looks like an accident rather
 * than a decision. The build directory outlives any one build, so a stale app
 * sitting in it is the machine's normal state, not an unusual one.
 */
const MAX_BUILD_AGE_MS = 7 * DAY_MS;

/** Long enough for a cold CDN, short enough that a wedged host is not a hang. */
const ASSET_PROBE_TIMEOUT_MS = 20_000;

const USAGE = `Usage: node --experimental-strip-types primal/publish-latest.ts --release=<tag> --name=<text> [options]

  --release=<tag>      Release tag the assets hang off, e.g. ide-v1.135.1   (required)
  --name=<text>        Short release name shown in the notification         (required)
  --app=<path>         Built app's product.json, its .app bundle, or the folder holding it
                       (default: ${DEFAULT_APP})
  --repo=<owner/name>  Downloads repo hosting the release
                       (default: ${DEFAULT_REPO})
  --out=<path>         Where to write the manifest, resolved against the cwd
                       (default: ${DEFAULT_OUT})
  --check              Diff the file at --out against the current build; write nothing
  --asset-<key>=<name> Real name of one uploaded asset, overriding the default
${ASSETS.map(({ key, asset }) => `                       --asset-${key}=${asset}`).join("\n")}
  --no-verify-assets   Do not fetch the release links to confirm they resolve
  --allow-stale-build  Publish even though the build is not this worktree's HEAD
  --help               Show this message`;

const fail = (message: string): never => {
	console.error(`publish-latest: ${message}`);
	return process.exit(1);
};

const failWith = (headline: string, problems: readonly string[]): never => {
	console.error(`publish-latest: ${headline}`);
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	return process.exit(1);
};

const readJson = (path: string, label: string): Record<string, unknown> => {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		return fail(`cannot read ${label} at ${path}: ${(err as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return fail(`${label} at ${path} is not valid JSON: ${(err as Error).message}`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail(`${label} at ${path} is not a JSON object`);
	}
	return parsed as Record<string, unknown>;
};

const requireString = (source: Record<string, unknown>, field: string, where: string): string => {
	const value = source[field];
	if (typeof value !== "string" || value.trim() === "") {
		return fail(`${where} has no usable "${field}" (found ${JSON.stringify(value) ?? "undefined"})`);
	}
	return value;
};

/**
 * Accept the product.json itself, the .app bundle, or the Resources/app
 * directory. All three are things a person reasonably has to hand, and
 * guessing wrong would otherwise surface as an unhelpful "cannot read".
 */
const resolveProductPath = (input: string): string => {
	const path = resolve(process.cwd(), input);
	if (!existsSync(path)) {
		return fail(`no built app at ${path} — build one first (npm run gulp vscode-darwin-arm64-min) or pass --app`);
	}
	if (statSync(path).isFile()) {
		return path;
	}

	const candidates = [
		join(path, "product.json"),
		join(path, "Contents", "Resources", "app", "product.json"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found === undefined) {
		return failWith(`${path} holds no product.json; looked at`, candidates);
	}
	return found;
};

interface BuildIdentity {
	readonly version: string;
	readonly commit: string;
	readonly date: string;
}

const readBuildIdentity = (productPath: string): BuildIdentity => {
	const product = readJson(productPath, "the built app's product.json");

	// The build injects commit and date; a source-tree product.json has
	// neither. Saying so beats a vague "missing field", because the likeliest
	// way to get here is pointing --app at the repo's own product.json.
	if (!("commit" in product) || !("date" in product)) {
		fail(`${productPath} carries no commit/date, so it is a source-tree product.json rather than a packaged build's`);
	}

	// Guard against reading some *other* editor's product.json: a stray VS
	// Code install would hand us Microsoft's commit, and we would publish it.
	const repoProduct = readJson(join(ROOT, "product.json"), "the repo's product.json");
	const expectedName = requireString(repoProduct, "nameLong", "the repo's product.json");
	const builtName = requireString(product, "nameLong", productPath);
	if (builtName !== expectedName) {
		fail(`${productPath} belongs to "${builtName}", not "${expectedName}" — --app points at the wrong application`);
	}

	const version = requireString(product, "version", productPath);
	if (!SEMVER.test(version)) {
		fail(`the build's version "${version}" is not a version number`);
	}

	const commit = requireString(product, "commit", productPath);
	if (!SHA1_HEX.test(commit)) {
		fail(`the build's commit "${commit}" is not a 40-character hex sha; the client compares it verbatim against product.commit`);
	}

	const date = requireString(product, "date", productPath);
	if (!Number.isFinite(Date.parse(date))) {
		fail(`the build's date "${date}" is not a parseable date`);
	}

	return { version, commit, date };
};

/**
 * Where this checkout keeps its git metadata. A plain clone has a .git
 * directory; a linked worktree — which is how this branch is checked out — has
 * a .git *file* holding "gitdir: <path>". Handling only the first shape would
 * make the provenance gate useless from exactly the place the work happens,
 * which is the same as not having one.
 */
const resolveGitDir = (root: string): string | undefined => {
	const dotGit = join(root, ".git");

	let isDirectory: boolean;
	try {
		isDirectory = statSync(dotGit).isDirectory();
	} catch {
		return undefined;
	}
	if (isDirectory) {
		return dotGit;
	}

	let pointer: string;
	try {
		pointer = readFileSync(dotGit, "utf8").trim();
	} catch {
		return undefined;
	}
	const match = /^gitdir:\s*(.+)$/.exec(pointer);
	return match === null ? undefined : resolve(root, match[1].trim());
};

/**
 * Branch refs live in the shared git directory rather than in a linked
 * worktree's own, so resolving HEAD means being ready to look in both.
 */
const resolveGitCommonDir = (gitDir: string): string => {
	try {
		const commonDir = readFileSync(join(gitDir, "commondir"), "utf8").trim();
		return commonDir === "" ? gitDir : resolve(gitDir, commonDir);
	} catch {
		return gitDir;
	}
};

const readLooseRef = (gitDir: string, ref: string): string | undefined => {
	try {
		const value = readFileSync(join(gitDir, ref), "utf8").trim();
		return SHA1_HEX.test(value) ? value : undefined;
	} catch {
		return undefined;
	}
};

/** packed-refs holds "<sha> <ref>" lines; peeled tags start with ^ and never match. */
const PACKED_REF = /^([0-9a-f]{40})\s+(\S+)$/;

const readPackedRef = (gitDir: string, ref: string): string | undefined => {
	let raw: string;
	try {
		raw = readFileSync(join(gitDir, "packed-refs"), "utf8");
	} catch {
		return undefined;
	}

	for (const line of raw.split("\n")) {
		const match = PACKED_REF.exec(line.trim());
		if (match !== null && match[2] === ref) {
			return match[1];
		}
	}
	return undefined;
};

interface GitHead {
	readonly commit: string;
	/** Which ref HEAD was on, for an error message that names something real. */
	readonly where: string;
}

/**
 * This worktree's HEAD, read with node:fs rather than by shelling out — the
 * same few files build/lib/git.ts reads to stamp product.commit in the first
 * place, which is what makes comparing the two mean anything.
 */
const readGitHead = (root: string): GitHead | { readonly problem: string } => {
	const gitDir = resolveGitDir(root);
	if (gitDir === undefined) {
		return { problem: `no readable .git at ${join(root, ".git")}` };
	}

	let head: string;
	try {
		head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
	} catch (err) {
		return { problem: `cannot read ${join(gitDir, "HEAD")}: ${(err as Error).message}` };
	}

	if (SHA1_HEX.test(head)) {
		return { commit: head, where: "a detached HEAD" };
	}

	const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
	if (ref === undefined) {
		return { problem: `HEAD in ${gitDir} is neither a sha nor a ref: "${head}"` };
	}

	const commonDir = resolveGitCommonDir(gitDir);
	const commit = readLooseRef(gitDir, ref)
		?? readLooseRef(commonDir, ref)
		?? readPackedRef(commonDir, ref)
		?? readPackedRef(gitDir, ref);

	return commit === undefined
		? { problem: `HEAD is ${ref}, which resolves to no sha under ${gitDir}${commonDir === gitDir ? "" : ` or ${commonDir}`}` }
		: { commit, where: ref };
};

/**
 * Tie the built app to this source tree before anything is assembled from it.
 *
 * Every check above proves the built product.json is well formed, and none of
 * them proves it came from here: --app resolves to a build directory outside
 * the worktree that keeps whatever was last built into it. A build from
 * another branch, or from a month ago, satisfies all of them and then nags
 * every user who already has the real build, forever, because the commit it
 * publishes is one they will never be running.
 */
const assertBuildIsCurrent = (build: BuildIdentity, allowStale: boolean): void => {
	const head = readGitHead(ROOT);
	const provenance = "problem" in head
		? [`cannot tell what this worktree is at, so the build's origin is unprovable: ${head.problem}`]
		: head.commit === build.commit
			? []
			: [`the built app is commit ${build.commit}, but this worktree is at ${head.commit} (${head.where}) — rebuild, or point --app at the build of this commit`];

	const age = Date.now() - Date.parse(build.date);
	const freshness = age > MAX_BUILD_AGE_MS
		? [`the build is ${Math.floor(age / DAY_MS)} days old (built ${build.date}), and the build directory keeps old apps around long after they stop being what ships`]
		: [];

	const problems = [...provenance, ...freshness];
	if (problems.length === 0) {
		return;
	}

	if (!allowStale) {
		failWith("refusing to describe a build that is not this source tree (--allow-stale-build publishes it anyway):", problems);
	}

	console.warn("publish-latest: --allow-stale-build given; publishing a build that is not this source tree:");
	for (const problem of problems) {
		console.warn(`  - ${problem}`);
	}
};

const parseUrl = (label: string, url: string): URL => {
	try {
		return new URL(url);
	} catch {
		return fail(`${label} is not a well-formed URL: ${url}`);
	}
};

/**
 * Every URL we are about to hand to IOpenerService, checked for shape. We
 * cannot prove the asset is there without the network, but we can prove the
 * link is the link we meant to build.
 */
const assertPublishableUrl = (label: string, url: string, tail: string): void => {
	const parsed = parseUrl(label, url);
	if (parsed.protocol !== "https:") {
		fail(`${label} is not https: ${url}`);
	}
	if (parsed.hostname !== RELEASE_HOST) {
		fail(`${label} does not point at ${RELEASE_HOST}: ${url}`);
	}
	// A query string or fragment is meaningless on a release link and is
	// exactly where an identifier would hide. The update path sends nothing.
	if (parsed.search !== "" || parsed.hash !== "") {
		fail(`${label} carries a query string or fragment: ${url}`);
	}
	// If parsing rewrote anything, some segment holds a character that has to
	// be escaped, and the string we would publish is not the string we built.
	if (parsed.href !== url || encodeURI(url) !== url) {
		fail(`${label} does not survive a round trip through URL parsing, so a segment needs escaping: ${url}`);
	}
	if (!parsed.pathname.endsWith(`/${tail}`)) {
		fail(`${label} does not end in "${tail}": ${url}`);
	}
};

const notesUrlFor = (repo: string, tag: string): string =>
	`https://${RELEASE_HOST}/${repo}/releases/tag/${tag}`;

const downloadUrlFor = (repo: string, tag: string, asset: string): string =>
	`https://${RELEASE_HOST}/${repo}/releases/download/${tag}/${asset}`;

/**
 * `overrides` carries one entry per --asset-<key> option the command line
 * declares, whether or not it was passed, so a row added to ASSETS without a
 * matching option fails here instead of quietly being uncorrectable.
 */
const buildDownloads = (
	repo: string,
	tag: string,
	overrides: ReadonlyMap<string, string | undefined>
): Readonly<Record<string, string>> =>
	Object.fromEntries(
		ASSETS.map(({ key, asset: fallback }) => {
			if (!PLATFORM_KEY.test(key)) {
				fail(`the asset table has an unusable platform key "${key}"; the client looks the map up by platform and arch`);
			}
			if (!overrides.has(key)) {
				fail(`the asset table has platform "${key}" but no --asset-${key} option is declared, so its name cannot be corrected without editing this file`);
			}

			const override = overrides.get(key)?.trim();
			if (override === "") {
				fail(`--asset-${key} is empty; give the asset's real file name or leave the flag off`);
			}
			const asset = override ?? fallback;

			const family = key.slice(0, key.indexOf("-"));
			const suffix = INSTALLER_SUFFIX[family] ?? fail(`the asset table names platform "${family}", which has no known installer format`);
			if (!ASSET_NAME.test(asset) || !asset.endsWith(suffix)) {
				fail(`asset "${asset}" is not a plausible ${family} installer; expected a plain file name ending in ${suffix}`);
			}

			const url = downloadUrlFor(repo, tag, asset);
			assertPublishableUrl(`downloads.${key}`, url, asset);
			return [key, url];
		})
	);

/**
 * Ask whether a link resolves. Shape checks prove it is the link we meant to
 * build; only a request proves there is anything behind it, and the asset
 * names are a convention nothing in this repo produces. Returns the reason it
 * failed, or undefined when it is there.
 */
const probeUrl = async (url: string): Promise<string | undefined> => {
	const request = async (method: "HEAD" | "GET"): Promise<Response> => {
		const response = await fetch(url, {
			method,
			redirect: "follow",
			signal: AbortSignal.timeout(ASSET_PROBE_TIMEOUT_MS),
		});
		// Nothing here wants the bytes, and an unread body holds the socket open.
		await response.body?.cancel().catch(() => undefined);
		return response;
	};

	try {
		const head = await request("HEAD");
		// A 404 is an answer, so it stands. Anything else unhappy may be a host
		// that signs its redirect for GET only, which earns one retry.
		const response = head.ok || head.status === 404 ? head : await request("GET");
		return response.ok
			? undefined
			: `HTTP ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`}`;
	} catch (err) {
		return (err as Error).message;
	}
};

const verifyReachable = async (targets: Readonly<Record<string, string>>): Promise<void> => {
	console.log(`checking ${Object.keys(targets).length} release links`);

	const checked = await Promise.all(
		Object.entries(targets).map(async ([label, url]) => ({ label, url, problem: await probeUrl(url) }))
	);

	const problems = checked.flatMap(({ label, url, problem }) =>
		problem === undefined ? [] : [`${label}: ${problem} — ${url}`]
	);
	if (problems.length > 0) {
		failWith(
			"these links do not resolve, so the manifest would point users at nothing (a 404 means the tag or the asset is not uploaded yet, or the repo is private; --asset-<key>= corrects a name, --no-verify-assets skips the check):",
			problems
		);
	}

	for (const { label } of checked) {
		console.log(`  reachable    ${label}`);
	}
};

interface Manifest {
	readonly version: string;
	readonly commit: string;
	readonly date: string;
	readonly name: string;
	readonly notesUrl: string;
	readonly downloads: Readonly<Record<string, string>>;
}

/**
 * The last gate before the file is written: re-check the assembled manifest
 * against exactly what the client validates, so no field can go out empty or
 * mistyped because some path above forgot to look at it.
 */
const validateManifest = (manifest: Manifest): readonly string[] => {
	const required = ["version", "commit", "date", "name", "notesUrl"] as const;
	const missing = required
		.filter((field) => typeof manifest[field] !== "string" || manifest[field].trim() === "")
		.map((field) => `${field} is empty`);

	const shape = [
		SHA1_HEX.test(manifest.commit) ? undefined : `commit "${manifest.commit}" is not a 40-character hex sha`,
		manifest.notesUrl.startsWith("https://") ? undefined : `notesUrl "${manifest.notesUrl}" is not https`,
	].filter((problem): problem is string => problem !== undefined);

	const entries = Object.entries(manifest.downloads ?? {});
	const downloads = entries.flatMap(([key, url]) => [
		PLATFORM_KEY.test(key) ? undefined : `downloads has the unrecognised platform key "${key}"`,
		typeof url === "string" && url.startsWith("https://") ? undefined : `downloads.${key} is not an https URL`,
	]).filter((problem): problem is string => problem !== undefined);

	const empty = entries.length === 0
		? ["downloads is empty, so the notification would have no Download button on any platform"]
		: [];

	return [...missing, ...shape, ...empty, ...downloads];
};

/** Flatten to leaf paths so a diff can name the field that moved. */
const flatten = (value: unknown, path = ""): readonly (readonly [string, string])[] =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.entries(value).flatMap(([key, child]) => flatten(child, path === "" ? key : `${path}.${key}`))
		: [[path, JSON.stringify(value) ?? "undefined"]];

const differences = (expected: Manifest, actual: Record<string, unknown>): readonly string[] => {
	const want = new Map(flatten(expected));
	const have = new Map(flatten(actual));
	const paths = [...new Set([...want.keys(), ...have.keys()])].sort();

	return paths.flatMap((path) => {
		const wanted = want.get(path);
		const found = have.get(path);
		if (wanted === found) {
			return [];
		}
		if (wanted === undefined) {
			return [`${path}: the file has ${found}, the build has no such field`];
		}
		if (found === undefined) {
			return [`${path}: missing from the file, should be ${wanted}`];
		}
		return [`${path}: the file has ${found}, this build says ${wanted}`];
	});
};

const parseCommandLine = () => {
	try {
		return parseArgs({
			options: {
				release: { type: "string" },
				name: { type: "string" },
				app: { type: "string", default: DEFAULT_APP },
				repo: { type: "string", default: DEFAULT_REPO },
				out: { type: "string", default: DEFAULT_OUT },
				check: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
				// node:util has no --no-<flag> negation, so the off switch is its
				// own option. One per ASSETS row, spelled out rather than
				// generated, so the values stay typed and a new row that forgets
				// one is caught in buildDownloads.
				"no-verify-assets": { type: "boolean", default: false },
				"allow-stale-build": { type: "boolean", default: false },
				"asset-darwin-arm64": { type: "string" },
				"asset-win32-x64": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		}).values;
	} catch (err) {
		// Strict parsing on purpose: a typo in --repo would otherwise fall back
		// to the default and publish confidently wrong download URLs.
		console.error(`publish-latest: ${(err as Error).message}`);
		console.error(`\n${USAGE}`);
		return process.exit(1);
	}
};

const args = parseCommandLine();

if (args.help) {
	console.log(USAGE);
	process.exit(0);
}

const release = (args.release ?? "").trim();
if (release === "") {
	fail(`--release is required, e.g. --release=ide-v1.135.1\n\n${USAGE}`);
}
// Deliberately not checked against the build's version: the release train and
// the version move independently, which is the whole reason commit is the
// identity. 1.135.0 shipping as ide-v1.135.1 is normal, not a mistake.
if (!TAG_NAME.test(release)) {
	fail(`release tag "${release}" has characters that would need escaping in a URL; use letters, digits, dot, dash and underscore`);
}

const name = (args.name ?? "").trim();
if (name === "") {
	fail(`--name is required, e.g. --name="Vibes and the new chrome"\n\n${USAGE}`);
}
if (name.length > MAX_NAME_LENGTH) {
	fail(`--name is ${name.length} characters; keep it under ${MAX_NAME_LENGTH} so it fits the notification`);
}
if (CONTROL_CHARS.test(name)) {
	fail("--name contains control characters or line breaks");
}
if (UNSAFE_DISPLAY.test(name)) {
	fail("--name contains one of [ ] ( ) < > ` or a backslash; the client strips names containing those, so it would be published and then silently dropped");
}

const repo = (args.repo ?? DEFAULT_REPO).trim();
if (!REPO_NAME.test(repo)) {
	fail(`--repo must be "owner/name", got "${repo}"`);
}

const outPath = resolve(process.cwd(), args.out ?? DEFAULT_OUT);
const build = readBuildIdentity(resolveProductPath(args.app ?? DEFAULT_APP));
assertBuildIsCurrent(build, args["allow-stale-build"] === true);

const notesUrl = notesUrlFor(repo, release);
assertPublishableUrl("notesUrl", notesUrl, release);

/**
 * Every platform the table names, present whether or not the operator passed
 * the flag: buildDownloads uses the difference between "declared but unset"
 * and "not declared at all" to catch a table row nobody can correct.
 */
const assetOverrides: ReadonlyMap<string, string | undefined> = new Map([
	["darwin-arm64", args["asset-darwin-arm64"]],
	["win32-x64", args["asset-win32-x64"]],
]);

const manifest: Manifest = {
	version: build.version,
	commit: build.commit,
	date: build.date,
	name,
	notesUrl,
	downloads: buildDownloads(repo, release, assetOverrides),
};

const problems = validateManifest(manifest);
if (problems.length > 0) {
	failWith("refusing to emit a manifest that does not validate:", problems);
}

/** Everything a notification can open, labelled the way the manifest is. */
const publishedLinks: Readonly<Record<string, string>> = {
	notesUrl: manifest.notesUrl,
	...Object.fromEntries(
		Object.entries(manifest.downloads).map(([key, url]) => [`downloads.${key}`, url])
	),
};

// Before the diff as well as before the write: --check answers "does the
// published manifest describe this build", and a link that 404s makes that a
// no however well the fields line up.
if (args["no-verify-assets"] === true) {
	console.warn("publish-latest: --no-verify-assets given; the release links go out unchecked");
} else {
	await verifyReachable(publishedLinks);
}

if (args.check) {
	if (!existsSync(outPath)) {
		fail(`--check: no manifest at ${outPath}`);
	}
	const diffs = differences(manifest, readJson(outPath, "the manifest"));
	if (diffs.length > 0) {
		failWith(`--check FAILED, ${outPath} does not describe this build (${diffs.length}):`, diffs);
	}
	console.log(`publish-latest --check passed: ${outPath} matches build ${manifest.commit.slice(0, 10)}`);
	process.exit(0);
}

try {
	writeFileSync(outPath, `${JSON.stringify(manifest, null, "\t")}\n`);
} catch (err) {
	fail(`cannot write ${outPath}: ${(err as Error).message}`);
}

console.log(`wrote ${outPath}`);
console.log(`  version      ${manifest.version}`);
console.log(`  commit       ${manifest.commit}`);
console.log(`  date         ${manifest.date}`);
console.log(`  name         ${manifest.name}`);
console.log(`  notes        ${manifest.notesUrl}`);
for (const [key, url] of Object.entries(manifest.downloads)) {
	console.log(`  ${key.padEnd(12)} ${url}`);
}

// Only reachable under --allow-stale-build: a build that is this worktree's
// HEAD was built from this very package.json, so the two agree by definition.
const worktreeVersion = requireString(readJson(join(ROOT, "package.json"), "the repo's package.json"), "version", "the repo's package.json");
if (worktreeVersion !== manifest.version) {
	console.log(`\nnote: this worktree is at ${worktreeVersion} but the published build is ${manifest.version}`);
}

console.log(`\nNext: publish this file as latest.json on the main branch of ${repo}.`);
