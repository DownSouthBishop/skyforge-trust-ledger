# MCP Connections — Full Build

This is a large multi-section build. Confirming scope before executing so we don't waste tokens on the wrong direction.

## What gets built

### 1. Database migrations
- Add `category`, `icon_url` columns to existing `atlas_mcp_connections` (table already exists from prior work — the schema in the prompt is a re-spec; will additively migrate).
- New table `mcp_directory` (seeded with ~35 entries across Dev / Productivity / Communication / Finance / Browser / AI / Storage).
- New table `cowork_activity_log` (user-scoped, RLS).
- New table `atlas_preferences` (one row per user, holds `claude_code_config` and `cowork_config` jsonb).

### 2. Edge function
- Rewrite/extend `atlas_mcp_ping` per spec (already mostly correct — confirm JSON-RPC `tools/list`, return `{ok, tools, error}`).

### 3. ProfilePage — MCPConnectionsTab rewrite
Replace the current preset-library UI with a real, wired implementation:

- **Top bar:** "Download MCP Config" button → generates `claude_desktop_config.json` with masked secrets, includes claude-code + cowork entries.
- **Claude Code card** (first-class, gradient top border):
  - Project Path, Mode selector (read-only / read+edit / full autonomy), Auto-sync toggle.
  - Saves to `atlas_preferences.claude_code_config`.
  - Copy-config block, Test Connection button (calls atlas_mcp_ping against any claude-code slug if present).
- **Cowork card** (first-class, gradient top border):
  - Watched Folders list-builder, Sync Interval selector, Auto-brief toggle, Allowed Actions checkboxes.
  - Saves to `atlas_preferences.cowork_config`.
  - Activity feed reads last 10 rows from `cowork_activity_log`.
- **Connected MCPs grid:** live data from `atlas_mcp_connections`. Each card has Ping / Enable-Disable toggle / Edit / Remove (with confirm).
- **Add / Edit form:** transport toggle, env-var builder with masked saved-values + Clear & Re-enter, required-var pre-fill from directory entry, upsert + auto-ping on save.
- **MCP Directory:** search + category pills, responsive card grid from `mcp_directory`, Connect button pre-fills the add form and scrolls to it. Connected entries show "Connected ✓" disabled.

### 4. Atlas awareness
- `agent-chat` already injects `CONNECTED TOOLS` from `atlas_mcp_connections`. Extend it to also pull `atlas_preferences` and inject `DEVELOPMENT ENVIRONMENT` block when claude_code_config or cowork_config exist.
- Same change in `forge_chat` and `telegram-bridge` for parity.

### 5. Soul memory
- Capability writes already happen via existing `mcp_to_memory` trigger — confirm it covers the new fields. No additional code needed for nightly Soul.md (no `agent_soul_write` function exists yet — flagged in earlier turn, still skipping unless requested).

## What is intentionally NOT built
- Nightly Soul.md write (no host function exists).
- Real Cowork/Claude-Code desktop daemon — only the config + display layer the operator copies into Claude Desktop. The Activity Feed reads whatever rows land in `cowork_activity_log` (the desktop side writes them).
- Per-env-var encryption-at-rest beyond what Supabase already provides; values are write-only from the frontend (never returned, displayed as `●●●●●●●● (saved)`).

## Files touched
- **New migration:** add columns + 3 new tables + seed directory.
- **Edited:** `src/components/MCPConnectionsTab.tsx` (major rewrite), `supabase/functions/agent-chat/index.ts`, `supabase/functions/forge_chat/index.ts`, `supabase/functions/telegram-bridge/index.ts`, `supabase/functions/atlas_mcp_ping/index.ts` (minor cleanup).
- **New types** appear automatically in `src/integrations/supabase/types.ts` after migration.

## Heads-up
This is ~1500 lines of new/changed code and will take multiple tool calls. The directory seeding alone is ~35 rows. Approve and I'll execute straight through.