import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE "lite_search" (
      "assetId" uuid NOT NULL,
      "embedding" vector(768) STORAGE EXTERNAL
    )
  `.execute(db);

  await sql`
    ALTER TABLE "lite_search"
      ADD CONSTRAINT "lite_search_pkey" PRIMARY KEY ("assetId")
  `.execute(db);

  await sql`
    ALTER TABLE "lite_search"
      ADD CONSTRAINT "lite_search_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "asset" ("id")
      ON UPDATE CASCADE ON DELETE CASCADE
  `.execute(db);

  await sql`
    CREATE INDEX "lite_search_index" ON "lite_search"
      USING hnsw (embedding vector_cosine_ops)
      WITH (ef_construction = 300, m = 16)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "lite_search"`.execute(db);
}
