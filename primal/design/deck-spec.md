# The Deck — spec

One keystroke and everything else melts away: a full-window console for **watching your agent
work**. Music on the left, the live stream of what the agent is writing in the middle, real
machine telemetry on the right, and the chat still within reach. The cyberpunk console the owner
asked for — built on real signals only.

Branch `feat/deck`. Stacked on nothing; main already has Vibes, Slab chrome, Primal Start, The
Rig, Atmosphere and the update notifier.

## The one rule that makes this a console and not a screensaver

**Every moving thing on screen is driven by something real.** The spectrum bars are per-core CPU;
the trace across them is the agent's output rate in characters per second; the readouts are the
machine's numbers; the stream is the agent's actual output. There is **no audio visualizer** —
a browser engine cannot tap system audio, and a fake one wiggling to a random number would make
every other panel suspect. Where a real signal is unavailable, the panel says so plainly or is
omitted. A user should be able to learn to *read* this screen.

## Entering and leaving

- Command `primalCode.deck.toggle` — "Primal Code: Toggle The Deck". Keybinding proposal
  `Ctrl+Cmd+D` (mac) / `Ctrl+Alt+D` (win/linux); recon verifies conflicts and picks a free chord.
- Entering: open the Deck pane in the active editor group, then hide the **side bar** and the
  **panel** via `IWorkbenchLayoutService.setPartHidden`, remembering what was visible. Keep the
  **auxiliary bar** — the chat IS the agent; if it is closed, open the chat view so the input is
  present. Do not touch zen mode or fullscreen.
