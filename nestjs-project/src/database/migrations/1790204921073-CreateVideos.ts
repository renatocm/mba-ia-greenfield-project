import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1790204921073 implements MigrationInterface {
  name = 'CreateVideos1790204921073';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type
          WHERE typname = 'videos_status_enum'
        ) THEN
          CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error');
        END IF;
      END
      $$;`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "videos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "public_id" character varying(12) NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "channel_id" uuid NOT NULL,
        "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft',
        "original_bucket" character varying NOT NULL,
        "original_object_key" character varying NOT NULL,
        "thumbnail_bucket" character varying NOT NULL,
        "thumbnail_object_key" character varying NOT NULL,
        "upload_session_id" character varying,
        "draft_created_at" TIMESTAMP NOT NULL,
        "upload_completed_at" TIMESTAMP,
        "processing_started_at" TIMESTAMP,
        "processing_completed_at" TIMESTAMP,
        "metadata_json" jsonb,
        "processing_attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "last_error_at" TIMESTAMP,
        "last_error_stack_trace" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_videos_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_videos_owner_user_id" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_videos_public_id" ON "videos" ("public_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_videos_owner_user_id" ON "videos" ("owner_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_videos_channel_id" ON "videos" ("channel_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_videos_status" ON "videos" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_videos_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_videos_channel_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_videos_owner_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_videos_public_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "videos"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."videos_status_enum"`,
    );
  }
}
