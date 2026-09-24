import {
  getVideoProcessingJobId,
  getVideoProcessingJobOptions,
  VIDEO_PROCESSING_ATTEMPTS,
  VIDEO_PROCESSING_BACKOFF_DELAY_MS,
  VIDEO_PROCESSING_CONCURRENCY,
  VIDEO_PROCESSING_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
  VIDEO_PROCESS_REQUESTED_JOB_TYPE,
} from './video-processing.constants';
import { VideoProcessRequestedPayload } from './video-process-requested.payload';

describe('video-processing queue configuration', () => {
  it('matches the phase 03 queue contract', () => {
    expect(VIDEO_PROCESSING_QUEUE_NAME).toBe('video-processing');
    expect(VIDEO_PROCESSING_JOB_NAME).toBe('process-video');
    expect(VIDEO_PROCESS_REQUESTED_JOB_TYPE).toBe('video.process.requested');
    expect(VIDEO_PROCESSING_ATTEMPTS).toBe(5);
    expect(VIDEO_PROCESSING_BACKOFF_DELAY_MS).toBe(2000);
    expect(VIDEO_PROCESSING_CONCURRENCY).toBe(2);
  });

  it('builds canonical job id and retries for a requested payload', () => {
    const payload: VideoProcessRequestedPayload = {
      eventId: 'evt-123',
      occurredAt: '2026-09-23T21:45:14.981Z',
      videoId: 'video-123',
      publicId: 'public123456',
      ownerUserId: 'owner-123',
      sourceBucket: 'videos-originals',
      sourceObjectKey: 'public123456/original.mp4',
      storageProvider: 's3',
      uploadSessionId: 'upload-123',
      attempt: 1,
    };

    expect(getVideoProcessingJobId(payload.videoId)).toBe('video-video-123');
    expect(getVideoProcessingJobOptions(payload.videoId)).toMatchObject({
      jobId: 'video-video-123',
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });
  });
});
