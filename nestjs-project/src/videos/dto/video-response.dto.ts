import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'V1StGXR8_Z5j' })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({ format: 'uuid' })
  channelId: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  metadata?: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  thumbnailUrl?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static fromEntity(video: Video): VideoResponseDto {
    return {
      id: video.id,
      publicId: video.public_id,
      status: video.status,
      channelId: video.channel_id,
      metadata: this.extractPublicMetadata(video.metadata_json),
      thumbnailUrl: null,
      createdAt: video.created_at,
      updatedAt: video.updated_at,
    };
  }

  private static extractPublicMetadata(
    metadata: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!metadata) {
      return null;
    }

    const mediaMetadata = metadata['media'];

    if (
      mediaMetadata &&
      typeof mediaMetadata === 'object' &&
      !Array.isArray(mediaMetadata)
    ) {
      return mediaMetadata as Record<string, unknown>;
    }

    if ('upload' in metadata) {
      return null;
    }

    return metadata;
  }
}
