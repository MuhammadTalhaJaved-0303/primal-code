# Primal Code wireframes — the brief

Design workstream for release 1.135.2 and the first-run/agent-task/return flows that follow it.
Everything in this folder is drawn from what is on `main` today (plus two parallel branches named
where used), not from what we wish shipped. Where a screen proposes something new, its callout says
"proposal" and names the decision the owner has to make.

## How to read these files

| File | What it is |
|---|---|
| `01-first-run.html` | Story 1, four screens: DMG open → Gatekeeper → Primal Start (FIRST RUN strip, VIBE, MOTIF) → Settings → first agent edit |
| `02-agent-task.html` | Story 2, four screens: landing with the session-aware model picker → stream → Changes review → apply / merge back |
| `03-resume.html` | Story 3, four screens: boot → The Rig as the return surface → sessions sidebar → "since you left" → IDE chat panel restore |
| `04-agents-window.html` | Landing + session view of the Agents window; where the motif stage may live; every model/provider state in words |
| `05-site.html` | Marketing site: hero with the positioning line, proof from real features, install with the unsigned warnings, docs entry |
| `06-usability-test.md` | Five-developer protocol: recruiting, tasks, timing marks, thresholds, how findings flow back here |

Every HTML page is self-contained (no external resources), monochrome, and printable (A4, one
screen per page). Each screen carries numbered callouts; the legend under the screen explains each
number and says whether the control is shipping (with the file it comes from) or proposed. State is
always written in words — "current", "done ✓", "waiting on you" — never encoded in hue, because the
owner is colour blind and because print and grayscale must survive.

Renders used for self-critique are in `/tmp/pc-wireframes/*.png` (not committed). Re-render with
the playwright-core script described at the end.

## The three user stories and how we will know they work

### Story 1 — "Install and make my first edit" (≤ 60 s from DMG open)

A developer downloads the DMG, opens it, and gets the agent to write one change to a file.

Success criteria (measured in `06`, marks T1a–T1d):
- 5/5 test participants complete it with no moderator help.
- 4/5 reach the first visible diff within 60 s of the download finishing, **excluding** the one-time
  agent SDK download, which is timed separately (it is fetched from GitHub on first use —
  `product.json agentSdks`, `agentHostDownloadProgress.ts` — and can exceed the whole budget alone).
- 0 silent moments: no keypress or click that produces nothing visible.
- The FIRST RUN strip's model card resolves to "done" by itself for anyone with a Claude Code login.

What the wireframe found: the budget is spent by three things we do not control in the UI — the
Gatekeeper "Not Opened" dialog on an unsigned build (~25 s via System Settings → Open Anyway), the
agent host's 30–50 s before it publishes models (the strip says "Looking for an existing setup…"
meanwhile), and the SDK download. Decisions D2, D6 and D4 are the three levers.

### Story 2 — "Start an agent task and review its diff"

A developer starts a task in the Agents window, watches the stream, reviews every changed file, and
lands (or discards) the change.

Success criteria (marks T2a–T2c):
- 5/5 pick an isolated session without being told the word "worktree" (the Isolation chip is enough).
- 5/5 open every changed file before applying (the review-progress line in `02` · Screen 3).
- 4/5 land the change and can say where it went; every outcome is one of the four sentences already
  in `applyChangesToParentRepo.ts`.
- 0 model/session mismatches reach the agent host: the picker only offers models the session can
  run, and a mismatch on Enter produces an inline notice with two remedies, never a no-op.

### Story 3 — "Come back tomorrow and pick up where I left off"

A developer relaunches the next day and continues a session.

Success criteria (marks T3a–T3b):
- 5/5 name their previous session within 30 s of relaunch.
- 4/5 correctly answer "what did the agent change and where is it now" from the "since you left"
  block, which is a filter over recorded events (last response, file list, last command), not a
  generated summary.
- The kind of the restored session (chat / agent · local / agent · worktree) is visible in the
  chat panel header at all times, which closes the "no visible session-type picker mid-session" debt.

## Surface consolidation — six concepts a newcomer meets today