- Leaving: the same keystroke, the header button, or closing the Deck tab — all three restore
  exactly the parts that were visible before. Restoration must happen on tab close too (listen
  for the pane's input being closed), never only on the command.
- `Escape` does NOT leave; it belongs to the editor.

## Layout (full editor area, three columns, a thin header, a thin footer)

```
┌─ header: wordmark · vibe · clock · active session name · [exit ⌃⌘D] ───────────────┐
│ NOW PLAYING          │ THE STREAM (live agent output)         │ TELEMETRY           │
│ art? title · artist  │ 14:02:11  ▸ read  src/app.ts           │ cpu ▮▮▮▯ 62%        │
│ ▶ 1:12 / 3:40        │ 14:02:12  ✎ edit  src/app.ts  +12 −3   │ c0 ▮▮▮▮▮▯▯▯ 58%     │
│──────────────────────│ 14:02:12  "Refactoring the loader…"    │ c1 …                │
│ AGENT SESSIONS       │ …auto-follows; pauses when you scroll  │ mem 11.2 / 32 GB     │
│ ● running  fix login │  up; [jump to live] chip appears        │ load 1.8 1.7 1.0    │
│ ○ waiting  …         │                                        │─────────────────────│
│                      │                                        │ SPECTRUM            │
│                      │                                        │ ▂▅▇▃▂▆▁▄ cpu · rate │
└─ footer: ⌃⌘D leave · ⌃⌘. vibe · ⌃⌘I chat ────────────────────────────────────────┘
```
Column widths ~26 / 48 / 26. Below ~900px wide, collapse to stream + telemetry; below ~640px
stream only. Everything styled from theme tokens so all six vibes restyle it.

## Panels

### The Stream (center) — the heart of it
The agent's live output as a scrolling monospace log. Source: the real chat/agent session models
in this fork (recon finds the exact events — response parts streaming in, tool invocations, file
edits with paths and line deltas). Render one line per event with a wall-clock timestamp:
- text deltas: coalesce into a line per response turn, show the latest ~200 chars, tail-trimmed
- tool call: `▸ <tool>  <primary argument>`
- file edit: `✎ <path>  +a −b`
- session status changes: `● session started` / `✓ done` / `⚠ waiting on you`
Auto-follow to bottom; if the user scrolls up, stop following and show a "jump to live" chip;
resume following on click. Cap the buffer (e.g. 500 lines) — this must never grow unbounded.
Which session? The active chat session in the auxiliary bar; if several are live, the most
recently active, with the header naming it. Empty state: "No agent running — start one in chat."

### Telemetry (right, top) — real, from the main process
`IPrimalTelemetryService` (contract at `src/vs/platform/primalTelemetry/common/primalTelemetry.ts`,
already written — implement it, do not change it). Main process samples `os.cpus()` deltas,
`os.totalmem/freemem`, `os.loadavg`, `os.uptime` at 1 Hz **only while at least one lease is
held**. Leases are renewed by the renderer every 5 s and expire after 15 s, so a closed window
can never leave the main process sampling forever. Renderer acquires on show, releases on hide
and dispose. Render: total CPU with a bar, one small bar per core, memory used/total, load
averages, uptime. Numbers are numbers — no invented "temperature" (Node cannot read it
portably; omit it).

### Spectrum (right, bottom)
A `<canvas>`: one bar per CPU core (height = that core's usage), plus a thin trace line across
the bars whose height is the stream rate (chars/s of agent output over the last ~2 s), labelled
on-screen `cpu · stream rate`. Draw with `requestAnimationFrame` **only while the pane is visible
and `document.visibilityState === 'visible'`**; stop the loop on hide. With
`prefers-reduced-motion`, no rAF at all — repaint once per telemetry tick. Canvas is sized in
`layout()`, never per frame. Smooth values with a short exponential average so it reads, but the
underlying samples are unmodified.

### Now Playing (left, top)
`IPrimalMediaService` (contract at `src/vs/platform/primalMedia/common/primalMedia.ts`, already
written — implement it). macOS first, via `osascript` polled every 2 s while leased:
- **Never launch a player.** `tell application "Spotify"` starts Spotify if it is not running;
  guard every query with `if application "Spotify" is running` (and the same for "Music") through
  System Events, and skip apps that are not running.
- Read: app, title, artist, album, player state, position, duration. Return `undefined` when
  nothing is playing or paused-for-long; the panel shows "Nothing playing".
- Other platforms: `getCapabilities()` reports unsupported and the panel is **omitted** (the
  left column then shows sessions only). Do not stub a fake player.
Artwork: only if a real URL is available from the player (Spotify exposes `artwork url`); never a
placeholder image.

### Agent sessions (left, bottom)
Reuse The Rig's session rows (`src/vs/workbench/contrib/primalRig/browser/primalRigSessions.ts`)
— same truthfulness rules, same status chips. Do not duplicate that logic; import it.

### Header / footer
Real clock (updated per minute, or per second only while visible), current vibe (click → picker),
active session name, exit button. Footer: shortcut hints resolved from the keybinding service.

## Performance rules (hard)

- Zero work while hidden: no rAF, no telemetry lease, no media polling, no timers except the
  clock, when the Deck is not the visible pane. Verify by construction: every loop is started in
  `setVisible(true)`/show and stopped in `setVisible(false)`/hide/dispose.
- The stream re-renders incrementally (append lines), never rebuilds the whole log.
- Bounded buffers everywhere; no unbounded arrays of samples or lines.
- No layout thrash: read sizes in `layout()`, not in render loops.

## Truthfulness rules (hard)

- Every number and every line traces to a real API; recon records file:line for each.
- Panels with no data show honest empty states; unsupported capabilities are omitted.
- The spectrum's data source is labelled on the canvas.
- No decorative "matrix rain", fake hex dumps or invented log lines. The atmosphere comes from
  the vibe, the wallpaper, the typography and the real motion of real data.

## Wiring

- Main process: implement the two services under `src/vs/platform/primal{Telemetry,Media}/electron-main/`,
  expose them with `ProxyChannel.fromService` and `mainProcessElectronServer.registerChannel(...)`
  in `src/vs/code/electron-main/app.ts` next to the existing channels, and register the services
  in the main-process services list the way neighbouring services are (recon finds the file).
- Renderer: `registerMainProcessRemoteService(IPrimalTelemetryService, 'primalTelemetry')` (and
  media) in `src/vs/workbench/services/primal{Telemetry,Media}/electron-browser/`, imported from
  the desktop main. Events over ProxyChannel: verify that `Event` properties on the service
  interface proxy correctly (the update service is the precedent).
- Pane: `src/vs/workbench/contrib/primalDeck/browser/` — pane, input, contribution, stream model,
  spectrum, layout toggle. Registration import next to the other `primal*` imports in
  `src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts`.
- `vs/workbench/contrib/primalDeck` in `build/lib/i18n.resources.json`; any `--primal-deck-*`
  custom properties in `build/lib/stylelint/vscode-known-variables.json`; token-only colours;
  high-contrast opt-out; `:focus-visible` on every control; all strings localized.

## Verification gates

- `npm run compile-client` clean; `npm run valid-layers-check` clean (new platform layers).
- Toggle in: side bar and panel hide, chat stays; toggle out and tab-close both restore exactly.
- Telemetry readouts change second to second and are the right order of magnitude vs Activity
  Monitor; leases expire (kill the renderer's renewal and confirm sampling stops in main logs).
- The stream shows a real session's output (send a prompt in chat while the Deck is open).
- With no player running, Now Playing shows "Nothing playing" and **no player was launched**.
- Hide the pane: rAF counter stops advancing.
- `prefers-reduced-motion`: no rAF loop.
- Chat PONG still passes.
