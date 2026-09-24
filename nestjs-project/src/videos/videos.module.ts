import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { StringValue } from 'ms';
import authConfig from '../config/auth.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingQueueModule } from './queue/video-processing.queue';
import { VideoRepository } from './repositories/video.repository';
import { S3Service } from './storage/s3.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VideoProcessingService } from './worker/video-processing.service';

@Module({
  imports: [
    ConfigModule.forFeature(storageConfig),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [authConfig.KEY],
      useFactory: (cfg: ConfigType<typeof authConfig>) => ({
        secret: cfg.jwtSecret,
        signOptions: { expiresIn: cfg.jwtAccessExpiration as StringValue },
      }),
    }),
    TypeOrmModule.forFeature([Video, Channel]),
    VideoProcessingQueueModule,
  ],
  providers: [
    VideosService,
    VideoRepository,
    S3Service,
    VideoProcessingService,
  ],
  controllers: [VideosController],
  exports: [
    TypeOrmModule,
    VideosService,
    VideoRepository,
    S3Service,
    VideoProcessingQueueModule,
    VideoProcessingService,
  ],
})
export class VideosModule {}
