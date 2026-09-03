# ADR 0007: Local Codex title backchannel

Date: 2026-09-03
Status: Accepted

## Context

Backdrop failures are easiest to report while the affected title is still playing.
Copying the displayed title by hand loses the active provider order, whether artwork
was enabled, the resolver's matched media ID, and whether the player actually showed
a backdrop. The repository already has a persistent loopback Node API for local
development and Codex exposes a local command for queuing a message into an existing
task.

A browser must not receive Codex credentials or an unrestricted way to inject turns.
The feature must also be absent from the deployed player, where a public visitor's
click must never contact a developer tool.

## Decision

Add `/api/backchannel` only to `installer/local_api_server.js`. The local launcher
binds it to the current `CODEX_THREAD_ID`, or an explicitly supplied task UUID, and
generates a new random pairing code for each server run. The first title click asks
for that code and stores it only in the tab's `sessionStorage`.

The endpoint:

- remains reachable only through the API server bound to `127.0.0.1`;
- accepts browser origins only from the configured loopback site origin;
- requires the pairing code as a bearer capability for every report;
- accepts a small, schema-validated JSON body containing only current playback,
  provider, backdrop-state and sanitized resolver-result fields;
- applies a single-request lock and a short cooldown; and
- invokes `codex queue` without a shell, targeting only the server-configured task
  and repository root.

The queued message treats the report as untrusted data. It asks the existing task to
diagnose the case, preserve unrelated worktree changes, implement and test a minimal
regression fix when warranted, and only then create a Conventional Commit and push
the current branch. A genuine catalog miss must not produce a fabricated fix or an
empty commit.

The player derives the endpoint only when both its own hostname and the configured
art API hostname are loopback addresses. Otherwise it does not add click or keyboard
semantics to the title. Local resolver responses are reduced to media ID/title/type,
selected backdrop URL/source and the exact sanitized request fields; provider keys
and the Codex task ID never enter the report.

## Consequences

- A title can be reported with one click after a one-time pairing step per tab and
  local server run.
- Codex authentication remains owned by the installed Codex CLI and desktop app;
  no OpenAI credential is copied into page code or browser storage.
- Starting the preview outside a Codex task leaves the backchannel disabled unless a
  task UUID is supplied explicitly. Ordinary local preview and all production paths
  continue to work without Codex.
- Queuing succeeds independently of how long the diagnostic/fix turn takes. Progress
  and any exceptional approval remain visible in the target Codex task.
- Restarting the local preview launcher invalidates the pairing code, so the next
  click pairs again. Watch-mode child restarts keep the code for that launcher run.
  This bounds the capability lifetime without interrupting resolver-edit cycles.

## Alternatives considered

- **Put an OpenAI API key in the browser.** Rejected because it exposes credentials
  and would create a new task rather than reliably continue the local Codex task.
- **Resume the task through `codex exec`.** Rejected because the desktop task already
  has a live local session; `codex queue` is the narrower operation designed to add a
  message to that session.
- **Accept every loopback POST without pairing.** Rejected because hostile webpages
  can probe localhost. Origin validation is useful but the short-lived bearer
  capability provides the deliberate user authorization boundary.
- **Ship the endpoint in the deployed API.** Rejected because the task binding and
  developer automation are strictly local concerns.
