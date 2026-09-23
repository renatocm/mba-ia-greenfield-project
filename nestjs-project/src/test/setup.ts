import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from '../database/migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from '../database/migrations/1777579850478-CreateAuthTokens';

// Each suite owns a disposable database, never the application's database.
const database = `streamtube_test_${randomUUID().replaceAll('-', '')}`;
process.env.DB_NAME = database;
process.env.DB_HOST ??= 'db';
process.env.DB_PORT ??= '5432';
process.env.DB_USERNAME ??= 'streamtube';
process.env.DB_PASSWORD ??= 'streamtube';
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
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;

  // E2E boots the real AppModule, which intentionally has synchronize=false.
  if (expect.getState().testPath?.endsWith('.e2e-spec.ts')) {
    const migrations = new DataSource({
      ...connection,
      database,
      entities: [User, Channel, RefreshToken, VerificationToken],
      migrations: [
        CreateUsersAndChannels1775687773260,
        CreateAuthTokens1777579850478,
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
  if (admin.isInitialized) {
    try {
      if (created)
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await admin.destroy();
    }
  }
}, 30_000);
