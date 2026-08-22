#!/usr/bin/env bash
# Generate every app icon Primal Code ships, from one vector source.
#
# Stock Code-OSS icons are the fastest way to look like a hobby fork, and there
# are more of them than you would expect: the dock/taskbar icon, the installer,
# and the Windows tiles all read from different files.
#
#   primal/make-icons.sh <path-to-icon.svg>
#
# Requires macOS (sips + iconutil) and a Chrome available to puppeteer for the
# SVG rasterisation, which is why this is a build-time script and the generated
# binaries are committed.

set -euo pipefail

SVG="${1:-}"
if [[ -z "$SVG" || ! -f "$SVG" ]]; then
  echo "usage: primal/make-icons.sh <icon.svg>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Puppeteer lives in the sibling studio repo, so this tree does not have to
# carry a Chrome download. Resolved relative to this repo rather than absolute,
# so the path survives the workspace being moved or renamed.
RENDERER="${PUPPETEER_PROJECT:-$ROOT/../primal-studio}"
if [[ ! -d "$RENDERER/node_modules/puppeteer" ]]; then
  echo "error: puppeteer not found under $RENDERER" >&2
  echo "set PUPPETEER_PROJECT to a project that has puppeteer installed" >&2
  exit 1
fi

echo "rasterising $SVG at 1024px"
cat > "$WORK/render.mjs" <<'JS'
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";
const [svgPath, out, size] = process.argv.slice(2);
const svg = readFileSync(svgPath, "utf8");
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: +size, height: +size, deviceScaleFactor: 1 });
await page.setContent(
  `<body style="margin:0">${svg.replace("<svg", `<svg width="${size}" height="${size}"`)}</body>`
);
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
JS
cp "$WORK/render.mjs" "$RENDERER/.primal-render.tmp.mjs"
( cd "$RENDERER" && node .primal-render.tmp.mjs "$SVG" "$WORK/icon_1024.png" 1024 )
rm -f "$RENDERER/.primal-render.tmp.mjs"

# ---- macOS .icns -----------------------------------------------------------
SET="$WORK/Primal.iconset"
mkdir -p "$SET"
# iconutil requires these exact names; a missing size is silently dropped and
# shows up later as a blurry dock icon.
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  px="${spec%% *}"; name="${spec##* }"
  sips -z "$px" "$px" "$WORK/icon_1024.png" --out "$SET/${name}.png" >/dev/null 2>&1
done
iconutil -c icns "$SET" -o "$ROOT/resources/darwin/code.icns"
echo "wrote resources/darwin/code.icns"

# ---- Linux -----------------------------------------------------------------
sips -z 512 512 "$WORK/icon_1024.png" --out "$ROOT/resources/linux/code.png" >/dev/null 2>&1
echo "wrote resources/linux/code.png"

# ---- Windows .ico + tiles --------------------------------------------------
# A .ico is a container of PNGs; sips cannot author one, so build it directly.
for px in 16 24 32 48 64 128 256; do
  sips -z "$px" "$px" "$WORK/icon_1024.png" --out "$WORK/ico_${px}.png" >/dev/null 2>&1
done
node - "$WORK" "$ROOT/resources/win32/code.ico" <<'JS'
const fs = require("node:fs");
const [work, out] = process.argv.slice(2);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((px) => ({ px, buf: fs.readFileSync(`${work}/ico_${px}.png`) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);           // reserved
header.writeUInt16LE(1, 2);           // type 1 = icon
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + images.length * 16;
for (const { px, buf } of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(px >= 256 ? 0 : px, 0);  // 0 means 256
  e.writeUInt8(px >= 256 ? 0 : px, 1);
  e.writeUInt8(0, 2);                   // palette
  e.writeUInt8(0, 3);                   // reserved
  e.writeUInt16LE(1, 4);                // colour planes
  e.writeUInt16LE(32, 6);               // bits per pixel
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buf.length;
  entries.push(e);
}
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.buf)]));
JS
echo "wrote resources/win32/code.ico"

sips -z 70 70 "$WORK/icon_1024.png" --out "$ROOT/resources/win32/code_70x70.png" >/dev/null 2>&1
sips -z 150 150 "$WORK/icon_1024.png" --out "$ROOT/resources/win32/code_150x150.png" >/dev/null 2>&1
echo "wrote resources/win32 tiles"

echo "done"
