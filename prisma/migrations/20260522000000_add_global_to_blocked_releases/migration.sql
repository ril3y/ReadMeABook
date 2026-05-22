-- Add `global` column to blocked_releases for cross-request release blocking.
-- When true, the row matches any future search regardless of request_id —
-- used by the detect-stalled-downloads processor to penalize releases that
-- have stalled across multiple independent requests.
ALTER TABLE "blocked_releases" ADD COLUMN "global" BOOLEAN NOT NULL DEFAULT false;

-- Partial index: only rows where global=true are interesting for the
-- cross-request lookup hot path inside filter-blocked-results.
CREATE INDEX "blocked_releases_global_release_key_idx"
  ON "blocked_releases" ("release_key")
  WHERE "global" = true;
