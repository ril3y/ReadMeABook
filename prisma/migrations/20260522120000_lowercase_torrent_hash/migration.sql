-- Normalize existing `torrent_hash` values to lowercase to match the new
-- write-side normalization in download-torrent.processor.ts. Without this
-- backfill, rows persisted before the fix retain mixed-case hashes and
-- detect-stalled-downloads Stage 2 will misclassify them as orphans (because
-- the WHERE-clause lowercases qBT's hash before comparing).
--
-- Idempotent — running on already-lowercase data is a no-op.
UPDATE "download_history"
   SET "torrent_hash" = LOWER("torrent_hash")
 WHERE "torrent_hash" IS NOT NULL
   AND "torrent_hash" <> LOWER("torrent_hash");
