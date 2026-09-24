import { S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../../config/storage.config';
import { InvalidPartListException } from '../exceptions/invalid-part-list.exception';
import { StorageException } from '../exceptions/storage.exception';
import { S3Service } from './s3.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

describe('S3Service', () => {
  let service: S3Service;
  let sendSpy: jest.SpyInstance;

  const config = {
    endpoint: 'http://minio:9000',
    region: 'us-east-1',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    forcePathStyle: true,
    bucketOriginals: 'videos-originals',
    bucketPublic: 'videos-public',
    multipartPartSizeBytes: 8388608,
    uploadPartUrlExpiresInSeconds: 3600,
    streamUrlExpiresInSeconds: 1800,
    downloadUrlExpiresInSeconds: 86400,
  } as ConfigType<typeof storageConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new S3Service(config);
    sendSpy = jest.spyOn(S3Client.prototype, 'send');
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  it('creates a multipart upload and returns the upload id', async () => {
    sendSpy.mockResolvedValue({ UploadId: 'upload-id' });

    await expect(
      service.createMultipartUpload({
        objectKey: 'public-id/original.mp4',
        contentType: 'video/mp4',
        metadata: { videoId: 'video-id' },
      }),
    ).resolves.toBe('upload-id');

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('generates a presigned upload part url with the correct expiration', async () => {
    (
      getSignedUrl as unknown as jest.MockedFunction<typeof getSignedUrl>
    ).mockImplementation((client, command, options) => {
      expect(client).toBeInstanceOf(S3Client);
      expect((command as UploadPartCommand).input.PartNumber).toBe(3);
      expect(options).toEqual({ expiresIn: 3600 });

      return Promise.resolve('http://signed-upload-part');
    });

    await expect(
      service.generatePresignedUploadPartUrl({
        objectKey: 'public-id/original.mp4',
        uploadId: 'upload-id',
        partNumber: 3,
      }),
    ).resolves.toEqual({
      partNumber: 3,
      url: 'http://signed-upload-part',
      expiresIn: 3600,
    });
  });

  it('reconciles uploaded and missing parts correctly', () => {
    expect(
      service.reconcileUploadedParts(4, [
        { partNumber: 1, eTag: '"etag-1"', lastModified: null },
        { partNumber: 3, eTag: '"etag-3"', lastModified: null },
      ]),
    ).toEqual({
      uploadId: '',
      uploadedParts: [
        { partNumber: 1, eTag: '"etag-1"', lastModified: null },
        { partNumber: 3, eTag: '"etag-3"', lastModified: null },
      ],
      missingParts: [2, 4],
    });
  });

  it('normalizes etags with surrounding quotes', () => {
    expect(service.normalizeEtag('etag-1')).toBe('"etag-1"');
    expect(service.normalizeEtag('"etag-1"')).toBe('"etag-1"');
  });

  it('throws InvalidPartListException when multipart completion receives duplicate parts', async () => {
    await expect(
      service.completeMultipartUpload({
        objectKey: 'public-id/original.mp4',
        uploadId: 'upload-id',
        parts: [
          { partNumber: 1, eTag: 'etag-1' },
          { partNumber: 1, eTag: 'etag-1' },
        ],
      }),
    ).rejects.toThrow(InvalidPartListException);
  });

  it('wraps sdk failures in StorageException', async () => {
    sendSpy.mockRejectedValue(new Error('minio unavailable'));

    await expect(
      service.createMultipartUpload({
        objectKey: 'public-id/original.mp4',
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow(StorageException);
  });

  it('generates a presigned stream url with 30-minute expiration', async () => {
    (
      getSignedUrl as unknown as jest.MockedFunction<typeof getSignedUrl>
    ).mockImplementation((client, command, options) => {
      expect(client).toBeInstanceOf(S3Client);
      expect(options).toEqual({ expiresIn: 1800 });

      return Promise.resolve('http://signed-stream-url');
    });

    await expect(
      service.generateStreamUrl('public-id/original.mp4'),
    ).resolves.toBe('http://signed-stream-url');
  });

  it('generates a presigned download url with 24-hour expiration', async () => {
    (
      getSignedUrl as unknown as jest.MockedFunction<typeof getSignedUrl>
    ).mockImplementation((client, command, options) => {
      expect(client).toBeInstanceOf(S3Client);
      expect(options).toEqual({ expiresIn: 86400 });
      // Verify ResponseContentDisposition was set on the command
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const getObjectCmd = command as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(getObjectCmd.input.ResponseContentDisposition).toContain(
        'attachment',
      );

      return Promise.resolve('http://signed-download-url');
    });

    await expect(
      service.generateDownloadUrl('public-id/original.mp4', 'video-abc123.mp4'),
    ).resolves.toBe('http://signed-download-url');
  });

  it('wraps presigner failures in StorageException', async () => {
    (
      getSignedUrl as unknown as jest.MockedFunction<typeof getSignedUrl>
    ).mockRejectedValue(new Error('presigner failed'));

    await expect(
      service.generateStreamUrl('public-id/original.mp4'),
    ).rejects.toThrow(StorageException);
  });
});
