BEGIN;

CREATE TABLE IF NOT EXISTS facebook_exports (
    id TEXT PRIMARY KEY,
    export_date DATE NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('html', 'json')),
    timezone TEXT NOT NULL,
    source_root TEXT NOT NULL,
    manifest JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS facebook_conversations (
    id TEXT PRIMARY KEY,
    export_id TEXT NOT NULL REFERENCES facebook_exports(id),
    source_thread TEXT NOT NULL,
    title TEXT NOT NULL,
    UNIQUE (export_id, source_thread)
);
CREATE INDEX IF NOT EXISTS idx_facebook_conversations_export ON facebook_conversations(export_id);

-- These are source display names, not verified person identities.
CREATE TABLE IF NOT EXISTS facebook_participants (
    conversation_id TEXT NOT NULL REFERENCES facebook_conversations(id),
    name TEXT NOT NULL,
    PRIMARY KEY (conversation_id, name)
);
CREATE INDEX IF NOT EXISTS idx_facebook_participants_name ON facebook_participants(name);

CREATE TABLE IF NOT EXISTS facebook_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES facebook_conversations(id),
    sender TEXT,
    content TEXT NOT NULL,
    sent_at TIMESTAMPTZ,
    sent_local TIMESTAMP NOT NULL,
    precision TEXT NOT NULL CHECK (precision IN ('minute', 'millisecond')),
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_file TEXT NOT NULL,
    source_order INTEGER NOT NULL CHECK (source_order >= 0),
    payload JSONB NOT NULL,
    search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('simple', COALESCE(sender, '') || ' ' || content)
    ) STORED,
    UNIQUE (conversation_id, source_order)
);
CREATE INDEX IF NOT EXISTS idx_facebook_messages_conversation_date
    ON facebook_messages(conversation_id, sent_local, source_order DESC);
CREATE INDEX IF NOT EXISTS idx_facebook_messages_conversation_instant
    ON facebook_messages(conversation_id, sent_at, source_order DESC);
CREATE INDEX IF NOT EXISTS idx_facebook_messages_search ON facebook_messages USING GIN(search_vector);

COMMIT;
