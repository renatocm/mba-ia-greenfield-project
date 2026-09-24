import { Controller, Get, Param, Query, Headers } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { VideosService } from '../videos/videos.service';
import { ListChannelVideosResponseDto } from '../videos/dto/list-channel-videos-response.dto';
import { VideoResponseDto } from '../videos/dto/video-response.dto';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth/auth.constants';
import type { JwtPayload } from '../auth/auth.types';

@ApiTags('channels')
@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly videosService: VideosService,
    private readonly jwtService: JwtService,
  ) {}

  @Public()
  @Get(':channelId/videos')
  @ApiOperation({ summary: 'List videos for a channel' })
  @ApiOkResponse({
    type: ListChannelVideosResponseDto,
  })
  @ApiQuery({ name: 'page', type: Number, required: false, example: 1 })
  @ApiQuery({ name: 'limit', type: Number, required: false, example: 10 })
  async listChannelVideos(
    @Param('channelId') channelId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<ListChannelVideosResponseDto> {
    const userId = await this.resolveOptionalUserId(authorization);
    const pageNum = Math.max(1, parseInt(page || '1', 10));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit || '10', 10)));

    const { items, total } = await this.videosService.listByChannelPaginated(
      channelId,
      pageNum,
      limitNum,
      userId ?? undefined,
    );

    return {
      items: items.map((video) => VideoResponseDto.fromEntity(video)),
      page: pageNum,
      limit: limitNum,
      total,
    };
  }

  private async resolveOptionalUserId(
    authorization?: string,
  ): Promise<string | null> {
    if (!authorization) {
      return null;
    }

    if (!authorization.startsWith(BEARER_PREFIX)) {
      return null;
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        authorization.slice(BEARER_PREFIX.length),
      );

      return payload.sub;
    } catch {
      return null;
    }
  }
}
