import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  type CompletedPart,
  type ListPartsCommandOutput,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig, {
  DEFAULT_MULTIPART_PART_SIZE_BYTES,
} from '../../config/storage.config';
import {
  UploadedPartDto,
  UploadPartsResponseDto,
} from '../dto/upload-parts-response.dto';
import { UploadPartUrlDto } from '../dto/upload-session-response.dto';
import { InvalidPartListException } from '../exceptions/invalid-part-list.exception';
import { StorageException } from '../exceptions/storage.exception';

export { DEFAULT_MULTIPART_PART_SIZE_BYTES };

export interface CreateMultipartUploadParams {
  objectKey: string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface PresignedUploadPartUrlParams {
  objectKey: string;
  uploadId: string;
  partNumber: number;
}

export interface MultipartUploadPart {
  partNumber: number;
  eTag: string;
}

export interface CompleteMultipartUploadParams {
  objectKey: string;
  uploadId: string;
  parts: MultipartUploadPart[];
}

@Injectable()
export class S3Service {
  private readonly s3Client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.s3Client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  get originalsBucket(): string {
    return this.config.bucketOriginals;
  }

  get publicBucket(): string {
    return this.config.bucketPublic;
  }

  get multipartPartSizeBytes(): number {
    return this.config.multipartPartSizeBytes;
  }

  get uploadPartUrlExpiresInSeconds(): number {
    return this.config.uploadPartUrlExpiresInSeconds;
  }

  get streamUrlExpiresInSeconds(): number {
    return this.config.streamUrlExpiresInSeconds;
  }

  get downloadUrlExpiresInSeconds(): number {
    return this.config.downloadUrlExpiresInSeconds;
  }

  async createMultipartUpload(
    params: CreateMultipartUploadParams,
  ): Promise<string> {
    try {
      const response = await this.s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.originalsBucket,
          Key: params.objectKey,
          ContentType: params.contentType,
          Metadata: params.metadata,
        }),
      );

      if (!response.UploadId) {
        throw new StorageException();
      }

