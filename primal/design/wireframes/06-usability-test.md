# 06 — Usability test protocol: five developers, three stories

Companion to the wireframes in this folder. Run it against the packaged build (DMG / exe from
the release page), never a dev instance: the Gatekeeper dialog, the SDK download and the
first-run strip only behave truthfully in the packaged app.

## Participants (five)

Recruit developers who match all of the "must" rows and, between them, cover every "spread" row.

| | Criterion |
|---|---|
| must | Uses VS Code (or a fork) daily; has never opened Primal Code; comfortable being recorded |
| must | Has at least one of: an active Claude Code login on their machine, an Anthropic key, an OpenAI key |
| spread | 2 with a Claude Code login and no key · 2 with an API key and no login · 1 with neither (they receive a test key from us at task 1, step 3 — this is the "worst-case newcomer") |
| spread | 3 on macOS 15 or later, 2 on Windows 11 |
| spread | At least 1 participant with a colour-vision deficiency (self-reported); the wireframes are monochrome, the app's themes are not yet |
| exclude | Anyone who has contributed to the repo, seen a demo, or read the site in the last 30 days |

Each session: 45 minutes, one moderator, one note-taker, remote or in person, screen + audio
recorded with consent. Participants use their own machine with a fresh OS user account (or a
freshly reset one) so no earlier install, trust decision or key exists.

## Setup checklist (before each session)

- Fresh OS account; no `Primal Code.app`, no `~/Library/Application Support/Primal Code`, no keychain item for Primal Code.
- The participant's Claude Code login, if any, is present in that account (they sign in to Claude Code themselves before we start).
- A small public repo cloned to `~/code/acme-api` with a failing test in `test/auth.spec.ts` (the same repo for everyone).
- Release page open in a browser; stopwatch; the note-taking sheet below.
- Moderator script printed. Do not open the app yourself at any point.

## Tasks

Read each task aloud exactly as written. Say nothing else until the participant asks for help
or the time cap passes. Log every help request as a failure of that step.

**Task 0 — positioning (2 min).** Show the site hero (05 · Screen 1) for 20 seconds, then hide it.
Ask: "What would you have to pay for?" and "Do you need an account?" Record answers verbatim.

**Task 1 — install and first edit (cap 10 min; story 1).**
"Install Primal Code from this page, open `~/code/acme-api`, and get the agent to make one
change to `src/app.ts` — any change you like." Start the stopwatch when the DMG or exe download
finishes. Record the split times listed below.

**Task 2 — agent task and diff (cap 15 min; story 2).**
"Ask the agent to fix the failing test in `test/auth.spec.ts`, in a way that keeps your working
copy untouched until you have looked at the change. Then review what it changed and put it into
the project." Do not say "worktree", "session" or "apply".

**Task 3 — come back (cap 5 min; story 3).**
Quit the app fully. Wait two minutes with the screen off (stand-in for "tomorrow"; a true
overnight return is run with two of the five participants as a follow-up call the next day).
"Open Primal Code again and carry on with what you were doing." Ask, after they stop: "What
did the agent change while you were away, and where is it now?"

**Task 4 — vocabulary probe (3 min, after task 3).**
"In your own words, what is the difference between a chat, an agent session and a worktree
here?" then "What is the Start page for, and what is The Rig for?" (The Rig is reached via the
command palette; if they never saw it, ask about the Start page only and record that.)

**Task 5 — recovery (2 min).** "Where do you go if a model stops answering?" Record the first
place they click.

## Timing marks to record

| Mark | Task | Start | Stop |
|---|---|---|---|
| T1a | 1 | download finished | app first visible (after Gatekeeper / SmartScreen) |
| T1b | 1 | app first visible | FIRST RUN strip's model card reads "done" (or key saved) |
| T1c | 1 | project opened | first prompt sent |
| T1d | 1 | first prompt sent | first diff visible (includes any SDK download — record its duration separately) |
| T2a | 2 | task read | prompt sent with a worktree/isolated session chosen |
| T2b | 2 | agent reports done | every changed file opened in a diff |
| T2c | 2 | review finished | change is in the project (apply / merge / keep) |
| T3a | 3 | app relaunched | participant names their previous session aloud |
| T3b | 3 | session opened | participant answers "what changed and where" correctly |

## What else to record

- Every hesitation longer than 5 seconds: what was on screen, what they said.
- Every wrong turn: the control they used instead of the intended one (map to a wireframe callout).
- Every silent moment: a keypress or click that produced no visible response (the Enter no-op class of bug).
- Which Gatekeeper path they took (Done → System Settings / right-click Open / xattr / gave up).
- Whether the Restricted Mode banner was noticed, and whether "Trust" was pressed before or after the agent failed to run a command.
- Words the participant uses for each surface, verbatim (feeds the surface consolidation in README).
- Single Ease Question (1–7) after each task; SUS at the end.
- For the colour-vision participant: every place they say "I can't tell which is which" (diff rows, status, vibe cards).

## Pass / fail thresholds

| Story | Passes when |
|---|---|
| 1 install → first edit | 5/5 complete task 1 without moderator help. 4/5 reach T1d ≤ 60 s **excluding** the SDK download (its duration is reported separately and is the evidence for decision D6). 5/5 see the download progress while it runs. 0 silent no-ops in the whole task. |
| 2 agent task → diff → apply | 5/5 choose an isolated session without being told the word (T2a). 5/5 open every changed file (T2b) — the review-progress line in 02 · Screen 3 is the design under test. 4/5 land the change and can say where it went (T2c). 0 occurrences of a model/session mismatch reaching the agent host. |
| 3 come back | 5/5 name their session within 30 s of relaunch (T3a). 4/5 answer "what changed and where" correctly (T3b). |
| positioning | 5/5 answer both task-0 questions correctly ("nothing beyond my provider", "no account"). |
| vocabulary | ≥ 3/5 give a workable distinction between chat / agent session / worktree. Fewer than 3 confirms the consolidation proposal in README (merge chat into agent session). |
| recovery | 4/5 reach the providers page (status item, strip or command) on the first click. |

A story that misses one threshold is "revise"; two or more, "redesign". Severity per finding:
S1 blocks the task · S2 wrong turn or error · S3 hesitation only.

## Feeding findings back into the wireframes

1. Every finding is written as one line: `S<severity> · task · timing mark · callout <file>·<n> · what happened · quote`.
2. Findings are grouped by callout. A callout with two or more S1/S2 findings is redrawn; the
   screen gets a new revision letter in its header (e.g. "Screen 3 · rev B") and the README
   changelog gains a row: date, file, callout, finding, change made.
3. Findings that hit no callout are a missing screen: add it to the relevant file before redrawing anything else.
4. Findings about shipping strings (copy, not layout) go straight to a decision line in README for the owner, with the participant's quote.
5. Re-test only the revised tasks with two new participants; the full five-person round runs again only after a "redesign" verdict.
6. Split times (T1a–T3b) are kept in `usability-runs.csv` next to this file, one row per participant per mark, so later rounds compare against the first.

## Moderator script (verbatim openers)

- "You are trying a new editor for the first time. Think aloud. I will not help unless you are stuck for more than a minute; if you ask, I will answer, and I will note that you asked."
- On a Gatekeeper / SmartScreen dialog: say nothing. If they ask, say "Do what you would normally do."
- On a silent Enter: say nothing for 30 seconds, then ask "What do you expect happened?"
- Close: "If you could change one thing about the first minute, what would it be?"
