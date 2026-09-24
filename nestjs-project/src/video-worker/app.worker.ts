import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import storageConfig from '../config/storage.config';
import swaggerConfig from '../config/swagger.config';
import { envValidationSchema } from '../config/env.validation';
import { StatusModule } from '../status/status.module';
import { VideoProcessingQueueModule } from '../videos/queue/video-processing.queue';
import { VideosModule } from '../videos/videos.module';
import { VideoProcessor } from '../videos/worker/video.processor';
import { UsersModule } from '../users/users.module';
import { ChannelsModule } from '../channels/channels.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        swaggerConfig,
        storageConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    VideoProcessingQueueModule,
    UsersModule,
    ChannelsModule,
    VideosModule,
    StatusModule,
  ],
  providers: [VideoProcessor],
})
export class AppWorkerModule {}