      return response.UploadId;
    } catch (error) {
      if (error instanceof StorageException) {
        throw error;
      }

      throw new StorageException(error);
    }
  }

  async generatePresignedUploadPartUrl(
    params: PresignedUploadPartUrlParams,
  ): Promise<UploadPartUrlDto> {
    try {
      const url = await getSignedUrl(
        this.s3Client,
        new UploadPartCommand({
          Bucket: this.originalsBucket,
          Key: params.objectKey,
          UploadId: params.uploadId,
          PartNumber: params.partNumber,
        }),
        { expiresIn: this.uploadPartUrlExpiresInSeconds },
      );

      return {
        partNumber: params.partNumber,
        url,
        expiresIn: this.uploadPartUrlExpiresInSeconds,
      };
    } catch (error) {
      throw new StorageException(error);
    }
  }

  async listParts(
    uploadId: string,
    objectKey: string,
  ): Promise<UploadedPartDto[]> {
    try {
      const response = await this.s3Client.send(
        new ListPartsCommand({
          Bucket: this.originalsBucket,
          Key: objectKey,
          UploadId: uploadId,
          MaxParts: 1000,
        }),
      );

      return this.mapParts(response);
    } catch (error) {
      throw new StorageException(error);
    }
  }

  reconcileUploadedParts(
    expectedPartCount: number,
    uploadedParts: UploadedPartDto[],
  ): UploadPartsResponseDto {
    const uploadedPartNumbers = new Set(
      uploadedParts.map((part) => part.partNumber),
    );
    const missingParts: number[] = [];

    for (let partNumber = 1; partNumber <= expectedPartCount; partNumber += 1) {
      if (!uploadedPartNumbers.has(partNumber)) {
        missingParts.push(partNumber);
      }
    }

    return {
      uploadId: '',
      uploadedParts,
      missingParts,
    };
  }

  async completeMultipartUpload(
    params: CompleteMultipartUploadParams,
  ): Promise<void> {
    try {
      const normalizedParts = this.normalizePartsForCompletion(params.parts);

      await this.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.originalsBucket,
          Key: params.objectKey,
          UploadId: params.uploadId,
          MultipartUpload: {
            Parts: normalizedParts,
          },
        }),
      );
    } catch (error) {
      if (error instanceof InvalidPartListException) {
        throw error;
      }

      throw new StorageException(error);
    }
  }

  async abortMultipartUpload(
    uploadId: string,
    objectKey: string,
  ): Promise<void> {
    try {
      await this.s3Client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.originalsBucket,
          Key: objectKey,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      throw new StorageException(error);
    }
  }

  normalizeEtag(eTag: string): string {
    const trimmed = eTag.trim();
    const withoutQuotes = trimmed.replace(/^"|"$/g, '');

    return `"${withoutQuotes}"`;
  }

  private mapParts(response: ListPartsCommandOutput): UploadedPartDto[] {
    return (response.Parts ?? []).map((part) => ({
      partNumber: part.PartNumber ?? 0,
      eTag: part.ETag ?? '',
      lastModified: part.LastModified?.toISOString() ?? null,
    }));
  }

  private normalizePartsForCompletion(
    parts: MultipartUploadPart[],
  ): CompletedPart[] {
    if (parts.length === 0) {
      throw new InvalidPartListException();
    }

    const sortedParts = [...parts].sort(
      (left, right) => left.partNumber - right.partNumber,
    );
    const uniquePartNumbers = new Set<number>();

    for (const part of sortedParts) {
      if (
        !Number.isInteger(part.partNumber) ||
        part.partNumber < 1 ||
        part.partNumber > 10000 ||
        !part.eTag.trim()
      ) {
        throw new InvalidPartListException();
      }

      if (uniquePartNumbers.has(part.partNumber)) {
        throw new InvalidPartListException();
      }

      uniquePartNumbers.add(part.partNumber);
    }

    return sortedParts.map((part) => ({
      PartNumber: part.partNumber,
      ETag: this.normalizeEtag(part.eTag),
    }));
  }

  private buildAttachmentDisposition(filename: string): string {
    const escapedFilename = filename.replace(/(["\\])/g, '\\$1');

    return `attachment; filename="${escapedFilename}"`;
  }

  /**
   * Download object from S3 to local file
   * Used by worker to download video for processing
   */
  async downloadObject(
    bucket: string,
    objectKey: string,
    localFilePath: string,
  ): Promise<void> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: objectKey,
        }),
      );

      if (!response.Body) {
        throw new StorageException('Empty response body from S3');
      }

      // Convert response body to buffer and write to file
      const chunks: Buffer[] = [];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const body = response.Body as any;

      if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
        // Handle async iterable
        for await (const chunk of body) {
          chunks.push(chunk as unknown as Buffer);
        }
      } else if (Buffer.isBuffer(body)) {
        chunks.push(body as unknown as Buffer);
      } else {
        throw new StorageException('Unexpected response body type');
      }

      const fileBuffer = Buffer.concat(chunks);
      await fs.promises.writeFile(localFilePath, fileBuffer);
    } catch (error) {
      if (error instanceof StorageException) {
        throw error;
      }
      throw new StorageException(error);
    }
  }

  /**
   * Upload object to S3 from buffer
   * Used by worker to upload thumbnail
   */
  async uploadObject(
    bucket: string,
    objectKey: string,
    fileBuffer: Buffer,
    contentType: string,
  ): Promise<void> {
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: fileBuffer,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      throw new StorageException(error);
    }
  }

  /**
   * Generate presigned URL for streaming a video
   * 30-minute expiration, no Content-Disposition header (browser will stream)
   */
  async generateStreamUrl(objectKey: string): Promise<string> {
    try {
      const url = await getSignedUrl(
        this.s3Client,
        new GetObjectCommand({
          Bucket: this.originalsBucket,
          Key: objectKey,
        }),
        { expiresIn: this.streamUrlExpiresInSeconds },
      );

      return url;
    } catch (error) {
      throw new StorageException(error);
    }
  }

  /**
   * Generate presigned URL for downloading a video
   * 24-hour expiration with Content-Disposition: attachment header
   * Storage will serve the response with attachment; filename="..." header
   */
  async generateDownloadUrl(
    objectKey: string,
    filename: string,
  ): Promise<string> {
    try {
      const url = await getSignedUrl(
        this.s3Client,
        new GetObjectCommand({
          Bucket: this.originalsBucket,
          Key: objectKey,
          ResponseContentDisposition: this.buildAttachmentDisposition(filename),
        }),
        { expiresIn: this.downloadUrlExpiresInSeconds },
      );

      return url;
    } catch (error) {
      throw new StorageException(error);
    }
  }
}
