import { ApiProperty } from '@nestjs/swagger';

export class StreamResponseDto {
  @ApiProperty({
    description:
      'Presigned URL for streaming the video (30 minutes expiration)',
    example:
      'https://minio:9000/videos-originals/pub-abc123/original.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&...',
  })
  url: string;

  @ApiProperty({
    description: 'Expiration time in seconds',
    example: 1800,
  })
  expiresIn: number;
}
