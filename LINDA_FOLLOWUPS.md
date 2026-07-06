# Linda Pipeline — Follow-ups

Tracking doc for what's left after the 2026-07-04 lead-lifecycle pipeline build (migrations
`20260704000003`/`20260704000004` + edge functions deployed same day). Check items off as
they're done; this is a plain file, not the in-app Notebook DB feature.

## Urgent

- [ ] **Rotate the Supabase Personal Access Token** pasted in chat on 2026-07-04
      (`sbp_ca70a...`). Account → Access Tokens → revoke, generate a new one. It was never used
      (the CLI was already authenticated + linked to `hycpzeskartlkybsfkbh` separately), but
      treat it as burned since it hit conversation history.

## Required for inbound reply ingestion to actually work

- [ ] **Enable IMAP on the Gmail account** used for `GMAIL_ADDRESS`/`GMAIL_APP_PASSWORD` —
      Gmail Settings → Forwarding and POP/IMAP → Enable IMAP. `linda-inbox-sync` will fail
      IMAP login until this is on.
- [ ] Confirm `linda-inbox-sync`'s first cron run completed (check Supabase function logs) —
      it only baselines the UID cursor on first run and won't process any inbox backlog.
      After that, it polls every 15 min (`linda-inbox-sync` cron job).
- [ ] Send one real test reply to a test lead's address and confirm: a row lands in
      `linda_reply_log`, the matching `linda_responses` row gets `replied_at`, the lead's
      `status` advances, and a drafted reply appears in Linda's Inbox as `pending_approval`.

## Worth watching (not broken, just unverified live)

- [ ] Send one real approved email and confirm `linda_responses.opened_at` populates via the
      `linda-track-open` tracking pixel once opened.
- [ ] Watch `linda_pipeline`'s next daily run (8am) — confirm the new 3-touch cadence drafts
      land in `linda_responses` (not the old dead-end `outbound_actions` path) and that a lead
      auto-moves to `nurturing` after touch 3 with no reply.
- [ ] Spot-check `/linda/dashboard` and `/linda/icp` in the browser against real data once
      leads/responses/deals exist to compute against.

## Deployed already (2026-07-04)

- Migrations `20260704000003_linda_pipeline_extensions.sql`,
  `20260704000004_linda_inbox_sync_cron.sql` — pushed via `supabase db push`.
- Functions `linda-track-open`, `linda-inbox-sync`, `linda-prospect-intake`, `linda_pipeline`,
  `linda-chat`, `linda-send-email` — deployed via `supabase functions deploy`.
- Confirmed `linda-track-open` deployed with `verify_jwt: false` (required — mail clients don't
  send a Supabase JWT when loading the pixel).
