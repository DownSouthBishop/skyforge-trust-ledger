-- Add trading profile fields to forge_dossier
ALTER TABLE forge_dossier
  ADD COLUMN IF NOT EXISTS preferred_asset_classes text,
  ADD COLUMN IF NOT EXISTS risk_tolerance           text,
  ADD COLUMN IF NOT EXISTS trading_goals            text,
  ADD COLUMN IF NOT EXISTS max_drawdown_pct         text,
  ADD COLUMN IF NOT EXISTS preferred_pairs          text;
