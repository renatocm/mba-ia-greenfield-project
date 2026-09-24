import { ApiProperty } from '@nestjs/swagger';

export class UploadPartUrlDto {
  @ApiProperty({ minimum: 1 })
  partNumber: number;

  @ApiProperty()
  url: string;

  @ApiProperty({ example: 3600 })
  expiresIn: number;
}

export class UploadSessionResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ example: 'V1StGXR8_Z5j' })
  publicId: string;

  @ApiProperty()
  uploadId: string;

  @ApiProperty({ example: 'V1StGXR8_Z5j/original.mp4' })
  objectKey: string;

  @ApiProperty({ type: () => [UploadPartUrlDto] })
  partUrls: UploadPartUrlDto[];

  @ApiProperty({ example: 3600 })
  expiresIn: number;
}
