#!/usr/bin/env node --experimental-strip-types
/**
 * Repin the builtInExtensions checksums against Open VSX.
 *
 * product.json ships SHA256 checksums for the built-in extensions, and the
 * build verifies every download against them. Those checksums describe the
 * artifacts on Microsoft's Marketplace, but we fetch from Open VSX, which
 * repackages, so the bytes differ and the build aborts.
 *
 * The fix is to pin Open VSX's actual bytes rather than to drop verification.
 * Deleting the checksums would "work" and would quietly turn a supply-chain
 * guarantee into nothing: js-debug runs with the same privileges as the editor.
 *
 *   node --experimental-strip-types primal/repin-builtins.ts [--check]
 *
 * Checksums are computed the same way build/lib/fetch.ts computes them, via
 * fetch() plus arrayBuffer(), so a value pinned here is a value the build will
 * accept.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");
const productPath = join(ROOT, "product.json");

interface BuiltIn {
  name: string;
  version: string;
  sha256?: string;
}

const product = JSON.parse(readFileSync(productPath, "utf8"));
const gallery: string = product.extensionsGallery?.serviceUrl;
if (!gallery) {
  console.error("repin: product.json has no extensionsGallery.serviceUrl");
  process.exit(1);
}

/** Same URL shape the build asks for. */
function vspackageUrl(name: string, version: string): string {
  const dot = name.indexOf(".");
  const publisher = name.slice(0, dot);
  const extension = name.slice(dot + 1);
  return `${gallery}/publishers/${publisher}/vsextensions/${extension}/${version}/vspackage`;
}

async function sha256Of(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength < 1024) {
    // An error page returns 200 with a tiny body on some mirrors. Pinning that
    // would bake a permanent failure into product.json.
    throw new Error(`suspiciously small payload (${bytes.byteLength} bytes) for ${url}`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

const builtIns: BuiltIn[] = product.builtInExtensions ?? [];
if (builtIns.length === 0) {
  console.log("repin: no builtInExtensions to pin");
  process.exit(0);
}

let changed = 0;
let failed = 0;

for (const ext of builtIns) {
  const url = vspackageUrl(ext.name, ext.version);
  try {
    const actual = await sha256Of(url);
    if (ext.sha256 === actual) {
      console.log(`  ok       ${ext.name}@${ext.version}`);
      continue;
    }
    if (CHECK_ONLY) {
      console.error(`  MISMATCH ${ext.name}@${ext.version}`);
      console.error(`           pinned ${ext.sha256}`);
      console.error(`           actual ${actual}`);
      failed++;
    } else {
      console.log(`  repinned ${ext.name}@${ext.version}`);
      console.log(`           ${ext.sha256} -> ${actual}`);
      ext.sha256 = actual;
      changed++;
    }
  } catch (err) {
    console.error(`  FAILED   ${ext.name}@${ext.version}: ${(err as Error).message}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\nrepin: ${failed} extension(s) could not be verified`);
  process.exit(1);
}

if (changed > 0) {
  writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
  console.log(`\nrepin: updated ${changed} checksum(s) in product.json`);
} else {
  console.log("\nrepin: all checksums already match Open VSX");
}
