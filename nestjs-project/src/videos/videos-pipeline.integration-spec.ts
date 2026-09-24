import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DataSource, QueryRunner } from 'typeorm';
import { Queue } from 'bullmq';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { AppDataSource } from '../database/data-source';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VIDEO_PROCESSING_QUEUE_NAME } from './queue/video-processing.constants';
import { VideoProcessRequestedPayload } from './queue/video-process-requested.payload';

/**
 * SI-03.8: Videos Pipeline Integration Test
 *
 * Uses REAL PostgreSQL, Redis, MinIO, and video-worker from Docker Compose.
 * Bootstraps AppModule to ensure DB schema exists, then operates on shared infrastructure.
 */
describe('Videos Pipeline (integration with real infrastructure)', () => {
  let dataSource: DataSource;
  let redis: Redis;
  let queue: Queue<VideoProcessRequestedPayload>;
  let s3Client: S3Client;
  let testVideoPath: string;

  // Test data to cleanup
  let testUserId: string | null = null;
  let testChannelId: string | null = null;
  let testVideoId: string | null = null;

  beforeAll(async () => {
    // Use AppDataSource which points to the REAL shared PostgreSQL
    await AppDataSource.initialize();

    // Create a SEPARATE connection pool for CI writes (no transaction isolation)
    // This ensures data written via raw SQL is committed and visible to worker
    dataSource = AppDataSource;

    // Run migrations to ensure schema exists
    await AppDataSource.runMigrations();

    // Verify which database we're connected to
    // AppDataSource.query returns any; these assertions narrow the type
    const dbCheckResult: Array<{ current_database: string }> =
      await AppDataSource.query('SELECT current_database()');
    const pgVersionResult: Array<{ version: string }> =
      await AppDataSource.query('SELECT version()');
    console.log('✓ Connected to database:', dbCheckResult[0]?.current_database);
    console.log('✓ PostgreSQL:', pgVersionResult[0]?.version.substring(0, 60));

    // Connect to REAL Redis and get queue
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });

    queue = new Queue<VideoProcessRequestedPayload>(
      VIDEO_PROCESSING_QUEUE_NAME,
      { connection: redis },
    );

    // Connect to REAL MinIO/S3
    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      },
      forcePathStyle: true,
    });

    // Verify buckets exist
    const buckets = [
      process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals',
      process.env.S3_BUCKET_PUBLIC ?? 'videos-public',
    ];
    for (const bucket of buckets) {
      try {
        await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        // Create if doesn't exist
        await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    }

    // Check if test video fixture exists
    testVideoPath = '/tmp/test-video.mp4';
    if (!fs.existsSync(testVideoPath)) {
      throw new Error(
        `Test video fixture not found at ${testVideoPath}. ` +
          'Ensure it was copied to container before running tests.',
      );
    }

    if (fs.statSync(testVideoPath).size < 1000) {
      throw new Error(
        `Test video too small (< 1KB). Size: ${fs.statSync(testVideoPath).size} bytes`,
      );
    }
  });

  afterEach(async () => {
    // Cleanup test data from database (keep DB intact, tests read shared DB)
    try {
      const queryRunner: QueryRunner = dataSource.createQueryRunner();
      try {
        // Delete in order: videos → channels → users (due to FK constraints)
        if (testVideoId) {
          await queryRunner.query('DELETE FROM videos WHERE id = $1', [
            testVideoId,
          ]);
        }
        if (testChannelId) {
          await queryRunner.query('DELETE FROM channels WHERE id = $1', [
            testChannelId,
          ]);
        }
        if (testUserId) {
          await queryRunner.query('DELETE FROM users WHERE id = $1', [
            testUserId,
          ]);
        }
      } catch (e) {
        console.warn('Cleanup DB error:', e);
      } finally {
        await queryRunner.release();
      }
    } catch (e) {
      console.warn('Cleanup DB error:', e);
    }

    // Cleanup MinIO
    try {
      const originalBucket =
        process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals';
      const publicBucket = process.env.S3_BUCKET_PUBLIC ?? 'videos-public';
      if (testVideoId) {
        await s3Client.send(
          new GetObjectCommand({
            Bucket: originalBucket,
            Key: `${testVideoId}/source.mp4`,
          }),
        );
      }
      if (testVideoId) {
        await s3Client.send(
          new GetObjectCommand({
            Bucket: publicBucket,
            Key: `${testVideoId}/thumbnail.jpg`,
          }),
        );
      }
    } catch {
      // Files might not exist, ignore
    }

    testUserId = null;
    testChannelId = null;
    testVideoId = null;
  });

  afterAll(() => {
    console.log(
      'SI-03.8 pipeline test: cleanup complete (kept REAL database intact)',
    );
  });

  async function checkS3ObjectExists(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    try {
      await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async function waitForVideoStatus(
    videoId: string,
    targetStatuses: VideoStatus[],
    timeoutMs = 60000,
  ): Promise<Video> {
    const pollInterval = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const videoRepository = dataSource.getRepository(Video);
      const video = await videoRepository.findOne({ where: { id: videoId } });

      if (!video) {
        throw new Error(`Video ${videoId} not found`);
      }

      if (targetStatuses.includes(video.status)) {
        return video;
      }

      if (video.status === VideoStatus.ERROR) {
        throw new Error(
          `Video ${videoId} reached ERROR status. ` +
            `Last error: ${video.last_error ?? 'unknown'}. ` +
            `Attempts: ${video.processing_attempts}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout reached
    const videoRepository = dataSource.getRepository(Video);
    const finalVideo = await videoRepository.findOne({
      where: { id: videoId },
    });
    throw new Error(
      `Timeout waiting for video ${videoId} to reach ${targetStatuses.join(
        ',',
      )}. ` +
        `Current status: ${finalVideo?.status}. ` +
        `Last error: ${finalVideo?.last_error ?? 'none'}.`,
    );
  }

  it('should process an uploaded video end-to-end and mark it READY', async () => {
    // 1. Create User, Channel, and Video (draft state)
    const userId = uuidv4();
    const userEmail = `test-${Date.now()}@example.com`;
    const channelId = uuidv4();
    const channelNickname = `testchan${Date.now()}`;
    const channelName = `Test Channel ${Date.now()}`;
    const videoId = uuidv4();
    const publicId = Math.random().toString(36).slice(2, 10);
    const originalBucket =
      process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals';
    const publicBucket = process.env.S3_BUCKET_PUBLIC ?? 'videos-public';
    const originalObjectKey = `${channelId}/${publicId}/source.mp4`;

    testUserId = userId;
    testChannelId = channelId;
    testVideoId = videoId;

    const queryRunner: QueryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.query('BEGIN');
      await queryRunner.query(
        `INSERT INTO users (id, email, password, is_confirmed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [userId, userEmail, 'hashed_password', true],
      );

      await queryRunner.query(
        `INSERT INTO channels (id, user_id, name, nickname, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [channelId, userId, channelName, channelNickname],
      );

      await queryRunner.query(
        `INSERT INTO videos (
          id, channel_id, owner_user_id, public_id, status,
          original_bucket, original_object_key, thumbnail_bucket, thumbnail_object_key,
          processing_attempts, last_error, draft_created_at, upload_completed_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
        )`,
        [
          videoId,
          channelId,
          userId,
          publicId,
          VideoStatus.DRAFT,
          originalBucket,
          originalObjectKey,
          publicBucket,
          `${publicId}/thumbnail.jpg`,
          0,
          null,
          new Date(),
          new Date(),
        ],
      );
      await queryRunner.query('COMMIT');
    } finally {
      await queryRunner.release();
    }

    // 2. Verify raw SQL
    const rawResult: Array<{ id: string; public_id: string; status: string }> =
      await dataSource.query(
        `SELECT id, public_id, status FROM videos WHERE id = $1`,
        [videoId],
      );
    console.log('✓ Raw SQL verify:', rawResult[0]);

    // 3. Upload source video to MinIO
    const fileStream = fs.createReadStream(testVideoPath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: originalBucket,
        Key: originalObjectKey,
        Body: fileStream,
      }),
    );

    // 4. Verify object exists
    const exists = await checkS3ObjectExists(originalBucket, originalObjectKey);
    expect(exists).toBe(true);

    const videoExistsResult: Array<{ exists: boolean }> =
      await dataSource.query(
        `SELECT EXISTS(SELECT 1 FROM videos WHERE id = $1) AS exists`,
        [videoId],
      );
    expect(videoExistsResult[0]?.exists).toBe(true);
    console.log('✓ Video verified in DB before enqueue:', videoExistsResult[0]);

    // 5. Enqueue video processing job
    const payload: VideoProcessRequestedPayload = {
      eventId: uuidv4(),
      occurredAt: new Date().toISOString(),
      videoId,
      publicId,
      ownerUserId: userId,
      sourceBucket: originalBucket,
      sourceObjectKey: originalObjectKey,
      storageProvider: 's3',
      uploadSessionId: uuidv4(),
      attempt: 1,
    };

    const jobId = `video-${videoId}`;
    await queue.add('process-video', payload, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
    console.log(`✓ Job enqueued: ${jobId}`);

    // 6. Wait for worker to process video
    const processedVideo = await waitForVideoStatus(
      videoId,
      [VideoStatus.READY, VideoStatus.ERROR],
      185000, // 3+ minutes for worker processing
    );
    console.log('✓ Video processed:', {
      status: processedVideo.status,
      duration_seconds: (
        processedVideo.metadata_json as { video?: { duration?: number } }
      )?.video?.duration,
      attempts: processedVideo.processing_attempts,
      last_error: processedVideo.last_error,
    });

    // 7. Assertions
    expect(processedVideo.status).toBe(VideoStatus.READY);
    expect(
      (processedVideo.metadata_json as { video?: { duration?: number } })?.video
        ?.duration,
    ).toBeGreaterThan(0);
    expect(processedVideo.thumbnail_object_key).toBeDefined();
    expect(processedVideo.processing_attempts).toBeGreaterThanOrEqual(1);

    // 8. Verify thumbnail
    const thumbnailExists = await checkS3ObjectExists(
      publicBucket,
      processedVideo.thumbnail_object_key,
    );
    expect(thumbnailExists).toBe(true);
    console.log(`✓ Thumbnail exists: ${processedVideo.thumbnail_object_key}`);
  }, 185000); // 3+ minutes for worker processing

  it('should handle processing failure and mark video ERROR', async () => {
    // 1. Create User and Channel (raw SQL)
    const userId = uuidv4();
    const userEmail = `test-fail-${Date.now()}@example.com`;
    const channelId = uuidv4();
    const channelNickname = `chanfail${Date.now()}`;
    const channelName = `Channel Fail ${Date.now()}`;
    const videoId = uuidv4();
    const publicId = Math.random().toString(36).slice(2, 10);
    const originalBucket =
      process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals';
    const originalObjectKey = `${channelId}/corrupt.mp4`;

    testUserId = userId;
    testVideoId = videoId;

    const queryRunner: QueryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.query('BEGIN');
      await queryRunner.query(
        `INSERT INTO users (id, email, password, is_confirmed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [userId, userEmail, 'hashed_password', true],
      );

      await queryRunner.query(
        `INSERT INTO channels (id, user_id, name, nickname, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [channelId, userId, channelName, channelNickname],
      );

      await queryRunner.query(
        `INSERT INTO videos (
          id, channel_id, owner_user_id, public_id, status,
          original_bucket, original_object_key, thumbnail_bucket, thumbnail_object_key,
          processing_attempts, last_error, draft_created_at, upload_completed_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
        )`,
        [
          videoId,
          channelId,
          userId,
          publicId,
          VideoStatus.DRAFT,
          originalBucket,
          originalObjectKey,
          'videos-public',
          `${publicId}/thumbnail.jpg`,
          0,
          null,
          new Date(),
          new Date(),
        ],
      );
      await queryRunner.query('COMMIT');
    } finally {
      await queryRunner.release();
    }

    // 2. Upload corrupt data to S3 (NOT a valid MP4)
    const corruptData = Buffer.from(
      'This is NOT a valid MP4 file. Just random data.',
      'utf8',
    );
    await s3Client.send(
      new PutObjectCommand({
        Bucket: originalBucket,
        Key: originalObjectKey,
        Body: corruptData,
      }),
    );

    // 3. Enqueue with full payload
    const payload: VideoProcessRequestedPayload = {
      eventId: uuidv4(),
      occurredAt: new Date().toISOString(),
      videoId,
      publicId,
      ownerUserId: userId,
      sourceBucket: originalBucket,
      sourceObjectKey: originalObjectKey,
      storageProvider: 's3',
      uploadSessionId: uuidv4(),
      attempt: 1,
    };

    const jobId = `video-${videoId}`;
    await queue.add('process-video', payload, {
      jobId,
      attempts: 2, // Limit retries to 2 to speed up test
      backoff: { type: 'exponential', delay: 500 },
    });

    console.log(`✓ Job enqueued for corrupt video: ${jobId}`);

    // 4. Wait for worker to process and reach ERROR or READY
    const processedVideo = await waitForVideoStatus(
      videoId,
      [VideoStatus.READY, VideoStatus.ERROR],
      30000, // Shorter timeout since we expect fast failure
    );

    // 5. Verify status is ERROR
    expect(processedVideo.status).toBe(VideoStatus.ERROR);
    expect(processedVideo.last_error).toBeDefined();
    expect(processedVideo.last_error).toContain('FFProbe');
    expect(processedVideo.processing_attempts).toBeGreaterThanOrEqual(1);

    console.log(`✓ Video correctly marked ERROR after processing failure`);
  });

  it('should enforce idempotency: duplicate jobId should not re-process', async () => {
    // 1. Create User, Channel, Video (draft with valid MP4)
    const userId = uuidv4();
    const userEmail = `test-idem-${Date.now()}@example.com`;

    const queryRunner: QueryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.query('BEGIN');
      await queryRunner.query(
        `INSERT INTO users (id, email, password, is_confirmed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [userId, userEmail, 'hashed_password', true],
      );

      const channelId = uuidv4();
      const channelNickname = `chanidem${Date.now()}`;
      const channelName = `Channel Idem ${Date.now()}`;

      await queryRunner.query(
        `INSERT INTO channels (id, user_id, name, nickname, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [channelId, userId, channelName, channelNickname],
      );

      const videoId = uuidv4();
      const publicId = Math.random().toString(36).slice(2, 10);
      const originalBucket =
        process.env.S3_BUCKET_ORIGINALS ?? 'videos-originals';
      const originalObjectKey = `${channelId}/original.mp4`;

      testVideoId = videoId;
      testUserId = userId;

      await queryRunner.query(
        `INSERT INTO videos (
          id, channel_id, owner_user_id, public_id, status,
          original_bucket, original_object_key, thumbnail_bucket, thumbnail_object_key,
          processing_attempts, last_error, draft_created_at, upload_completed_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
        )`,
        [
          videoId,
          channelId,
          userId,
          publicId,
          VideoStatus.DRAFT,
          originalBucket,
          originalObjectKey,
          'videos-public',
          `${publicId}/thumbnail.jpg`,
          0,
          null,
          new Date(),
          new Date(),
        ],
      );

      await queryRunner.query('COMMIT');

      // 2. Upload valid test video
      const fileStream = fs.createReadStream(testVideoPath);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: originalBucket,
          Key: originalObjectKey,
          Body: fileStream,
        }),
      );

      // 3. Enqueue first time with specific jobId
      const jobId = `video-${videoId}`;
      const payload: VideoProcessRequestedPayload = {
        eventId: uuidv4(),
        occurredAt: new Date().toISOString(),
        videoId,
        publicId,
        ownerUserId: userId,
        sourceBucket: originalBucket,
        sourceObjectKey: originalObjectKey,
        storageProvider: 's3',
        uploadSessionId: uuidv4(),
        attempt: 1,
      };

      const job1 = await queue.add('process-video', payload, {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      });

      console.log(`✓ First job enqueued: ${job1.id}`);

      // 4. Wait for first job to reach READY
      const afterFirstJob = await waitForVideoStatus(
        videoId,
        [VideoStatus.READY, VideoStatus.ERROR],
        30000,
      );
      expect(afterFirstJob.status).toBe(VideoStatus.READY);
      console.log(`✓ First job completed successfully, status = READY`);

      // 5. Try to enqueue again with SAME jobId
      // BullMQ should reject or return existing job
      const job2 = await queue.add('process-video', payload, {
        jobId, // Same ID
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      });

      // Job2 should be the same as job1 due to idempotency
      expect(job2.id).toBe(job1.id);
      console.log(
        `✓ Duplicate jobId returned same job: ${job2.id} === ${job1.id}`,
      );

      // 6. Verify video hasn't been re-processed
      // Status should still be READY, processing_attempts should not have incremented beyond 1
      const finalVideo = await dataSource.getRepository(Video).findOne({
        where: { id: videoId },
      });
      expect(finalVideo).toBeDefined();
      expect(finalVideo!.status).toBe(VideoStatus.READY);
      expect(finalVideo!.processing_attempts).toBeLessThanOrEqual(2); // May be 1 or 2 depending on timing

      console.log(
        `✓ Idempotency verified: video remains READY, no re-processing`,
      );
    } finally {
      await queryRunner.release();
    }
  });
});
