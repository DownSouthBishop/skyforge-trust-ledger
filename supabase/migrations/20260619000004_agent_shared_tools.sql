-- ══════════════════════════════════════════════════════════════════
-- AGENT SHARED TOOLS — all four agents
-- Registers web_scrape, web_research, recall_memory, store_memory
-- in every agent's capabilities array.
-- Tools are executed natively in agent-chat — no external services.
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users
    WHERE email = 'skyforgeai.studio@gmail.com' LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'User not found — skipping tool registration';
    RETURN;
  END IF;

  UPDATE public.skyforge_agents
  SET
    capabilities = COALESCE(capabilities, '[]'::jsonb) || '[
      {
        "name": "web_scrape",
        "description": "Fetch and read the full content of any URL — articles, documentation, live data, competitor pages, research papers. Returns clean text.",
        "examples": ["Read this article", "What does this page say?", "Pull the content from this URL"]
      },
      {
        "name": "web_research",
        "description": "Search the web for current information on any topic using Google Search grounding. Best for recent news, market data, product releases, or anything that may have changed. Returns a synthesized, grounded summary.",
        "examples": ["What is happening with X right now?", "Research the latest on Y", "Find recent news about Z"]
      },
      {
        "name": "recall_memory",
        "description": "Search long-term semantic memory for information related to a query. Retrieves the most relevant memories, past decisions, and accumulated knowledge from prior sessions across all agents.",
        "examples": ["What do I know about this?", "Have we discussed X before?", "Recall what you know about the operator''s position on Y"]
      },
      {
        "name": "store_memory",
        "description": "Commit important information, insights, or decisions to long-term memory so they are available in future sessions. Use after significant discoveries, operator decisions, or things explicitly worth remembering.",
        "examples": ["Remember this for later", "Store this decision", "Log this insight"]
      }
    ]'::jsonb,
    updated_at = now()
  WHERE user_id = v_user_id
    AND slug IN ('atlas', 'janus', 'linda', 'izzy');

  RAISE NOTICE 'Shared tools registered on atlas, janus, linda, izzy';
END $$;
