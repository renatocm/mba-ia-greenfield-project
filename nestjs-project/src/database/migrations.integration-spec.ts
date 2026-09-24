import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1790204921073 } from './migrations/1790204921073-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'videos',
  'refresh_tokens',
  'verification_tokens',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, Video, RefreshToken, VerificationToken],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1790204921073,
        ],
      },
    );

    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the videos table with required columns, indexes, and defaults', async () => {
    const columns = await dataSource.query<
      {
        column_name: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
        udt_name: string;
      }[]
    >(
      `SELECT column_name, is_nullable, column_default, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'videos'
       ORDER BY ordinal_position`,
    );

    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'public_id',
      'owner_user_id',
      'channel_id',
      'status',
      'original_bucket',
      'original_object_key',
      'thumbnail_bucket',
      'thumbnail_object_key',
      'upload_session_id',
      'draft_created_at',
      'upload_completed_at',
      'processing_started_at',
      'processing_completed_at',
      'metadata_json',
      'processing_attempts',
      'last_error',
      'last_error_at',
      'last_error_stack_trace',
      'created_at',
      'updated_at',
    ]);

    const statusColumn = columns.find(
      (column) => column.column_name === 'status',
    );
    const attemptsColumn = columns.find(
      (column) => column.column_name === 'processing_attempts',
    );
    const uploadSessionColumn = columns.find(
      (column) => column.column_name === 'upload_session_id',
    );

    expect(statusColumn?.udt_name).toBe('videos_status_enum');
    expect(statusColumn?.column_default).toContain("'draft'");
    expect(attemptsColumn?.column_default).toBe('0');
    expect(uploadSessionColumn?.is_nullable).toBe('YES');

    const indexes = await dataSource.query<{ indexname: string }[]>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'videos'
       ORDER BY indexname`,
    );

    expect(indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        'IDX_videos_channel_id',
        'IDX_videos_owner_user_id',
        'IDX_videos_public_id',
        'IDX_videos_status',
      ]),
    );
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
  });
});
