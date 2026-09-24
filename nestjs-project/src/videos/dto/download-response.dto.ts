import { ApiProperty } from '@nestjs/swagger';

export class DownloadResponseDto {
  @ApiProperty({
    description:
      'Presigned URL for downloading the video (24 hours expiration)',
    example:
      'https://minio:9000/videos-originals/pub-abc123/original.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&...',
  })
  url: string;

  @ApiProperty({
    description: 'Expiration time in seconds',
    example: 86400,
  })
  expiresIn: number;

  @ApiProperty({
    description: 'Filename for Content-Disposition header',
    example: 'my-video.mp4',
  })
  filename: string;
}
