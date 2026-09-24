import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { VideoProcessRequestedPayload } from './video-process-requested.payload';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  VIDEO_PROCESSING_ATTEMPTS,
  VIDEO_PROCESSING_BACKOFF_DELAY_MS,
  VIDEO_PROCESSING_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
} from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing.queue';

describe('VideoProcessingProducer (integration)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<VideoProcessRequestedPayload>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
        }),
        VideoProcessingQueueModule,
      ],
    }).compile();

    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get<Queue<VideoProcessRequestedPayload>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE_NAME),
    );
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  function buildPayload(videoId: string): VideoProcessRequestedPayload {
    return {
      eventId: `evt-${videoId}`,
      occurredAt: '2026-09-23T21:45:14.981Z',
      videoId,
      publicId: `pub-${videoId}`,
      ownerUserId: `owner-${videoId}`,
      sourceBucket: 'videos-originals',
      sourceObjectKey: `pub-${videoId}/original.mp4`,
      storageProvider: 's3',
      uploadSessionId: `upload-${videoId}`,
      attempt: 1,
    };
  }

  it('enqueues the canonical video processing job with retry and backoff settings', async () => {
    const payload = buildPayload('video-a');

    const jobId = await producer.enqueueProcessRequested(payload);
    const job = await queue.getJob(jobId);

    expect(jobId).toBe('video-video-a');
    expect(job?.name).toBe(VIDEO_PROCESSING_JOB_NAME);
    expect(job?.data).toEqual(payload);
    expect(job?.opts.attempts).toBe(VIDEO_PROCESSING_ATTEMPTS);
    expect(job?.opts.backoff).toEqual({
      type: 'exponential',
      delay: VIDEO_PROCESSING_BACKOFF_DELAY_MS,
    });
  });

  it('deduplicates enqueues by the canonical video job id', async () => {
    const payload = buildPayload('video-b');

    const jobId1 = await producer.enqueueProcessRequested(payload);
    expect(jobId1).toBe('video-video-b');

    // Verify first job exists
    const job1 = await queue.getJob('video-video-b');
    expect(job1).toBeDefined();
    expect(job1?.data.eventId).toBe('evt-video-b');

    // Enqueue same video again with different eventId
    // BullMQ deduplicates by jobId: the same jobId cannot have multiple jobs in queue
    const jobId2 = await producer.enqueueProcessRequested({
      ...payload,
      eventId: 'evt-video-b-second',
    });

    // Should return same jobId (deduplication)
    expect(jobId2).toBe('video-video-b');

    // Verify only one job exists with original data
    // The key deduplication behavior: a second enqueue with the same jobId
    // does not create a duplicate; it returns the existing jobId
    // BullMQ enforces this at the jobId uniqueness level

    // Verify the job still has the original data (not updated by second enqueue)
    const job2 = await queue.getJob('video-video-b');
    expect(job2).toBeDefined();
    expect(job2?.id).toBe('video-video-b');
    expect(job2?.data.eventId).toBe('evt-video-b'); // Original, not updated
  });
});
