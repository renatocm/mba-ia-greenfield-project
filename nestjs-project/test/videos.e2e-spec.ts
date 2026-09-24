import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE_NAME } from '../src/videos/queue/video-processing.constants';
import { VideoProcessRequestedPayload } from '../src/videos/queue/video-process-requested.payload';
import { DEFAULT_MULTIPART_PART_SIZE_BYTES } from '../src/videos/storage/s3.service';
import { VideoStatus } from '../src/videos/video-status.enum';

type JsonResponse<T = Record<string, unknown>> = Omit<Response, 'body'> & {
  body: T;
};

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let s3Client: S3Client;
  let queue: Queue<VideoProcessRequestedPayload>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue<VideoProcessRequestedPayload>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE_NAME),
    );

    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin',
      },
    });

    await ensureBucket(process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals');
    await ensureBucket(process.env.S3_BUCKET_PUBLIC ?? 'videos-public');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    // Just clear the storage without reassigning
    throttlerStorage.storage?.clear();
    await queue.obliterate({ force: true });
  });

  async function ensureBucket(bucket: string): Promise<void> {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailServiceInstance = app.get(MailService);
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ accessToken: string; channelId: string; userId: string }> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token })
      .expect(204);
    const loginResponse: JsonResponse<{
      access_token: string;
      refresh_token: string;
    }> = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const user = await userRepository.findOne({
      where: { email },
      relations: { channel: true },
    });
    if (!user?.channel) {
      throw new Error('Expected confirmed user with channel');
    }

    return {
      accessToken: loginResponse.body.access_token,
      channelId: user.channel.id,
      userId: user.id,
    };
  }

  async function uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });

    expect(response.ok).toBe(true);

    const eTag = response.headers.get('etag');
    if (!eTag) {
      throw new Error('Expected ETag header from MinIO');
    }

    return eTag;
  }

  it('returns 401 on POST /videos/upload-session without Authorization header', async () => {
    await request(app.getHttpServer())
      .post('/videos/upload-session')
      .send({
        channelId: '73dfe527-31c3-40d2-a423-75546e36a050',
        filename: 'video.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(401);
  });

  it('creates a multipart upload session and lists missing parts after a partial upload', async () => {
    const { accessToken, channelId } = await registerConfirmAndLogin(
      'videos.parts@example.com',
    );

    const createResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      uploadId: string;
      objectKey: string;
      partUrls: { partNumber: number; url: string; expiresIn: number }[];
      expiresIn: number;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        filename: 'video.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES + 1,
      })
      .expect(201);

    expect(createResponse.body.partUrls).toHaveLength(2);
    expect(createResponse.body.expiresIn).toBe(3600);

    await uploadPart(
      createResponse.body.partUrls[0].url,
      Buffer.alloc(DEFAULT_MULTIPART_PART_SIZE_BYTES, 'a'),
    );

    const partsResponse: JsonResponse<{
      uploadId: string;
      uploadedParts: {
        partNumber: number;
        eTag: string;
        lastModified: string | null;
      }[];
      missingParts: number[];
    }> = await request(app.getHttpServer())
      .get(`/videos/upload-session/${createResponse.body.videoId}/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .query({ uploadId: createResponse.body.uploadId })
      .expect(200);

    expect(partsResponse.body.uploadId).toBe(createResponse.body.uploadId);
    expect(partsResponse.body.uploadedParts).toHaveLength(1);
    expect(partsResponse.body.uploadedParts[0].partNumber).toBe(1);
    expect(partsResponse.body.missingParts).toEqual([2]);
  }, 30000);

  it('aborts multipart upload sessions and returns 410 for subsequent part checks', async () => {
    const { accessToken, channelId } = await registerConfirmAndLogin(
      'videos.abort@example.com',
    );

    const createResponse: JsonResponse<{
      videoId: string;
      uploadId: string;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        filename: 'video-abort.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/videos/upload-session/${createResponse.body.videoId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const abortedVideo = await videoRepository.findOneBy({
      id: createResponse.body.videoId,
    });
    expect(abortedVideo?.upload_session_id).toBeNull();

    await request(app.getHttpServer())
      .get(`/videos/upload-session/${createResponse.body.videoId}/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .query({ uploadId: createResponse.body.uploadId })
      .expect(410);
  }, 30000);

  it('completes multipart upload and enqueues the canonical processing job', async () => {
    const { accessToken, channelId, userId } = await registerConfirmAndLogin(
      'videos.complete@example.com',
    );

    const createResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      uploadId: string;
      partUrls: { url: string }[];
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        filename: 'video-complete.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
      })
      .expect(201);

    const eTag = await uploadPart(
      createResponse.body.partUrls[0].url,
      Buffer.alloc(DEFAULT_MULTIPART_PART_SIZE_BYTES, 'v'),
    );

    const completeResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      status: string;
      uploadCompletedAt: string;
      jobId: string;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session/complete')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        videoId: createResponse.body.videoId,
        uploadId: createResponse.body.uploadId,
        parts: [{ partNumber: 1, eTag }],
      })
      .expect(200);

    expect(completeResponse.body.jobId).toBe(
      `video-${createResponse.body.videoId}`,
    );
    expect(completeResponse.body.publicId).toBe(createResponse.body.publicId);

    const enqueuedJob = await queue.getJob(completeResponse.body.jobId);

    expect(enqueuedJob?.queueName).toBe(VIDEO_PROCESSING_QUEUE_NAME);
    expect(enqueuedJob?.data).toEqual(
      expect.objectContaining({
        videoId: createResponse.body.videoId,
        publicId: createResponse.body.publicId,
        ownerUserId: userId,
        sourceBucket: 'videos-originals',
        sourceObjectKey: `${createResponse.body.publicId}/original.mp4`,
        storageProvider: 's3',
        uploadSessionId: createResponse.body.uploadId,
        attempt: 1,
      }),
    );
  }, 30000);

  it('returns 400 for invalid completion part payloads and 401 for cross-user access', async () => {
    const owner = await registerConfirmAndLogin(
      'videos.errors.owner@example.com',
    );
    const otherUser = await registerConfirmAndLogin(
      'videos.errors.other@example.com',
    );

    const createResponse: JsonResponse<{
      videoId: string;
      uploadId: string;
      partUrls: { url: string }[];
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        channelId: owner.channelId,
        filename: 'video-invalid.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
      })
      .expect(201);

    const eTag = await uploadPart(
      createResponse.body.partUrls[0].url,
      Buffer.alloc(DEFAULT_MULTIPART_PART_SIZE_BYTES, 'z'),
    );

    await request(app.getHttpServer())
      .post('/videos/upload-session/complete')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        videoId: createResponse.body.videoId,
        uploadId: createResponse.body.uploadId,
        parts: [{ partNumber: 2, eTag }],
      })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/videos/upload-session/${createResponse.body.videoId}/parts`)
      .set('Authorization', `Bearer ${otherUser.accessToken}`)
      .query({ uploadId: createResponse.body.uploadId })
      .expect(403)
      .expect((response: JsonResponse<{ error: string }>) => {
        expect(response.body.error).toBe('VIDEO_ACCESS_DENIED');
      });
  }, 30000);

  it('lists ready videos for anonymous users on GET /channels/{channelId}/videos', async () => {
    const { channelId, userId } =
      await registerConfirmAndLogin('owner@example.com');

    // Create 2 ready videos and 1 draft
    const readyVideo1 = await videoRepository.save({
      public_id: 'ready-1',
      channel_id: channelId,
      owner_user_id: userId,
      status: VideoStatus.READY,
      original_bucket: 'videos-originals',
      original_object_key: 'path/to/video1.mp4',
      thumbnail_bucket: 'videos-public',
      thumbnail_object_key: 'path/to/video1-thumb.jpg',
      draft_created_at: new Date(),
    } as Video);

    const readyVideo2 = await videoRepository.save({
      public_id: 'ready-2',
      channel_id: channelId,
      owner_user_id: userId,
      status: VideoStatus.READY,
      original_bucket: 'videos-originals',
      original_object_key: 'path/to/video2.mp4',
      thumbnail_bucket: 'videos-public',
      thumbnail_object_key: 'path/to/video2-thumb.jpg',
      draft_created_at: new Date(),
      created_at: new Date(readyVideo1.created_at.getTime() - 1000),
    } as Video);
    void readyVideo2; // Intentionally using readyVideo2 to avoid unused variable warning

    await videoRepository.save({
      public_id: 'draft-1',
      channel_id: channelId,
      owner_user_id: userId,
      status: VideoStatus.DRAFT,
      original_bucket: 'videos-originals',
      original_object_key: 'path/to/draft.mp4',
      thumbnail_bucket: 'videos-public',
      thumbnail_object_key: 'path/to/draft-thumb.jpg',
      draft_created_at: new Date(),
    } as Video);

    const response = (await request(app.getHttpServer())
      .get(`/channels/${channelId}/videos`)
      .expect(200)) as JsonResponse<{
      items: Array<{ publicId: string; status: VideoStatus }>;
      page: number;
      limit: number;
      total: number;
    }>;

    expect(response.body.items).toHaveLength(2);
    expect(response.body.page).toBe(1);
    expect(response.body.limit).toBe(10);
    expect(response.body.total).toBe(2);

    // Check ordering (newest first)
    expect(response.body.items[0].publicId).toBe('ready-1');
    expect(response.body.items[1].publicId).toBe('ready-2');

    // Verify draft is not included
    expect(
      response.body.items.every(
        (v: { status: VideoStatus }) => v.status === VideoStatus.READY,
      ),
    ).toBe(true);
  });

  it('lists all videos (including drafts) for channel owner on GET /channels/{channelId}/videos', async () => {
    const { channelId, userId, accessToken } =
      await registerConfirmAndLogin('owner@example.com');

    const readyVideo = await videoRepository.save({
      public_id: 'ready-video',
      channel_id: channelId,
      owner_user_id: userId,
      status: VideoStatus.READY,
      original_bucket: 'videos-originals',
      original_object_key: 'path/to/ready.mp4',
      thumbnail_bucket: 'videos-public',
      thumbnail_object_key: 'path/to/ready-thumb.jpg',
      draft_created_at: new Date(),
    } as Video);

    await videoRepository.save({
      public_id: 'draft-video',
      channel_id: channelId,
      owner_user_id: userId,
      status: VideoStatus.DRAFT,
      original_bucket: 'videos-originals',
      original_object_key: 'path/to/draft.mp4',
      thumbnail_bucket: 'videos-public',
      thumbnail_object_key: 'path/to/draft-thumb.jpg',
      draft_created_at: new Date(),
      created_at: new Date(readyVideo.created_at.getTime() - 1000),
    } as Video);

    const response = (await request(app.getHttpServer())
      .get(`/channels/${channelId}/videos`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)) as JsonResponse<{
      items: Array<{ status: VideoStatus }>;
      total: number;
    }>;

    expect(response.body.items).toHaveLength(2);
    expect(response.body.total).toBe(2);

    // Both statuses should be present
    const statuses = response.body.items.map(
      (v: { status: VideoStatus }) => v.status,
    );
    expect(statuses).toContain(VideoStatus.READY);
    expect(statuses).toContain(VideoStatus.DRAFT);
  });

  it('returns empty list for channel with no videos on GET /channels/{channelId}/videos', async () => {
    const { channelId } = await registerConfirmAndLogin('owner@example.com');

    const response = (await request(app.getHttpServer())
      .get(`/channels/${channelId}/videos`)
      .expect(200)) as JsonResponse<{
      items: unknown[];
      total: number;
      page: number;
      limit: number;
    }>;

    expect(response.body.items).toHaveLength(0);
    expect(response.body.total).toBe(0);
    expect(response.body.page).toBe(1);
    expect(response.body.limit).toBe(10);
  });

  it('validates upload session HTTP contract: POST /videos/upload-session', async () => {
    const { accessToken, channelId } = await registerConfirmAndLogin(
      'e2e.upload@example.com',
    );

    const uploadSessionResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      uploadId: string;
      objectKey: string;
      partUrls: Array<{ partNumber: number; url: string; expiresIn: number }>;
      expiresIn: number;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        filename: 'test-e2e.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES + 1024,
      })
      .expect(201);

    expect(uploadSessionResponse.body.videoId).toBeDefined();
    expect(uploadSessionResponse.body.publicId).toBeDefined();
    expect(uploadSessionResponse.body.uploadId).toBeDefined();
    expect(uploadSessionResponse.body.objectKey).toBeDefined();
    expect(uploadSessionResponse.body.expiresIn).toBe(3600);
    expect(uploadSessionResponse.body.partUrls.length).toBeGreaterThan(0);
    expect(uploadSessionResponse.body.partUrls[0]).toHaveProperty('partNumber');
    expect(uploadSessionResponse.body.partUrls[0]).toHaveProperty('url');
    expect(uploadSessionResponse.body.partUrls[0]).toHaveProperty('expiresIn');
  });

  it('validates multipart upload completion HTTP contract: POST /videos/upload-session/complete', async () => {
    const { accessToken, channelId } = await registerConfirmAndLogin(
      'e2e.complete@example.com',
    );

    // Create session
    const uploadSessionResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      uploadId: string;
      partUrls: Array<{ partNumber: number; url: string }>;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        filename: 'test-e2e.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES + 1024,
      })
      .expect(201);

    const videoId = uploadSessionResponse.body.videoId;
    const uploadId = uploadSessionResponse.body.uploadId;

    // Upload parts
    const parts: Array<{ partNumber: number; eTag: string }> = [];
    for (const partUrl of uploadSessionResponse.body.partUrls) {
      const partBuffer = Buffer.alloc(
        partUrl.partNumber === uploadSessionResponse.body.partUrls.length
          ? 1024
          : DEFAULT_MULTIPART_PART_SIZE_BYTES,
        `part${partUrl.partNumber}`,
      );
      const eTag = await uploadPart(partUrl.url, partBuffer);
      parts.push({ partNumber: partUrl.partNumber, eTag });
    }

    // Complete upload
    const completeResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      status: string;
      uploadCompletedAt: string;
      jobId: string;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session/complete')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        videoId,
        uploadId,
        parts,
      })
      .expect(200);

    expect(completeResponse.body.videoId).toBe(videoId);
    expect(completeResponse.body.publicId).toBeDefined();
    expect(completeResponse.body.status).toBe('draft');
    expect(completeResponse.body.uploadCompletedAt).toBeDefined();
    expect(completeResponse.body.jobId).toBe(`video-${videoId}`);

    const enqueuedJob = await queue.getJob(completeResponse.body.jobId);
    expect(enqueuedJob).toBeDefined();
  });

  it('validates video access control HTTP contract (draft videos)', async () => {
    const { accessToken: ownerToken, channelId: ownerChannelId } =
      await registerConfirmAndLogin('e2e.owner@example.com');
    const { accessToken: otherToken } = await registerConfirmAndLogin(
      'e2e.other@example.com',
    );

    // Owner creates draft video
    const uploadSessionResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      uploadId: string;
      partUrls: Array<{ partNumber: number; url: string }>;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        channelId: ownerChannelId,
        filename: 'test-draft.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES + 1024,
      })
      .expect(201);

    const publicId = uploadSessionResponse.body.publicId;

    // Owner can access their draft
    await request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    // Other user cannot access draft
    await request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    // Anonymous cannot access draft
    await request(app.getHttpServer()).get(`/videos/${publicId}`).expect(403);
  });

  it('validates 404 for non-existent video', async () => {
    const { accessToken } = await registerConfirmAndLogin(
      'e2e.notfound@example.com',
    );

    await request(app.getHttpServer())
      .get('/videos/nonexistent-public-id')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });

  it('validates 401 for unauthenticated upload session', async () => {
    // Missing Authorization header
    await request(app.getHttpServer())
      .post('/videos/upload-session')
      .send({
        channelId: 'some-id',
        filename: 'test.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(401);
  });

  it('validates 400 for invalid upload session params', async () => {
    const { accessToken, channelId } = await registerConfirmAndLogin(
      'e2e.invalid@example.com',
    );

    // Missing filename
    await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        contentType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(400);

    // Invalid size
    await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        filename: 'test.mp4',
        contentType: 'video/mp4',
        sizeBytes: 0,
      })
      .expect(400);
  });

  it('returns 403 when non-owner tries to access draft video on GET /videos/{publicId}', async () => {
    const owner = await registerConfirmAndLogin('e2e.owner@example.com');
    const otherUser = await registerConfirmAndLogin('e2e.other@example.com');

    // Create a draft video as owner
    const uploadResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      uploadId: string;
      partUrls: Array<{ url: string }>;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        channelId: owner.channelId,
        filename: 'draft-video.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
      })
      .expect(201);

    // Try to access draft as other user
    await request(app.getHttpServer())
      .get(`/videos/${uploadResponse.body.publicId}`)
      .set('Authorization', `Bearer ${otherUser.accessToken}`)
      .expect(403);
  });

  it('returns 404 for non-existent video on GET /videos/{publicId}', async () => {
    await request(app.getHttpServer()).get('/videos/nonexistent').expect(404);
  });

  it('returns 401 for accessing stream URL without proper authorization', async () => {
    const owner = await registerConfirmAndLogin('e2e.stream.owner@example.com');
    const otherUser = await registerConfirmAndLogin(
      'e2e.stream.other@example.com',
    );

    // Create and complete upload as owner
    const uploadResponse: JsonResponse<{
      videoId: string;
      publicId: string;
      uploadId: string;
      partUrls: Array<{ url: string }>;
    }> = await request(app.getHttpServer())
      .post('/videos/upload-session')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        channelId: owner.channelId,
        filename: 'stream-test.mp4',
        contentType: 'video/mp4',
        sizeBytes: DEFAULT_MULTIPART_PART_SIZE_BYTES,
      })
      .expect(201);

    // Keep it as draft (don't process it)
    // Try to access stream as other user (should fail - draft is not accessible)
    await request(app.getHttpServer())
      .get(`/videos/${uploadResponse.body.publicId}/stream`)
      .set('Authorization', `Bearer ${otherUser.accessToken}`)
      .expect(403);
  });
});
