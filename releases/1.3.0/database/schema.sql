CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  product TEXT NOT NULL,
  product_subcategory TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  sendings_via TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  ticket TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notes_active_updated_idx ON notes (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notes_product_idx ON notes (product) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS note_versions (
  id BIGSERIAL PRIMARY KEY,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  product TEXT NOT NULL,
  product_subcategory TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  sendings_via TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  ticket TEXT NOT NULL DEFAULT '',
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS note_versions_note_idx ON note_versions (note_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  product TEXT NOT NULL,
  status TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '',
  cause TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS incidents_active_updated_idx ON incidents (updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
