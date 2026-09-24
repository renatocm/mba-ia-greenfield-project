import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Channel } from './entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from './channels.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('ChannelsModule', () => {
  let dataSource: DataSource;

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('should provide ChannelsService', async () => {
    const testDataSource = createTestDataSource(ALL_ENTITIES);
    const options = {
      ...testDataSource.options,
      retryAttempts: 0,
    };

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot(options),
        TypeOrmModule.forFeature([Channel, User]),
      ],
      providers: [ChannelsService],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(ChannelsService)).toBeDefined();

    dataSource = module.get(DataSource);
    await module.close();
  }, 15000);
});
