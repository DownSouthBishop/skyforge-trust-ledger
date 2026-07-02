# STATE.md — Daily Triage Loop

Loop-engineering-style state file (pattern borrowed from github.com/cobusgreyling/loop-engineering,
implemented natively — no external tool/package installed).

## Cadence

Daily, 13:17 UTC, via GitHub Actions: [`.github/workflows/daily-triage.yml`](.github/workflows/daily-triage.yml).
Level **L1 — report-only**. Runs on GitHub's own infrastructure, so it's real and persistent —
not tied to any local machine or Claude Code session being open.

## What this loop checks

- `npx tsc --noEmit -p tsconfig.app.json` passes
- `npm run build` passes
- No new raw `window.speechSynthesis.cancel()` calls outside `src/lib/agent-voice.tsx` beyond the
  known baseline of 3 (regression guard for the Closed Chamber TTS cutoff fix — see commit `9c5ec57`)
- Count of duplicate `const SUPABASE_URL = "..."` declarations (informational — logged, doesn't fail the run)

## Human gate

Report-only. The workflow never auto-fixes code, never commits, and never pushes anything —
it only writes to its own GitHub Actions run summary. It fails the run (which triggers GitHub's
default email notification to repo watchers) only when the raw-cancel regression guard trips.
Everything else is informational. A human decides what, if anything, to act on.

Session-based runs (when Claude reviews this repo directly) may also append a row to
`loop-run-log.md` and commit it — that's a manual, human-initiated action, not automatic.

## Kill switch

Disable or delete `.github/workflows/daily-triage.yml`, or disable the workflow from the
repo's Actions tab on GitHub.

## History

- 2026-07-01: started as a session-scoped Claude Code cron job (job `908b1303`) — discovered
  that job was not actually durable (didn't survive session end despite `durable: true`).
  Replaced same day with the GitHub Actions workflow above for a genuinely persistent loop.
