-- Class sessions and results (permanent copy for history and CSV export).
-- Apply locally:  npx wrangler d1 migrations apply copd-sim-results --local
-- Apply to Cloudflare:  npx wrangler d1 migrations apply copd-sim-results --remote

CREATE TABLE IF NOT EXISTS sessions (
    code        TEXT PRIMARY KEY,
    course      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,   -- ms since epoch
    closed_at   INTEGER             -- NULL while open
);

CREATE TABLE IF NOT EXISTS results (
    session_code   TEXT NOT NULL,
    pair_code      TEXT NOT NULL,
    attempt        INTEGER NOT NULL,
    patient_name   TEXT NOT NULL DEFAULT '',   -- optional nickname, max 20 chars
    observer_name  TEXT NOT NULL DEFAULT '',
    points         INTEGER NOT NULL,
    energy         INTEGER NOT NULL,
    elapsed_ms     INTEGER NOT NULL,
    has_meds       INTEGER NOT NULL,           -- 0/1
    has_toy        INTEGER NOT NULL,           -- 0/1
    win            INTEGER NOT NULL,           -- 0/1 (made it through the day)
    finished_at    INTEGER NOT NULL,           -- ms since epoch
    PRIMARY KEY (session_code, pair_code, attempt)
);

CREATE INDEX IF NOT EXISTS results_finished_at ON results (finished_at);
CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions (created_at);
