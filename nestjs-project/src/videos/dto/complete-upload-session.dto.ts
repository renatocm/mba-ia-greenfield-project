import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { VideoStatus } from '../video-status.enum';

export class CompleteUploadSessionPartDto {
  @ApiProperty({ minimum: 1, maximum: 10000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadSessionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  videoId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @ApiProperty({ type: () => [CompleteUploadSessionPartDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompleteUploadSessionPartDto)
  parts: CompleteUploadSessionPartDto[];
}

export class CompleteUploadSessionResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ example: 'V1StGXR8_Z5j' })
  publicId: string;

  @ApiProperty({
    enum: [VideoStatus.DRAFT],
    enumName: 'VideoUploadCompletionStatus',
  })
  status: VideoStatus.DRAFT;

  @ApiProperty()
  uploadCompletedAt: Date;

  @ApiProperty({ example: 'video.e4567-e89b-12d3-a456-426614174000' })
  jobId: string;
}
