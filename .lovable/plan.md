# Atlas Omniscience — Full Read/Write Across Skyforge

Atlas already runs server-side with the service role key, so it technically *can* touch every table. The work is making it actually **see** every tab's data on each turn, **write** to any tab from chat, and **auto-ingest** anything the user uploads anywhere in the app so it surfaces instantly in conversation.

## 1. Expand Atlas's read context (database)

Rewrite `get_forge_context(_user_id)` to return the full operator picture, not just receipts + CRM:

- `user_profile` — full row (name, bio, trajectory, stage, last_seen)
- `receipts_ledger` — last 25 receipts (all states), aggregate stats (already there)
- `skyforge_clients` — top 10 by spend + all CRM opportunities
- `arsenal_items` — last 20 items (title, type, content excerpt, win/use counts)
- `arsenal_results` — last 20 logged results
- `directives_daily` — last 14 days
- `forge_directives` — active (non-dismissed) directives
- `forge_sticky_memory` — full row

Keep payload bounded (~30–50 KB) by trimming long text fields to ~500 chars.

## 2. Expand Atlas's write powers (edge function tool calls)

In `supabase/functions/forge_chat/index.ts`, add a tool-calling pass **before** the streaming reply:

- Tools exposed to the model:
  - `create_receipt`, `update_receipt`
  - `create_arsenal_item`, `update_arsenal_item`, `log_arsenal_result`
  - `create_directive`, `complete_directive`, `dismiss_forge_directive`
  - `upsert_client`, `update_client_followup`
  - `update_sticky_memory`, `update_user_profile`
- Each tool runs against Supabase with the service role key, scoped to the authenticated `user_id`.
- Tool results are appended to the message history, then Atlas streams the final natural-language reply (Claude Sonnet 4.5, same persona).

Model switch: tool-calling pass uses `tool_choice: "auto"` and a non-stream call; the user-facing reply stays streamed.

## 3. Auto-ingest uploads into Atlas memory

Today, file attachments only travel with the chat message they were sent in. To make uploads from *any* tab auto-flow into Atlas:

- Add a single new table `atlas_memory_events` (user_id, source_tab, event_type, summary, payload jsonb, created_at).
- Whenever any tab (Vault, Arsenal, Dossier, Positions, Intel, Markets, HUD, Profile) accepts a file upload or significant write, the frontend writes a row into `atlas_memory_events` with a short summary and the attachment refs.
- `get_forge_context` includes the **last 30 memory events**, so Atlas sees them on the next turn without any extra plumbing.
- Existing `forge_chat` attachments path still works for in-chat uploads; those also get mirrored as a memory event.

For this iteration, I'll wire the memory-event logger as a small shared helper (`src/lib/atlasMemory.ts`) and call it from the file-upload sites that already exist. New tabs adding uploads later just call the helper.

## 4. Scope of changes

```text
Database
  └─ migration: create atlas_memory_events + RLS, replace get_forge_context

Edge function
  └─ supabase/functions/forge_chat/index.ts
       • new tools array + tool-call dispatcher
       • two-pass model call (tools, then stream)

Frontend
  ├─ src/lib/atlasMemory.ts             (new — logEvent helper)
  ├─ src/pages/ForgePage.tsx            (mirror chat uploads to memory)
  └─ wire logEvent into existing upload/write sites:
       VaultPage, ArsenalPage, DossierPage, PositionsPage,
       IntelPage, MarketsPage, HudPage, ProfilePage
       (only the spots that already accept user input today)
```

## 5. Out of scope (call out for later if you want)

- No new upload UI is added on tabs that don't already have one.
- No vector embeddings / semantic search — Atlas reads recent events in raw form. If memory grows past ~30 events per turn, we'd add a summarizer + embeddings.
- No realtime push from tab → open chat session; Atlas picks up new events on the next message (which is effectively instant).

## Confirm before I build

- OK to add the `atlas_memory_events` table + tool-calling pass as described?
- Any tab you specifically *don't* want Atlas to write to (e.g. should `receipts_ledger` stay user-only)?
