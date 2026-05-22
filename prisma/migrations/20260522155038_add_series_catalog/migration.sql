-- Series catalog cache: stores the *true* total book count of a series
-- (sourced from Audible/Audnexus) so the library can show
-- "X owned / Y total" without rescraping on every page render.
--
-- Lazily populated: the /api/series/{asin} route upserts on each scrape,
-- and /api/library/series fires a background refresh for series whose
-- last_synced_at is stale or missing. Additive table — no destructive
-- changes anywhere else.

-- CreateTable
CREATE TABLE "series_catalog" (
    "series_asin" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "total_books" INTEGER NOT NULL,
    "cover_art_url" TEXT,
    "audible_url" TEXT,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "series_catalog_pkey" PRIMARY KEY ("series_asin")
);

-- CreateIndex
CREATE INDEX "series_catalog_last_synced_at_idx" ON "series_catalog"("last_synced_at");

-- CreateIndex
CREATE INDEX "series_catalog_title_idx" ON "series_catalog"("title");
