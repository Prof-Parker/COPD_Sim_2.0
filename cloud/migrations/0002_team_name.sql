-- Team names replace individual nicknames on the leaderboard and in exports.
-- patient_name / observer_name stay (always '' from now on) so older rows keep working.
-- Apply:  npx wrangler d1 migrations apply copd-sim-results --remote   (and --local for dev)

ALTER TABLE results ADD COLUMN team_name TEXT NOT NULL DEFAULT '';
