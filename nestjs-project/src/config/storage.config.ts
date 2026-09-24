import { registerAs } from '@nestjs/config';

export const DEFAULT_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  bucketOriginals: process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals',
  bucketPublic: process.env.S3_BUCKET_PUBLIC ?? 'videos-public',
  multipartPartSizeBytes: Number(
    process.env.S3_MULTIPART_PART_SIZE_BYTES ??
      DEFAULT_MULTIPART_PART_SIZE_BYTES,
  ),
  uploadPartUrlExpiresInSeconds: 3600,
  streamUrlExpiresInSeconds: 1800,
  downloadUrlExpiresInSeconds: 86400,
}));
