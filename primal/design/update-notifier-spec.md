# Update notifier spec

Every user who installs today is frozen on that build unless they happen to re-visit the site.
Full silent auto-update is not available to us yet: on macOS it runs through Squirrel, which
requires a Developer ID signature we do not have (`updateService.darwin.ts` even logs "application
is very likely not signed" when `setFeedURL` fails). Windows could auto-update today, but shipping
two different update mechanisms is worse than one honest one.

So: **check, and tell the user.** One mechanism, every platform, no signing, no server.

## The manifest

Published by us at a stable raw URL in the public downloads repo:
`https://raw.githubusercontent.com/MuhammadTalhaJaved-0303/primal-code-downloads/main/latest.json`

```json
{
  "version": "1.135.0",
  "commit": "<git sha the build came from>",
  "date": "2026-09-01T19:45:32+05:00",
  "name": "Vibes and the new chrome",
  "notesUrl": "https://github.com/.../releases/tag/ide-v1.135.1",
  "downloads": {
    "darwin-arm64": "https://.../PrimalCode-macos-arm64.dmg",
    "win32-x64": "https://.../PrimalCode-Setup-Windows-x64.exe"
  }
}
```

**Commit, not version, is the identity.** We rebuild the same version number repeatedly, so semver
cannot tell two builds apart; `product.commit` can, and the packaged app already carries it.

## Client behaviour — `src/vs/workbench/contrib/primalUpdate/browser/`

- Runs after the workbench is restored, delayed at least 20s. It must never touch startup.
- **Dev builds skip entirely** — if `productService.commit` is absent, do nothing at all.
- Fetch the manifest with a short timeout. **Any failure is a silent no-op**: offline, 404, malformed
  JSON, timeout. Never a dialog, never an error toast, never a retry storm. Log at debug only.
- Validate the parsed manifest before trusting it (commit is a hex string, downloads is an object of
  strings). It comes off the network — treat it as untrusted input.
- Show a notification only when `manifest.commit !== product.commit` **and** that commit is not the
  one the user chose to skip:
  > Primal Code {version} is available — {name}
  - **Download** — opens the platform-appropriate URL from `downloads` via `IOpenerService`.
    If the current platform has no entry, omit the button rather than opening something wrong.
  - **Release Notes** — opens `notesUrl`.
  - **Skip This Build** — stores that commit in APPLICATION storage; never nag about it again.
- Re-check every 8 hours while the window stays open.
- Command **"Primal Code: Check for Updates"**. When run explicitly it always reports an outcome,
  including "Primal Code is up to date" and a plain failure message — the silent-failure rule
  applies only to the automatic background check.
- Setting `primalCode.update.mode`: `notify` (default) | `off`. Its description must state plainly
  what the check does: one HTTPS GET to the manifest URL, nothing about the user is sent.

## Privacy (non-negotiable)

The request carries no query string, no identifiers, no telemetry. This is a BYOK, local-first
product; an update check that phones home with data would contradict the whole pitch.

## Publishing side — `primal/publish-latest.ts`

A script that writes `latest.json` from real state: the built app's `product.json` (version, commit,
date), a release tag passed as an argument, and the asset URLs from that release. It must fail loudly
rather than emit a manifest with guessed or missing fields, and support `--check` to verify the
published manifest matches the current build.

## Guardrails

- Nothing blocking; no awaits before the workbench is interactive.
- Disposables registered; the 8-hour timer disposed on shutdown.
- All user-visible strings localized.
- `vs/workbench/contrib/primalUpdate` added to `build/lib/i18n.resources.json`.
- Clean `npm run compile-client`.
