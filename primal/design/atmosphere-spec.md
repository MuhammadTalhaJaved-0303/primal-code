# Atmosphere — Layer 03 spec

Layer 03 of the Vibe Stack (see the positioning doc). Two features that turn a screenshot into a
screen recording: a **boot sequence** and a **wallpaper layer**. Both are additive contributions;
neither touches the agent engine or `src/vs/workbench/browser/parts/**`.

Stacked on `feat/slab-chrome` — the wallpaper design depends on the slab ground existing.

## Non-negotiables (from the doctrine's "what kills this")

- **Never in the way.** Boot is skippable by any input and never delays the workbench becoming
  interactive. Wallpaper never sits behind body text.
- **Zero jank.** No continuous animation loops, no per-frame JS. Boot uses CSS transitions only and
  runs once; wallpaper is a static paint (no animation at all).
- **`prefers-reduced-motion` respected** — boot degrades to an instant, motionless fade.
- **Opt-out in one setting each**, and both remembered.
- **Token-only colors**, so all six vibes style both features for free. Zero literals.
- **High-contrast themes opt out entirely** (same guard style as `primalChrome.css`).

## A. Boot sequence — `src/vs/workbench/contrib/primalBoot/browser/`

A short, quiet startup moment that says "this is a machine you own", not a loading screen.

- **When**: once per window open, after the workbench renders, only when
  `primalCode.boot.enabled` (default `true`) and the window is not reloading into a restored
  session mid-work. Never on a reload triggered by settings changes if that is detectable cheaply;
  if not, once per window open is acceptable.
- **What**: a full-window overlay painted from the active vibe's tokens:
  - the "Primal Code" wordmark, letter-spaced, low-key
  - three to five monospace status lines that reveal in sequence, ~90ms apart, e.g.
    `agent host ready` · `providers 7` · `vibe basalt` · `workspace <name or "no folder">`
    Lines must be **truthful** — derive each from real state (agent-host availability, count of
    configured providers, current vibe label, workspace name). A fake readout is a gimmick; a real
    one is a status display.
  - total on-screen time ≤ 1.4s including fade-out, then the overlay disposes itself entirely.
- **Dismissal**: any keydown, pointerdown, or wheel event fades it immediately. The overlay is
  `pointer-events: none` after the fade begins and is removed from the DOM on completion.
- **Never blocks**: the workbench is fully interactive underneath the whole time; the overlay must
  not trap focus, must be `aria-hidden`, and must not appear in the tab order.
- **Reduced motion**: no staged reveal, no transform — render complete, hold ~400ms, fade.

## B. Wallpaper layer — `src/vs/workbench/contrib/primalWallpaper/browser/`

The slab chrome recessed the ground; this puts something *in* that ground. Because the wallpaper
lives in the ground — the frame around and behind the slabs — it never sits behind code, so
legibility is structurally safe rather than a tuning exercise.

- **Modes** via `primalCode.wallpaper.mode`:
  - `ambient` (**default**) — procedural, generated from the active vibe's own tokens: a soft
    off-center radial wash plus a very fine grain, painted as static CSS/SVG-data-URI. No image
    assets ship; nothing to license; it always matches the vibe and costs nothing to render.
  - `image` — the user's own art via `primalCode.wallpaper.imagePath` (absolute path or a
    `file:`/`data:` URI). This is the "make it your own world" affordance. Validate the path, fail
    silently to `ambient` on error, and never block startup on it.
  - `off`.
- **Intensity** via `primalCode.wallpaper.opacity`, default `0.12`, clamped to `0…0.35` so no
  setting can make the chrome unreadable.
- **Where**: a single element behind all parts inside the workbench container, or a
  `.monaco-workbench` background layer — whichever avoids touching part DOM. It must sit *under*
  the slabs, which stay opaque.
- **Optional, default off**: `primalCode.wallpaper.tintSlabs` — lets a hint bleed through panel
  slabs. Never applies to the editor slab.

## Settings summary

| Setting | Default |
|---|---|
| `primalCode.boot.enabled` | `true` |
| `primalCode.wallpaper.mode` | `ambient` |
| `primalCode.wallpaper.imagePath` | `""` |
| `primalCode.wallpaper.opacity` | `0.12` |
| `primalCode.wallpaper.tintSlabs` | `false` |

## Verification gates

- Boot renders and fully disposes in all six vibes; a keypress during boot dismisses it and the
  keystroke is not swallowed by the overlay.
- Wallpaper visible in the ground in all six vibes; code text sits on opaque slabs at all times.
- High-contrast dark: neither feature paints anything.
- `prefers-reduced-motion`: boot shows no staged reveal.
- Chat smoke test still passes (Claude replies PONG).
- Clean `npm run compile-client`.
