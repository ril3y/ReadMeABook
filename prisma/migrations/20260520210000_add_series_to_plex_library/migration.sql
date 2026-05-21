-- AlterTable
ALTER TABLE "plex_library" ADD COLUMN "series" TEXT,
ADD COLUMN "series_part" TEXT;

-- CreateIndex
CREATE INDEX "plex_library_series_idx" ON "plex_library"("series");
