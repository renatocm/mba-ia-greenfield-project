import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import authConfig from '../config/auth.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE_NAME } from './queue/video-processing.constants';
import { VideoProcessingProducer } from './queue/video-processing.producer';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosModule', () => {
  it('should compile with storage, jwt, and TypeOrm dependencies', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [authConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(VideoProcessingProducer)).toBeDefined();
    expect(
      module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE_NAME)),
    ).toBeDefined();
    await module.close();
  }, 30000);
});
