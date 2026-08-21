#!/usr/bin/env node
/**
 * Turn an upstream Code-OSS checkout into Primal Code.
 *
 * This is a transform, not a patch, and that is deliberate. Upstream rewrites
 * product.json every release, so a stored diff would conflict on every version
 * bump. Re-running this against a fresh checkout is always safe: it is
 * idempotent, and it fails loudly rather than silently half-applying.
 *
 *   node primal/rebrand.mjs [--check]
 *
 * --check verifies an already-rebranded tree and exits non-zero if anything
 * drifted. That is what CI runs.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");

/**
 * Install identifiers, generated once for Primal Code.
 *
 * These must never be Microsoft's. Inno Setup keys the install off AppId, so
 * reusing theirs would make our installer upgrade, or uninstall, a real VS Code
 * installation on the user's machine.
 */
const IDS = {
  win32x64AppId: "{{03058D30-4B25-43A0-AEC6-93CDB637B781}",
  win32arm64AppId: "{{C73EB537-63A1-4EE9-A19C-5EBE60136F78}",
  win32x64UserAppId: "{{55AD35D7-57FF-4185-A945-54CF6F4DFC13}",
  win32arm64UserAppId: "{{8ABA774D-381E-4AEC-A026-30D62C0DCEBD}",
  darwinProfileUUID: "12382272-4A6C-4355-B579-F525D4639225",
  darwinProfilePayloadUUID: "80AAF0CD-1D28-4DB1-BCA3-DC72FA3B7976",
};

const REPO = "https://github.com/MuhammadTalhaJaved-0303/primal-code";

/** Fields we set outright. */
const SET = {
  nameShort: "Primal Code",
  nameLong: "Primal Code",
  applicationName: "primal-code",
  dataFolderName: ".primal-code",
  sharedDataFolderName: ".primal-code-shared",
  serverApplicationName: "primal-code-server",
  serverDataFolderName: ".primal-code-server",
  tunnelApplicationName: "primal-code-tunnel",
  urlProtocol: "primal-code",
  linuxIconName: "primal-code",

  win32MutexName: "primalcode",
  win32DirName: "Primal Code",
  win32NameVersion: "Primal Code",
  win32RegValueName: "PrimalCode",
  win32AppUserModelId: "PrimalAI.PrimalCode",
  win32ShellNameShort: "P&rimal Code",
  win32TunnelServiceMutex: "primalcode-tunnelservice",
  win32TunnelMutex: "primalcode-tunnel",

  darwinBundleIdentifier: "ai.primal.code",

  // Must be an array, not absent: extensionsScannerService does an unguarded
  // `for...of` over it, so deleting the key made extension scanning throw
  // "is not iterable" and no extensions were listed. Empty is the correct
  // meaning here, since we ship no auto-updating built-ins.
  builtInExtensionsEnabledWithAutoUpdates: [] as string[],

  licenseUrl: `${REPO}/blob/main/LICENSE.txt`,
  serverLicenseUrl: `${REPO}/blob/main/LICENSE.txt`,
  reportIssueUrl: `${REPO}/issues/new`,

  ...IDS,
};

/**
 * Open VSX is the only extension gallery a non-Microsoft build may lawfully
 * use. The Marketplace Terms of Use restrict it to Microsoft products, and its
 * CDN blocks third-party clients regardless. Cursor and VSCodium both use this.
 */
const GALLERY = {
  serviceUrl: "https://open-vsx.org/vscode/gallery",
  itemUrl: "https://open-vsx.org/vscode/item",
  resourceUrlTemplate:
    "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
  controlUrl: "",
  nlsBaseUrl: "",
  publisherUrl: "",
};

/**
 * Microsoft-only wiring. Each of these either calls a Microsoft or GitHub
 * server, or activates a product we are not licensed to ship.
 */
const DELETE = [
  "defaultChatAgent", // GitHub Copilot
  "trustedExtensionAuthAccess", // grants Copilot our auth tokens
  "webviewContentExternalBaseUrlTemplate", // *.vscode-cdn.net
  "voiceWsUrl", // falcon-caas.mai.microsoft.com
  "agentsTelemetryAppName",
  "aiConfig",
  "surveys",
  "npsSurveyUrl",
  "experimentsUrl", // Microsoft experimentation service
  "updateUrl", // Microsoft update server; we ship our own releases
  "documentationUrl",
  "requestFeatureUrl",
  "keyboardShortcutsUrlMac",
  "keyboardShortcutsUrlLinux",
  "keyboardShortcutsUrlWin",
  "introductoryVideosUrl",
  "tipsAndTricksUrl",
  "newsletterSignupUrl",
  "twitterUrl",
];

/** Keymap onboarding entries that point at extensions absent from Open VSX. */
const KEYMAPS_ON_OPEN_VSX = new Set(["vscode", "vim", "intellij", "eclipse"]);

function fail(msg) {
  console.error(`rebrand: ${msg}`);
  process.exit(1);
}

function rebrandProduct(product) {
  const next = { ...product, ...SET, extensionsGallery: { ...GALLERY } };
  for (const key of DELETE) delete next[key];

  if (Array.isArray(next.onboardingKeymaps)) {
    next.onboardingKeymaps = next.onboardingKeymaps.filter((k) =>
      KEYMAPS_ON_OPEN_VSX.has(k?.id)
    );
  }
  return next;
}

/** Every check that must hold for the tree to be shippable. */
function verify(p) {
  const problems = [];

  for (const [k, v] of Object.entries(SET)) {
    if (p[k] !== v) problems.push(`${k} is ${JSON.stringify(p[k])}, expected ${JSON.stringify(v)}`);
  }
  for (const k of DELETE) {
    if (k in p) problems.push(`${k} should have been removed`);
  }
  if (p.extensionsGallery?.serviceUrl !== GALLERY.serviceUrl) {
    problems.push("extensionsGallery is not pointed at Open VSX");
  }

  // Nothing may reach a Microsoft or GitHub host at runtime. Scan the whole
  // document rather than a field list, so a key added upstream cannot slip in.
  const BANNED = /(microsoft\.com|visualstudio\.com|vscode-cdn\.net|vscode-unpkg|gallerycdn|githubusercontent|copilot)/i;
  const walk = (node, path) => {
    if (typeof node === "string") {
      if (BANNED.test(node)) problems.push(`${path} still references Microsoft/GitHub: ${node}`);
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    }
  };
  // builtInExtensions are MIT Microsoft-authored extensions we legitimately
  // redistribute, exactly as VSCodium does, so their metadata is exempt.
  const { builtInExtensions, ...scannable } = p;
  walk(scannable, "product");

  return problems;
}

const productPath = join(ROOT, "product.json");
if (!existsSync(productPath)) fail(`no product.json at ${productPath}`);

const current = JSON.parse(readFileSync(productPath, "utf8"));

if (CHECK_ONLY) {
  const problems = verify(current);
  if (problems.length) {
    console.error(`rebrand --check FAILED (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("rebrand --check passed");
  process.exit(0);
}

const next = rebrandProduct(current);
const problems = verify(next);
if (problems.length) {
  console.error("rebrand produced a tree that does not verify:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

writeFileSync(productPath, JSON.stringify(next, null, "\t") + "\n");
console.log(`rebranded ${productPath}`);
console.log(`  name        ${next.nameLong}`);
console.log(`  binary      ${next.applicationName}`);
console.log(`  gallery     ${next.extensionsGallery.serviceUrl}`);
console.log(`  removed     ${DELETE.filter((k) => k in current).length} Microsoft-only keys`);
