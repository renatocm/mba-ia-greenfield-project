import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Global, Module } from '@nestjs/common';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  getVideoProcessingBaseJobOptions,
  VIDEO_PROCESSING_QUEUE_NAME,
} from './video-processing.constants';

@Global()
@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL') ?? 'redis://redis:6379',
        },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE_NAME,
      defaultJobOptions: getVideoProcessingBaseJobOptions(),
    }),
  ],
  providers: [VideoProcessingProducer],
  exports: [BullModule, VideoProcessingProducer],
})
export class VideoProcessingQueueModule {}
