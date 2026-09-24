import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE_NAME,
  VIDEO_PROCESSING_CONCURRENCY,
} from '../queue/video-processing.constants';
import { VideoProcessRequestedPayload } from '../queue/video-process-requested.payload';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE_NAME, {
  concurrency: VIDEO_PROCESSING_CONCURRENCY,
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  /**
   * Process a video job from the queue
   *
   * JobId format: video-${videoId}
   * This ensures deduplication at the queue level
   */
  async process(
    job: Job<VideoProcessRequestedPayload, void, string>,
  ): Promise<void> {
    const { videoId, publicId } = job.data;
    const attemptNumber = job.attemptsMade + 1;

    this.logger.log(
      `[Job ${job.id}] Processing video ${videoId} (${publicId}) - Attempt ${attemptNumber}/${job.opts.attempts}`,
    );

    try {
      const result = await this.videoProcessingService.processVideo(
        job.data,
        attemptNumber,
      );

      this.logger.log(
        `[Job ${job.id}] Video ${videoId} processed with status: ${result.status}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[Job ${job.id}] Video ${videoId} processing failed: ${errorMessage}`,
        error instanceof Error ? error.stack : '',
      );

      // Rethrow to let BullMQ handle retry logic
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onCompleted(job: Job<VideoProcessRequestedPayload>): Promise<void> {
    this.logger.log(`[Job ${job.id}] Completed: video ${job.data.videoId}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onFailed(
    job: Job<VideoProcessRequestedPayload> | undefined,
    error: Error,
  ): Promise<void> {
    const jobId = job?.id ?? 'unknown';
    const videoId = job?.data?.videoId ?? 'unknown';
    this.logger.error(
      `[Job ${jobId}] Failed: video ${videoId} - ${error.message}`,
      error.stack,
    );
  }
}
