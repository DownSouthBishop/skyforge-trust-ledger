-- atlas_browser_commands was Atlas-only; browser_action is being extended to
-- every agent (Linda, Janus, Izzy, future spawns) via agent-chat/linda-chat.
-- Record which agent queued each command so receipts attribute correctly.
ALTER TABLE public.atlas_browser_commands ADD COLUMN agent TEXT NOT NULL DEFAULT 'atlas';
CREATE INDEX atlas_browser_cmds_agent ON public.atlas_browser_commands (agent, status);
