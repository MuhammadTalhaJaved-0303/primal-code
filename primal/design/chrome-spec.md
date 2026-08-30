# Primal Chrome — structural identity spec

The vibes changed the paint; this changes the bones. Goal: a screenshot of Primal Code should not
be mistakable for VS Code even in grayscale. Two workstreams, both additive (new files in our own
dirs; upstream CSS/TS untouched except listed default flips).

## The look: "Slab"

Surfaces float as rounded slabs on a recessed ground (the Cursor Glass / Warp direction, done in
our monochrome-first language):

1. **Ground**: the window ground is the vibe's `chromeBg`. Title bar and status bar sit ON the
   ground — no borders, same color, so top and bottom read as one continuous frame.
2. **Slabs**: the editor area, sidebar content, auxiliary bar (chat), and bottom panel are slabs —
   vibe `editorBg`, 10px top corner radius, 1px vibe `border`, inset from the frame so ground
   shows around them. No hard 1px full-height part borders anywhere.
3. **No left icon rail**: activity bar moves to the top of the sidebar (`workbench.activityBar.location: "top"`
   default flip) — kills the single most recognizable VS Code silhouette.
4. **Tabs**: pill tabs — compact rounded rectangles with 6px radius sitting on the slab, gap
   between them, active = raised contrast, no full-width tab-strip underline, no per-tab top border.
5. **Status bar**: slim (22px), ground-colored, item hover = subtle pill.
6. **Quietness**: fewer hairlines everywhere — where upstream draws borders between parts, prefer
   ground-gap separation.

Implementation: ONE new stylesheet `src/vs/workbench/contrib/primalVibes/browser/media/primalChrome.css`
imported from the primalVibes contribution (standard `import './media/primalChrome.css'` pattern).
It loads after the parts CSS, so ordinary specificity wins. Everything keys off existing stable
part classes (`.part.editor`, `.part.sidebar`, `.part.auxiliarybar`, `.part.panel`,
`.part.titlebar`, `.part.statusbar`, `.monaco-workbench`) and ONLY uses `var(--vscode-*)` tokens —
never literal colors — so all six vibes and user themes keep working. High-contrast themes must
opt out: guard rules with `.monaco-workbench:not(.hc-black):not(.hc-light)`.

Do not change part layout TS. Radius/inset is faked visually (radius + borders + background
layering on the parts' inner containers, which are normal-flow), not by resizing grid cells.

## The start page: "Primal Start"

The Getting Started welcome page is the loudest "this is VS Code" template on screen. Replace it:

- New contribution `src/vs/workbench/contrib/primalStart/browser/` — an EditorPane (model on
  primalSettings editor) that is the default startup editor.
- Content, all vibe-token styled, generous whitespace, Primal wordmark set in Public Sans
  semibold:
  - Hero: wordmark + one-line tag ("The agent-native code editor").
  - Primary actions (large, keyboard-hinted): **New Agent Chat** (opens the chat panel/new
    session), **Open Project…**, **Clone Repository…**.
  - **Vibe strip**: the six vibes as clickable swatch cards (mini palette preview built from the
    theme seed colors); click applies the vibe via IPrimalVibeService; current vibe marked.
  - Recent projects list (from IWorkspacesService recentlyOpened), plain rows, path dimmed.
  - Footer line: keyboard shortcuts cheat row (Ctrl+Cmd+. vibes · Cmd+K Cmd+V picker ·
    Ctrl+Cmd+I chat).
- Wiring: flip `workbench.startupEditor` default to `none` and add our own startup contribution
  that opens Primal Start for new/empty windows (mirror the conditions in
  welcomeGettingStarted's startupPage.ts: only when no restored editors, not skipped by settings).
  Setting `primalCode.startPage.enabled` (default true) to opt out. The old Get Started page stays
  available via its command for walkthroughs.

## Default flips (settings, user-overridable)

| Setting | New default |
|---|---|
| `workbench.activityBar.location` | `top` |
| `workbench.startupEditor` | `none` (Primal Start takes over) |
| `window.commandCenter` | stays on |

## Guardrails

- All six vibes + one non-vibe theme (Monokai) + HC dark must render sanely (screenshot each).
- Chat PONG smoke test after integration.
- No edits to `src/vs/workbench/browser/parts/**` or layout TS.
- Grayscale test: a Basalt screenshot converted to grayscale must still not silhouette-match VS Code.
