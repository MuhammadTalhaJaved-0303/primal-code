# Primal Code — Visual Identity Plan

Status: proposed · Owner review pending · 2026-08-30

The goal: Primal Code stops reading as "a VS Code fork" and becomes its own product before public
launch. The signature feature is **Vibes** — Omarchy-style whole-IDE theme packs switched with one
shortcut — surrounded by a disciplined identity: restrained chrome, our own iconography and
typography, and a first-run experience that sets up a vibe and API keys in under a minute.

Every phase is additive-first and independently shippable. Nothing here touches the agent engine.

---

## Why this shape (research summary)

Four research passes inform this plan (2026-08-30):

**Omarchy (the model for Vibes).** A theme there is a *total mood commitment*: one `colors.toml`
palette generates configs for every app, plus per-app files for the ones that need native themes,
bundled wallpapers, lock screen, icons. One keybind atomically swaps `current/theme` and
live-reloads everything. Reviewers' hook: "the status bar, notifications, lock screen and menus all
change simultaneously — a whole new desk in one keystroke." Light/dark is a *property of the theme*
(a `light.mode` marker), not a separate axis. 88+ community themes exist because a theme is a
beginner-sized creative project (a git repo of text files).

**IDE design trends.** What earns praise: Windsurf's chrome restraint ("Apple vs Microsoft"),
Cursor 2's agent-first sidebar + PR-style diff review, Antigravity's visible Plan→Build→Verify
process, Zed's speed-as-aesthetic and UI/buffer font split, Warp's wallpaper→theme generation.
What gets a fork mocked: shipping VS Code's exact chrome with a renamed title bar (PearAI is the
cautionary tale). Onboarding pattern of winners: import-or-choose (never blank), theme+keymap
picker on first run, defer sign-in/keys until an AI feature is invoked — and never *require* login
(Warp's backlash).

**Hermes Agent / OpenClaw (viability backlog).** Most-borrowable ideas, ranked: file-on-disk
project memory + self-created skills (with staged approval of writes), overnight agents that ping
you on Telegram/Slack and accept steering, a security-first local trust story (OpenClaw's open
flank), portable SKILL.md compatibility, cost-transparent model routing, a SOUL.md-style persona
file. These come *after* design — logged in the backlog section.

**Our codebase (safety map).** Everything Vibes needs is public API:
`IWorkbenchThemeService.setColorTheme/setFileIconTheme/setProductIconTheme` with
`ConfigurationTarget.USER` applies **and persists**; `'preview'` applies without persisting (the
built-in theme quick pick already does live preview this way — `themes.contribution.ts`). The
`productIconThemes` extension point exists and **no built-in extension uses it** — a clean slot for
our own iconography. The custom title bar is already the default on all OSes and fully themeable
via `titleBar.*` colors. Upstream already ships a first-run onboarding overlay
(`welcomeOnboarding/browser/onboardingVariationA.ts`) with a theme grid driven by
`product.onboardingThemes`. Risky zones to avoid: `src/vs/workbench/browser/parts/**` CSS/TS
(churns on every upstream rebase) and inline edits to `onboardingVariationA.ts` (experimental,
will churn) — wrap or replace instead.

---

## Design north star

- **Identity, not decoration.** Default look is **monochrome ink-and-paper** (matches the website's
  Paper & Ink identity). Color arrives only through vibes the user chooses.
- **Color-blind-safe by construction.** Meaning is never encoded in hue alone — state uses shape,
  weight, labels, and contrast. (Owner is color blind; this is a hard rule, and it's also just good
  accessibility.)
- **Additive-first engineering.** New extensions and new contribution files over upstream edits;
  the few upstream touches are tiny, greppable, and listed per phase.
- **Restraint is the aesthetic.** Windsurf lesson: fewer visible controls than VS Code, not more.

---

## The signature: Vibes

A **vibe** is one JSON manifest bundling:

| Slot | Mechanism | Persisted as |
|---|---|---|
| Workbench color theme (full chrome recolor) | `setColorTheme(id, USER)` | `workbench.colorTheme` |
| Product icon theme (our glyphs) | `setProductIconTheme(id, USER)` | `workbench.productIconTheme` |
| File icon theme | `setFileIconTheme(id, USER)` | `workbench.iconTheme` |
| Editor font pairing | settings write | `editor.fontFamily` |
| Chat/panel accent + terminal palette | part of the color theme JSON | — |
| Optional editor background texture | off by default, Phase D2b | `primal.vibe.background` |

- **One shortcut cycles vibes** (proposal: `Ctrl+Cmd+.`; picker on `Cmd+K Cmd+V`), with the same
  live-preview-on-arrow-keys behavior as the built-in theme picker. Status bar shows the current
  vibe name.
- **Light/dark is a property of the vibe** (Omarchy's lesson): each vibe declares `mode`, and a
  paired-vibe field enables auto day/night later.
- **Community format from day one**: a vibe is a folder (manifest + theme JSONs + preview image) —
  installable from a git URL later, like Omarchy's 88-theme ecosystem.

### Launch vibes (6)

| Vibe | Mode | Character |
|---|---|---|
| **Ink** | light | Monochrome paper — the identity default; mirrors the website |
| **Basalt** | dark | Monochrome near-black matte — the dark identity default |
| **Tide** | dark | Deep blue-cyan (blue-anchored palettes are the most color-vision-safe) |
| **Dusk** | dark | Muted violet/rose, low contrast, evening feel |
| **Fern** | dark | Deep forest green (for users who love it; never the default) |
| **Ridge** | light | Warm stone/clay light theme |

Each vibe recolors *everything*: title bar, activity bar, status bar, tabs, sidebar, chat panel,
terminal ANSI palette, selection, splash colors — no VS Code blue survives anywhere.

---

## Phases

### D1 — Theme foundation (safe, additive) — ~2–3 days
1. `extensions/theme-primal/` — the 6 vibe color themes as complete workbench themes (every
   `titleBar.*`, `activityBar.*`, `statusBar.*`, `tab.*`, `sideBar.*`, `terminal.ansi*`,
   `chat.*` token set deliberately; HC themes untouched).
2. `extensions/theme-primal-icons/` — **product icon theme** (custom glyphs for the ~30 highest-
   visibility codicons: activity bar, chat, status bar) + file icon theme accent pass.
3. Defaults: `ThemeSettingDefaults.COLOR_THEME_DARK/LIGHT` → Basalt/Ink, with
   `*_INITIAL_COLORS` synced (else the splash flashes wrong colors). *(small upstream edit #1)*
4. `product.json onboardingThemes` → the 6 vibes, via `primal/rebrand.ts` (built for this).

### D2 — Vibes engine (the signature) — ~3–5 days
1. New `src/vs/workbench/contrib/primalVibes/` contribution (fully additive): vibe manifests,
   `IPrimalVibeService` applying all slots atomically with USER persistence, cycle + picker
   commands, keybindings, status bar entry.
2. Picker with live preview (reuse the `selectTheme` openQuickPick pattern).
3. D2b (optional, flag off): background texture layer per vibe — the only feature that may need a
   CSS touch; skip if it risks anything.

### D3 — Typography & chrome restraint — ~2–3 days
1. Bundle open-licensed identity fonts: one UI face, one coding face. Editor default via
   `EDITOR_FONT_DEFAULTS` or `configurationDefaults`; UI face via a tiny `@font-face` block in
   `browser/media/style.css` *(small upstream edit #2 — the file is tiny and stable)*.
2. Restraint pass via **settings defaults only**: command center on, menu bar compact, fewer
   default status bar items, activity bar polish. No `parts/**` TS edits.

### D4 — First-run experience — ~2–4 days
1. Own the onboarding overlay: vibe picker grid (with live full-window preview), keymap choice,
   and an **API keys step** wired to the existing Primal Settings editor — skippable, never a
   login wall. Implement by wrapping/replacing `IOnboardingService`, not editing
   `onboardingVariationA.ts` inline.
2. "Import from VS Code" (settings/keybindings/extensions) — stretch goal, Cursor's most-loved
   onboarding move.

### D5 — Verify & ship — ~1–2 days
Packaged DMG, full checklist (below), refresh website screenshots + intro video (the site would
otherwise show the old look), release.

---

## No-break guardrails (every phase)

- [ ] Additive-first: new files/extensions preferred; upstream edits limited to the two listed.
- [ ] Never patch `src/vs/workbench/browser/parts/**` CSS/TS.
- [ ] Verify in dev via the `launch` skill with screenshots of **every vibe** before any DMG.
- [ ] Chat engine smoke test after each phase: send a message in a Claude session + a Codex
      session; both must answer (the PONG test).
- [ ] High-contrast themes and accessibility untouched; no meaning encoded in hue alone.
- [ ] `npm run compile` clean + existing theme service tests green before commit.
- [ ] One commit per phase step; DMG only at phase boundaries.

---

## After design: viability backlog (from Hermes/OpenClaw research)

Ranked; none block launch:

1. **Project memory + agent-created skills on disk** (`.primal/memory/`, `.primal/skills/`) with
   staged approval of writes — "gets better the longer you use it", inspectable, git-committable.
2. **Overnight agent mode**: task keeps running with the window closed; pings Telegram/Slack when
   done or blocked; replies steer it.
3. **Security trust story**: keys in Keychain (done), per-capability permissions, visible audit
   log — market against OpenClaw's ClawJacked headlines.
4. **Portable skills**: read the open SKILL.md / agentskills.io format → 1,700+ existing
   community skills work in Primal Code.
5. **Cost transparency + model routing**: per-task token spend visible; route routine steps to
   cheap models (Haiku/DeepSeek/GLM), frontier for hard steps — BYOK makes this a native edge.
6. **SOUL.md-style persona file** per project — cheap, high attachment.

Also still pending from earlier phases: worktree "Apply to project" button (Phase 1c, fully
mapped), inline diff review (old Phase 3 — pairs with Cursor's most-praised UX), Windows build
(blocked on GitHub billing).
