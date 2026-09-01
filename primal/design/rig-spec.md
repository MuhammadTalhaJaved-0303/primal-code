# The Rig — Layer 05 spec

The screen that turns Primal Code from an editor into a platform. Replaces Primal Start's role as
the landing surface with a home console: your projects, your agents' activity, your spend, your
vibe. Built on Primal Start's existing editor-pane plumbing rather than a new one.

## Why this and why now

Primal Start answers "what do I open?". The Rig answers "what is happening in my work?" — the
question a platform answers and an editor does not. It is also the surface that makes the daily
return visit feel like sitting down at your own machine.

## Sections (in order down the page)

1. **Header** — wordmark, current vibe (click to open the vibe picker), and a "New Agent Chat"
   primary action. Keep it thin; the page is not a dashboard poster.
2. **Projects** — recent workspaces as rows or cards, each showing: name, dimmed path, last-opened
   relative time, and (when cheaply available) the git branch. Click opens. This replaces the plain
   recents list, and is the section that must feel best.
3. **Agent activity** — the honest version of "what my agents did". Read real agent-session state:
   sessions with their status (running / waiting on you / done), the workspace they belong to, and
   a relative timestamp. If the underlying data is not available synchronously, render a quiet
   empty state — NEVER invent activity.
4. **Today** — a small stat row: sessions run, files changed by agents, tokens/spend if it can be
   sourced truthfully. Each stat must come from real recorded state. Any stat that cannot be
   sourced is omitted entirely, not zero-filled or faked.
5. **Footer** — shortcut hints (same idiom as Primal Start).

## Truthfulness rule (hard)

This page displays claims about the user's own work. Every number and status must be derived from
real state, with a file:line justification in the PR. Where a datum is unavailable, the section
degrades to an honest empty state ("No agent sessions yet") rather than a placeholder. A fabricated
stat here is worse than a missing one — it is the difference between a console and a toy.

## Data sources to investigate (do not guess — read these)

- Recent workspaces: `IWorkspacesService.getRecentlyOpened()` (already used by Primal Start).
- Agent sessions: the agent-session services under `src/vs/workbench/contrib/chat/browser/agentSessions/`
  and `IAgentSessionsService` — determine what is queryable synchronously and what is not.
- Chat/session history: whatever the chat service exposes for past sessions in the current window.
- Git branch: only if a cheap, non-blocking API exists; otherwise omit.
- Spend/tokens: only if genuinely recorded somewhere; otherwise omit this stat entirely.

## Wiring

- Reuse the Primal Start editor-pane pattern (`src/vs/workbench/contrib/primalStart/browser/`) —
  new pane + input + serializer under `src/vs/workbench/contrib/primalRig/browser/`.
- Command `primalCode.openRig`; setting `primalCode.startPage.surface` with values
  `start` (default) | `rig` | `none`, so the user chooses which is the landing surface. The startup
  contribution in primalStart must consult this setting rather than a second startup contribution
  racing it — modify primalStart's runner, do not add a competing one.
- Styled from theme tokens only, so every vibe restyles it.

## Guardrails

- No new startup contribution racing Primal Start's.
- Nothing blocking on startup: every data read is either synchronous-cheap or deferred with a
  skeleton/empty state; no awaits before first paint.
- Disposables registered; listeners cleaned across setInput.
- Token-only colors, high-contrast opt-out, register any new CSS custom property in
  `build/lib/stylelint/vscode-known-variables.json`, add the contrib to `build/lib/i18n.resources.json`.
- Clean `npm run compile-client`; chat smoke test still passes.
