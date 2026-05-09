ALTER TABLE forge_messages
ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT NULL;