import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ minimum: 1 })
  partNumber: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  eTag: string;

  @ApiProperty({ nullable: true, example: '2026-09-23T20:00:00.000Z' })
  lastModified: string | null;
}

export class UploadPartsResponseDto {
  @ApiProperty()
  uploadId: string;

  @ApiProperty({ type: () => [UploadedPartDto] })
  uploadedParts: UploadedPartDto[];

  @ApiProperty({ type: () => [Number] })
  missingParts: number[];
}