| Concept | Where it lives in code | Recommendation |
|---|---|---|
| **Chat** (IDE panel) | `contrib/chat` with `chat.editor.localAgent.enabled` false; no `product.defaultChatAgent`; new panel chats route to agent-host-claude; the panel's own empty state reads "Delegate to @agent-host-claude" | **Merge into agent session.** With Copilot removed and the local harness off there is no in-core loop that can answer a "chat": every conversation already is an agent session, and BYOK chat models have no execution surface in the panel. Keep a no-edits mode via the SDK's "Plan Mode" approval level instead of a separate concept. The Agents window's "Chats" group has a show-when-empty setting — default it to hidden. |
| **Agent session** | `src/vs/sessions`, `agentSessions/`, `IAgentSession`; rendered by the sessions sidebar, The Rig rows (`primalRigSessions.ts`) and The Deck (`primalDeckSessions.ts` imports the Rig's rows) | **Stays.** It is the one unit of work every surface already renders with the same four status words (running / waiting on you / done / failed). |
| **Worktree** | Isolation option in `agentHostSessionConfigPicker.ts` ("New Worktree"); merge-back in `applyChangesToParentRepo.ts` (kill-switched, untested) | **Stays as an option, not a concept.** It is a chip on the session ("Isolation: New Worktree / this folder"), never a thing to learn first. It is only complete once the apply/merge button ships (D9). |
| **Primal Start** | `contrib/primalStart` EditorPane; now carries FIRST RUN (parallel branch), VIBE, MOTIF (PR #23), RECENT | **Stays** as the landing surface for new and returning windows. |
| **The Rig** | `contrib/primalRig`, same EditorPane plumbing as Start (rig-spec: "built on Primal Start's existing editor-pane plumbing"); its Projects list is by spec the replacement for Start's Recent list; setting `primalCode.startPage.surface` = start / rig / none | **Merge into Start.** Two landing pages plus a setting to choose between them is a decision no newcomer can make. Fold the Rig's Projects, Agent activity and Today sections into Start below the strip (Agent activity only when sessions exist; Today only when it is non-zero); keep `primalRigSessions.ts` because the Deck imports it; reduce the setting to `start / none`. |
| **The Deck** | `contrib/primalDeck`, toggled by ⌃⌘D; hides side bar and panel, keeps chat | **Stays as a keystroke, not a destination.** It is for watching a running session, and its vocabulary (▸ tool, ✎ edit, ✓ done) is the shared one. Keep it off the Start page, out of first run and out of the site nav; document it under "Agent sessions". |

Net effect: a newcomer learns three things — a project, a session (with an isolation option), and
the Start page. Everything else is a mode or a setting.

## Decisions the owner must make

1. **D1** — Ship a plain-text "READ ME FIRST.txt" inside the DMG with the Gatekeeper steps (same wording as the site).
2. **D2** — Pay for an Apple Developer ID + notarization and a Windows code-signing certificate. Removes 01 · Screen 1 entirely, saves ~25 s, and is the only fix for the scariest moment of the flow. Also unblocks Squirrel auto-update (update-notifier-spec).
3. **D3** — With no folder open, make "Open Project…" the primary action on Start and demote "New Agent Chat" to second.
4. **D4** — Guarantee the agent host restarts in place after a key is saved, so "restart Primal Code to finish" never appears in the first minute.
5. **D5** — Pre-trust folders the user opened through "Open Project…", or have the FIRST RUN "Start" card explain the Restricted Mode banner. Today the banner silently blocks the agent's shell tools.
6. **D6** — Bundle the Claude SDK in the installer, or start its download the moment Start appears so it overlaps reading time. Without one of these, story 1 cannot meet 60 s.
7. **D7** — Review gate before apply: hard (all files viewed), soft (warn), or none.
8. **D8** — Worktree lifecycle after apply: keep until "Discard worktree…", or auto-remove.
9. **D9** — Merge-back button wording ("Apply to project" vs "Merge into main") and confirm the plan to reuse the shipping merge changeset operation rather than reviving the kill-switched action.
10. **D10** — Show "yesterday" beside the Rig/Start "Today" count so a morning return does not open on a zero.
11. **D11** — A small motif control on the Agents window landing (that window has no status bar, so there is no "Motif Motion" item to pause it).
12. **D12** — Replace the upstream chat empty-state copy ("Delegate to @agent-host-claude … AI responses may be inaccurate") with one sentence in our voice.
13. **D13** — One source for the version string on the site (`links.ts` says 1.135.1, the release is 1.135.2): generate it from `latest.json`.
14. **D14** — Point in-app "Learn more" links (still code.visualstudio.com) at the four docs pages in `05` · Screen 4.
15. **D15** — The consolidation above: merge chat into session, fold the Rig into Start, keep the Deck as a keystroke.
16. **D16** — From the parallel branches, already flagged by their authors: the 60 s "Looking for an existing setup…" wait; the motif stage ceiling 14 % → 35 % and the World default; the six shipping vibes pinning hue-based diff colours (added vs deleted are indistinguishable for the owner — the monochrome row treatment in 01/02 is the proposed fix).
17. **D17** — Verify the site FAQ's "right-click → Open" instruction still works on the macOS versions we support; the wireframes draw the System Settings → Open Anyway path for macOS 15+.

## What changed after seeing the renders

- `01`: the first render showed two sizes I had invented ("~410 MB" app, "~90 MB" SDK); neither is
  shown to the user anywhere in the code, so both were removed. The added-line rule in the diff sat
  on top of the "+" glyph; padding added.
- `01`: after the sibling branch's real Start-page capture, the guide strip was redrawn as the
  shipped FIRST RUN strip (three cards stating done / now / next, "Keep Basalt", "Add a provider...",
  "Looking for an existing setup…"), the MOTIF row was added under VIBE with its real card texts,
  the action rows gained their keybinding hints, the status bar gained "AI Providers" and the vibe
  item, and the SDK download moved from inside the chat panel to the bottom-right notification
  where it really appears. Callouts on Screen 4 were then renumbered so on-screen order matches
  legend order (the toast is read last).
- `04`: the motif ceiling text was corrected from 14 % to 35 % once PR #23's body was read.
- All pages: at 1200 px the legends read comfortably at 12 px; A4 print puts one screen per page
  (checked by exporting each page to PDF). Nothing overflows horizontally.
- Not changed, noted: `02` · Screen 3's "Apply to project" gated button wraps its explanation onto a
  second line at 1200 px; acceptable in a wireframe, would be a tooltip in the product.

## What could not be grounded in the code

- The exact wording and behaviour of the macOS 15+ Gatekeeper dialog and the Windows SmartScreen
  dialog: drawn from general knowledge of those OS versions, not from anything in the repo.
- The FIRST RUN strip and the MOTIF row live in parallel branches, not in this worktree; they are
  drawn from the PR descriptions and one dev-build capture, and the 30–50 s model-publish timing is
  that branch author's measurement on the owner's machine.
- "Deny" as the third approval verb (the code has "Allow" / "Allow once"; the reject label comes
  from the SDK's schema).
- Whether the agent host reports a provider 401 distinctly (`04` · callout 12 degrades if not).
- The "main moved: N commits" line in `03` · Screen 3 needs a git ahead/behind read that does not
  exist yet; the wireframe says it is omitted when unavailable.
- "Create pull request" on the worktree toolbar: the Changes view's accessibility help mentions
  commit / merge / sync / create-PR actions "when available"; I did not find the provider that
  makes them available in this fork.
- The "161 generated themes" figure is from the brief; the theme-engine notes in memory say 21
  shipped at that time. The site wireframe says the number must come from the build output.
- Story 3's overnight condition itself: no code path distinguishes "next day" from "five minutes
  later" — the protocol simulates it and adds two true next-day follow-ups.

## Re-rendering

```
env -u ELECTRON_RUN_AS_NODE node <scratchpad>/wf-shot.mjs        # PNGs to /tmp/pc-wireframes/
env -u ELECTRON_RUN_AS_NODE node <scratchpad>/wf-pdf.mjs         # A4 print check
```

Both scripts import `chromium` from `primal-code/node_modules/playwright-core/index.mjs` and launch
the cached headless shell by explicit `executablePath`; they open files only, never an app window.
