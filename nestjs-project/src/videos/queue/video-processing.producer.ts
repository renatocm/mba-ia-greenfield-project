import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VideoProcessRequestedPayload } from './video-process-requested.payload';
import {
  getVideoProcessingJobId,
  getVideoProcessingJobOptions,
  VIDEO_PROCESSING_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
  VIDEO_PROCESS_REQUESTED_JOB_TYPE,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  private readonly logger = new Logger(VideoProcessingProducer.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE_NAME)
    private readonly queue: Queue<VideoProcessRequestedPayload>,
  ) {}

  async enqueueProcessRequested(
    payload: VideoProcessRequestedPayload,
  ): Promise<string> {
    const jobId = getVideoProcessingJobId(payload.videoId);

    await this.queue.add(
      VIDEO_PROCESSING_JOB_NAME,
      payload,
      getVideoProcessingJobOptions(payload.videoId),
    );

    this.logger.log(`Enqueued ${VIDEO_PROCESS_REQUESTED_JOB_TYPE} as ${jobId}`);

    return jobId;
  }
}
