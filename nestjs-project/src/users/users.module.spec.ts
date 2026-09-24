import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from './entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { UsersService } from './users.service';
import { ChannelsService } from '../channels/channels.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('UsersModule', () => {
  let dataSource: DataSource;

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('should provide UsersService', async () => {
    const testDataSource = createTestDataSource(ALL_ENTITIES);
    const options = {
      ...testDataSource.options,
      retryAttempts: 0,
    };

    const channelsServiceMock = {
      findByUsername: jest.fn(),
      create: jest.fn(),
    };

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot(options),
        TypeOrmModule.forFeature([User, Channel]),
      ],
      providers: [
        UsersService,
        {
          provide: ChannelsService,
          useValue: channelsServiceMock,
        },
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(UsersService)).toBeDefined();

    dataSource = module.get(DataSource);
    await module.close();
  }, 15000);
});
