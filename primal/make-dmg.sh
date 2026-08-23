#!/usr/bin/env bash
# Package a built Primal Code.app into a distributable .dmg.
#
# Upstream's build/darwin/create-dmg.ts clones dmgbuild into a Python venv and
# composites a Microsoft-branded background. We only need the standard
# drag-to-Applications window, and hdiutil ships with macOS, so this has no
# dependencies and nothing to keep in sync.
#
#   primal/make-dmg.sh [arch]        # arch defaults to arm64
#
# Produces ../primal-code-<version>-macos-<arch>.dmg next to the build output.

set -euo pipefail

ARCH="${1:-arm64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$(dirname "$ROOT")"
APP_DIR="$BUILD_ROOT/VSCode-darwin-$ARCH"
APP="$APP_DIR/Primal Code.app"

if [[ ! -d "$APP" ]]; then
  echo "error: no app at '$APP'" >&2
  echo "build it first: npm run gulp vscode-darwin-$ARCH-min" >&2
  exit 1
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"
VOLNAME="Primal Code"
OUT="$BUILD_ROOT/primal-code-${VERSION}-macos-${ARCH}.dmg"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; hdiutil detach "/Volumes/$VOLNAME" >/dev/null 2>&1 || true' EXIT

echo "staging $APP"
# -R preserves the symlinks inside the bundle. cp -r would flatten them and
# break the framework layout, which shows up much later as a broken app.
cp -R "$APP" "$STAGE/"

# The drag target. Without this the user has to know to copy it themselves.
ln -s /Applications "$STAGE/Applications"

# A .background dir would go here if we add artwork later; a plain window is
# still the conventional macOS install experience.

# Ad-hoc sign the staged bundle. The bare build carries only linker-generated
# signatures with no sealed resources; codesign reports that as "code has no
# resources but signature indicates they must be present", and Apple Silicon
# macOS refuses to launch such an app on any other machine. An ad-hoc deep
# sign (identity "-") seals the bundle so it verifies and launches. Gatekeeper
# still warns on first open because there is no Developer ID behind it — that
# needs an Apple Developer account and notarization, not a build change — so
# the right-click-Open note below stays.
echo "ad-hoc signing"
codesign --force --deep --sign - "$STAGE/Primal Code.app"
codesign --verify --deep --strict "$STAGE/Primal Code.app"
echo "signature verified"

rm -f "$OUT"
echo "building dmg"
hdiutil create \
  -volname "$VOLNAME" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "$OUT" >/dev/null

SIZE="$(du -h "$OUT" | cut -f1 | tr -d ' ')"
echo ""
echo "wrote $OUT ($SIZE)"
echo ""
echo "Note: this build is ad-hoc signed (valid signature, no Developer ID)."
echo "On first launch macOS Gatekeeper will warn. Right-click the app and"
echo "choose Open, or run:"
echo "  xattr -dr com.apple.quarantine '/Applications/Primal Code.app'"
