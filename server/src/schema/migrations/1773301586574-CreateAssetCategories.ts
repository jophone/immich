import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "assetId" uuid NOT NULL, "categoryName" text NOT NULL, "confidence" real NOT NULL);`.execute(
    db,
  );
  await sql`ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id");`.execute(db);
  await sql`ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE;`.execute(
    db,
  );
  await sql`CREATE INDEX "asset_categories_assetId_idx" ON "asset_categories" ("assetId")`.execute(db);
  await sql`CREATE INDEX "asset_categories_categoryName_idx" ON "asset_categories" ("categoryName")`.execute(db);
  await sql`ALTER TABLE "asset_job_status" ADD "classifiedAt" timestamp with time zone;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "classifiedAt";`.execute(db);
  await sql`DROP TABLE "asset_categories";`.execute(db);
}
