import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateVideoDraftDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  channelId: string;

  @ApiProperty({ example: 'my-video.mp4', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({ example: 'video/mp4', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  contentType: string;

  @ApiProperty({ example: 1048576, minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
