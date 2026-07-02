# STATE.md — Daily Triage Loop

Loop-engineering-style state file (pattern borrowed from github.com/cobusgreyling/loop-engineering,
implemented natively via this environment's own cron/scheduling — no external tool installed).

## Cadence

Daily, ~9:13am local. Level **L1 — report-only**. Run history: `loop-run-log.md`.

## What this loop checks

- `npx tsc --noEmit -p tsconfig.app.json` passes
- `npm run build` passes
- No new raw `window.speechSynthesis.cancel()` calls outside `src/lib/agent-voice.tsx`
  (regression guard for the Closed Chamber TTS cutoff fix — see commit `9c5ec57`)
- Count of duplicate `const SUPABASE_URL = "..."` declarations hasn't grown past the known baseline (7 files)
- Whether `origin/main` HEAD has moved from commits made outside this loop's own session
  (this repo has a history of external tools/sessions pushing directly to `main`)

## Human gate

Report-only. The loop never auto-fixes code, never commits, and never pushes anything on
its own — findings are appended to `loop-run-log.md` locally and summarized to the operator.
A human decides what, if anything, to act on.

## Kill switch

Ask Claude to run `CronList` / `CronDelete` to remove the job, or just delete this file —
the loop has no other footprint.

## Known limitation

This loop is scheduled via the Claude Code session's in-memory cron (job `908b1303`,
daily ~9:13am local) — it is **session-scoped, not durable**: it stops firing as soon as
this Claude Code session ends, and even if the session stays open, recurring jobs
auto-expire after 7 days regardless. It is not a real cron/systemd job outside this
environment. To get a truly persistent loop, this would need to run as an actual
scheduled task on a machine that's always on (e.g. Windows Task Scheduler, or a GitHub
Actions workflow like the reference repo's `daily-triage.yml`) invoking the checks in
this file directly — ask for that if you want it to survive across sessions.
