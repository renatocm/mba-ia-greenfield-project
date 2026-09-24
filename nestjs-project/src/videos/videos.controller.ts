import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BEARER_PREFIX } from '../auth/auth.constants';
import type { JwtPayload } from '../auth/auth.types';
import {
  CompleteUploadSessionDto,
  CompleteUploadSessionResponseDto,
} from './dto/complete-upload-session.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { DownloadResponseDto } from './dto/download-response.dto';
import { StreamResponseDto } from './dto/stream-response.dto';
import { UploadPartsResponseDto } from './dto/upload-parts-response.dto';
import { UploadSessionResponseDto } from './dto/upload-session-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly jwtService: JwtService,
  ) {}

  @Post('upload-session')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create multipart upload session',
    description:
      'Creates a draft video, starts a multipart upload session in storage, and returns presigned UploadPart URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Multipart upload session created successfully',
    type: UploadSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid upload payload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Storage request failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createUploadSession(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadSessionDto,
  ): Promise<UploadSessionResponseDto> {
    return this.videosService.initiateUploadSession(user.sub, dto);
  }

  @Get('upload-session/:videoId/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List uploaded multipart parts',
    description:
      'Lists uploaded parts for a multipart upload session so the client can resume or reconcile missing parts.',
  })
  @ApiQuery({ name: 'uploadId', required: true })
  @ApiOkResponse({
    description: 'Upload parts listed successfully',
    type: UploadPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired or no longer active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Query('uploadId') uploadId: string,
  ): Promise<UploadPartsResponseDto> {
    return this.videosService.getUploadParts(user.sub, videoId, uploadId);
  }

  @Post('upload-session/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete multipart upload session',
    description:
      'Finalizes the multipart upload, marks the draft as upload-complete, and prepares the processing job contract.',
  })
  @ApiOkResponse({
    description: 'Multipart upload completed successfully',
    type: CompleteUploadSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid uploaded parts list',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired or no longer active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUploadSession(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteUploadSessionDto,
  ): Promise<CompleteUploadSessionResponseDto> {
    return this.videosService.completeUploadSession(
      user.sub,
      dto.videoId,
      dto.uploadId,
      dto.parts,
    );
  }

  @Delete('upload-session/:videoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort multipart upload session',
    description:
      'Aborts the multipart upload session in storage and invalidates the active draft upload session.',
  })
  @ApiNoContentResponse({ description: 'Multipart upload session aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired or no longer active',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUploadSession(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
  ): Promise<void> {
    return this.videosService.abortUploadSession(user.sub, videoId);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get video by public ID',
    description:
      'Returns video details. Ready videos are public; non-ready videos require owner authentication.',
  })
  @ApiOkResponse({
    description: 'Video found successfully',
    type: VideoResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The requester does not have access to this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideoByPublicId(
    @Param('publicId') publicId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<VideoResponseDto> {
    const userId = await this.resolveOptionalUserId(authorization);
    const video = await this.videosService.getVideoDetails(publicId, userId);

    return VideoResponseDto.fromEntity(video);
  }

  @Public()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Get presigned stream URL',
    description:
      'Returns a presigned URL for streaming the video. Video must be in READY status. Ready videos are public; non-ready videos require owner authentication.',
  })
  @ApiOkResponse({
    description: 'Presigned stream URL generated successfully',
    type: StreamResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description:
      'The requester does not have access to this video or video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Storage request failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @Param('publicId') publicId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<StreamResponseDto> {
    const userId = await this.resolveOptionalUserId(authorization);
    const streamUrl = await this.videosService.getStreamUrl(publicId, userId);

    return {
      url: streamUrl,
      expiresIn: 1800, // 30 minutes
    };
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Get presigned download URL',
    description:
      'Returns a presigned URL for downloading the video. Video must be in READY status. Ready videos are public; non-ready videos require owner authentication.',
  })
  @ApiOkResponse({
    description: 'Presigned download URL generated successfully',
    type: DownloadResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description:
      'The requester does not have access to this video or video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Storage request failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @Param('publicId') publicId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<DownloadResponseDto> {
    const userId = await this.resolveOptionalUserId(authorization);
    const { url, filename } = await this.videosService.getDownloadUrl(
      publicId,
      userId,
    );

    return {
      url,
      expiresIn: 86400, // 24 hours
      filename,
    };
  }

  private async resolveOptionalUserId(
    authorization?: string,
  ): Promise<string | null> {
    if (!authorization) {
      return null;
    }

    if (!authorization.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        authorization.slice(BEARER_PREFIX.length),
      );

      return payload.sub;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
