import { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE_NAME = 'video-processing';
export const VIDEO_PROCESSING_JOB_NAME = 'process-video';
export const VIDEO_PROCESS_REQUESTED_JOB_TYPE = 'video.process.requested';
export const VIDEO_PROCESSING_ATTEMPTS = 5;
export const VIDEO_PROCESSING_BACKOFF_DELAY_MS = 2000;
export const VIDEO_PROCESSING_CONCURRENCY = 2;

export function getVideoProcessingJobId(videoId: string): string {
  return `video-${videoId}`;
}

export function getVideoProcessingBaseJobOptions(): JobsOptions {
  return {
    attempts: VIDEO_PROCESSING_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: VIDEO_PROCESSING_BACKOFF_DELAY_MS,
    },
  };
}

export function getVideoProcessingJobOptions(videoId: string): JobsOptions {
  return {
    ...getVideoProcessingBaseJobOptions(),
    jobId: getVideoProcessingJobId(videoId),
  };
}
