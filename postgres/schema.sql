-- Claude Code Session Memory - PostgreSQL Schema
-- Run this to set up the database

-- Main sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(36) PRIMARY KEY,  -- Claude Code session UUID

    -- Timestamps
    started_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Metadata
    git_branch VARCHAR(255),
    cwd TEXT,
    version VARCHAR(50),
    hostname TEXT,
    message_count INTEGER DEFAULT 0,

    -- Token usage (totals)
    input_tokens BIGINT DEFAULT 0,
    output_tokens BIGINT DEFAULT 0,
    cache_creation_tokens BIGINT DEFAULT 0,
    cache_read_tokens BIGINT DEFAULT 0,

    -- Extracted data (JSONB for flexibility)
    user_messages JSONB DEFAULT '[]'::jsonb,
    tools_used JSONB DEFAULT '[]'::jsonb,
    files_touched JSONB DEFAULT '[]'::jsonb,
    models_used JSONB DEFAULT '[]'::jsonb,
    model_tokens JSONB DEFAULT '{}'::jsonb,

    -- Full-text search
    search_text TEXT,
    search_vector TSVECTOR,

    -- Source file and sync checkpoint. source_size is the file size at the
    -- last read (equal size means unchanged); source_offset is the bytes
    -- consumed, up to the last complete line.
    transcript_path TEXT,
    source_size BIGINT,
    source_offset BIGINT,

    -- Optional classification (if you want to add LLM summaries later)
    summary TEXT,
    category VARCHAR(100),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_hostname ON sessions(hostname);

-- Full-text search index (GIN for performance)
CREATE INDEX IF NOT EXISTS idx_sessions_search_vector ON sessions USING GIN(search_vector);

-- JSONB index for the tools filter (tools_used ?| ...)
CREATE INDEX IF NOT EXISTS idx_sessions_tools_used ON sessions USING GIN(tools_used);

-- Full archival transcript: every JSONL line except api-request copies,
-- redacted, in rows of about 8 MB of source bytes ordered by start_offset.
-- Survives local JSONL cleanup. New lines are appended as new rows, so a
-- growing session never rewrites what is already stored. end_offset is NULL
-- for rows moved from the old single-value column by migration 004.
CREATE TABLE IF NOT EXISTS transcript_chunks (
    session_id VARCHAR(36) NOT NULL
        REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    start_offset BIGINT NOT NULL,
    end_offset BIGINT,
    lines JSONB COMPRESSION lz4 NOT NULL,
    PRIMARY KEY (session_id, start_offset)
);

-- Function to update search vector
CREATE OR REPLACE FUNCTION update_session_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.search_text, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(
            CASE
                WHEN jsonb_typeof(NEW.tools_used) = 'array' AND jsonb_array_length(NEW.tools_used) > 0
                THEN array_to_string(ARRAY(SELECT jsonb_array_elements_text(NEW.tools_used)), ' ')
                ELSE ''
            END, ''
        )), 'C') ||
        setweight(to_tsvector('english', COALESCE(
            CASE
                WHEN jsonb_typeof(NEW.files_touched) = 'array' AND jsonb_array_length(NEW.files_touched) > 0
                THEN regexp_replace(
                    array_to_string(ARRAY(SELECT jsonb_array_elements_text(NEW.files_touched)), ' '),
                    '[/\-_.]', ' ', 'g'
                )
                ELSE ''
            END, ''
        )), 'C') ||
        -- Also index the cwd for project-level searches
        setweight(to_tsvector('english', COALESCE(
            regexp_replace(NEW.cwd, '[/\-_.]', ' ', 'g'), ''
        )), 'D');
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update search vector
DROP TRIGGER IF EXISTS trigger_update_session_search_vector ON sessions;
CREATE TRIGGER trigger_update_session_search_vector
    BEFORE INSERT OR UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_session_search_vector();

-- Helper view for common queries
CREATE OR REPLACE VIEW session_stats AS
SELECT
    COUNT(*) as total_sessions,
    SUM(input_tokens) as total_input_tokens,
    SUM(output_tokens) as total_output_tokens,
    SUM(cache_creation_tokens) as total_cache_creation_tokens,
    SUM(cache_read_tokens) as total_cache_read_tokens,
    SUM(message_count) as total_messages,
    MIN(started_at) as earliest_session,
    MAX(ended_at) as latest_session
FROM sessions;

-- View for recent sessions
CREATE OR REPLACE VIEW recent_sessions AS
SELECT
    id,
    started_at,
    ended_at,
    git_branch,
    message_count,
    input_tokens,
    output_tokens,
    tools_used,
    files_touched,
    user_messages,
    summary,
    category
FROM sessions
WHERE ended_at > NOW() - INTERVAL '7 days'
ORDER BY ended_at DESC;
