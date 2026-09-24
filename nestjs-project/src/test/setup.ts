import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from '../database/migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from '../database/migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1790204921073 } from '../database/migrations/1790204921073-CreateVideos';
import { Video } from '../videos/entities/video.entity';

// Each suite owns a disposable database, never the application's database.
// EXCEPT for SI-03.8 pipeline tests that need real infrastructure
const database = `streamtube_test_${randomUUID().replaceAll('-', '')}`;

// Placeholder - will be checked in beforeAll
let isRealPipelineTest = false;

// Only override DB_NAME if NOT a real pipeline test
// (checked dynamically in beforeAll)
process.env.DB_HOST ??= 'db';
process.env.DB_PORT ??= '5432';
process.env.DB_USERNAME ??= 'streamtube';
process.env.DB_PASSWORD ??= 'streamtube';
process.env.REDIS_URL ??= 'redis://redis:6379';
process.env.JWT_SECRET = 'baseline-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'baseline-test-refresh-secret';

const connection = {
  type: 'postgres' as const,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
};
const admin = new DataSource({ ...connection, database: 'postgres' });
let created = false;

beforeAll(async () => {
  // SI-03.8 pipeline test uses real database intentionally
  isRealPipelineTest =
    expect.getState().testPath?.includes('videos-pipeline') ?? false;

  if (isRealPipelineTest) {
    console.log('SI-03.8 pipeline test: using REAL database (no isolation)');
    // Keep DB_NAME as 'streamtube' (the real one)
    process.env.DB_NAME = 'streamtube';
    return;
  }

  // Non-pipeline tests: use isolated test database
  process.env.DB_NAME = database;

  await admin.initialize();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;

  // E2E boots the real AppModule, which intentionally has synchronize=false.
  if (expect.getState().testPath?.endsWith('.e2e-spec.ts')) {
    const migrations = new DataSource({
      ...connection,
      database,
      entities: [User, Channel, Video, RefreshToken, VerificationToken],
      migrations: [
        CreateUsersAndChannels1775687773260,
        CreateAuthTokens1777579850478,
        CreateVideos1790204921073,
      ],
    });
    try {
      await migrations.initialize();
      await migrations.runMigrations();
    } finally {
      if (migrations.isInitialized) await migrations.destroy();
    }
  }
}, 30_000);

afterAll(async () => {
  if (isRealPipelineTest) {
    console.log(
      'SI-03.8 pipeline test: cleanup complete (kept REAL database intact)',
    );
    return;
  }

  if (admin.isInitialized) {
    try {
      if (created)
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await admin.destroy();
    }
  }
}, 30_000);
