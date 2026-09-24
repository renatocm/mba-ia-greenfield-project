import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import { randomUUID } from 'crypto';
import storageConfig from '../../config/storage.config';
import { StorageException } from '../exceptions/storage.exception';
import { S3Service } from './s3.service';

describe('S3Service (integration)', () => {
  let client: S3Client;
  let service: S3Service;

  const config = {
    endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    bucketOriginals: process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals',
    bucketPublic: process.env.S3_BUCKET_PUBLIC ?? 'videos-public',
    multipartPartSizeBytes: Number(
      process.env.S3_MULTIPART_PART_SIZE_BYTES ?? 8388608,
    ),
    uploadPartUrlExpiresInSeconds: 3600,
    streamUrlExpiresInSeconds: 1800,
    downloadUrlExpiresInSeconds: 86400,
  } as ConfigType<typeof storageConfig>;

  beforeAll(async () => {
    service = new S3Service(config);
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    await ensureBucket(config.bucketOriginals);
    await ensureBucket(config.bucketPublic);
  });

  async function ensureBucket(bucket: string): Promise<void> {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }

  it('aborts multipart uploads and invalidates subsequent part listing', async () => {
    const objectKey = `${randomUUID()}/original.mp4`;
    const uploadId = await service.createMultipartUpload({
      objectKey,
      contentType: 'video/mp4',
    });

    await service.abortMultipartUpload(uploadId, objectKey);

    await expect(service.listParts(uploadId, objectKey)).rejects.toThrow(
      StorageException,
    );
  }, 30000);
});
