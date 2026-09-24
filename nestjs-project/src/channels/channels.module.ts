import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import type { ConfigType } from '@nestjs/config';
import type { StringValue } from 'ms';
import authConfig from '../config/auth.config';
import { ConfigModule } from '@nestjs/config';
import { Channel } from './entities/channel.entity';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { VideosModule } from '../videos/videos.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Channel]),
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [authConfig.KEY],
      useFactory: (cfg: ConfigType<typeof authConfig>) => ({
        secret: cfg.jwtSecret,
        signOptions: { expiresIn: cfg.jwtAccessExpiration as StringValue },
      }),
    }),
    VideosModule,
  ],
  providers: [ChannelsService],
  controllers: [ChannelsController],
  exports: [TypeOrmModule, ChannelsService],
})
export class ChannelsModule {}
