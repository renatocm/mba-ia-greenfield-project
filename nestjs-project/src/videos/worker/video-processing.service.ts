import { Injectable, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Video } from '../entities/video.entity';
import { VideoRepository } from '../repositories/video.repository';
import { S3Service } from '../storage/s3.service';
import { VideoStatus } from '../video-status.enum';
import { VideoProcessRequestedPayload } from '../queue/video-process-requested.payload';
import {
  extractMetadataWithFFProbe,
  calculateThumbnailTimestamp,
  FFProbeMetadata,
} from '../utils/ffprobe.util';
import {
  generateThumbnailWithFFmpeg,
  readThumbnailFile,
  deleteThumbnailFile,
} from '../utils/thumbnail.util';

export interface VideoProcessingResult {
  videoId: string;
  status: VideoStatus;
  duration?: number;
  metadata?: FFProbeMetadata;
  thumbnailUrl?: string;
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly videoRepository: VideoRepository,
    private readonly s3Service: S3Service,
    @InjectRepository(Video)
    private readonly videoEntityRepository: Repository<Video>,
  ) {}

  /**
   * Process a video job: download, extract metadata, generate thumbnail, persist changes
   */
  async processVideo(
    payload: VideoProcessRequestedPayload,
    attemptNumber: number,
  ): Promise<VideoProcessingResult> {
    const { videoId, publicId, sourceBucket, sourceObjectKey } = payload;

    this.logger.debug(
      `Processing video ${videoId} (${publicId}) - Attempt ${attemptNumber}`,
    );

    // 1. Preflight: Check if video is already processed
    const video = await this.videoRepository.findByIdWithRelations(videoId);
    if (!video) {
      throw new Error(`Video not found: ${videoId}`);
    }

    if (video.status === VideoStatus.READY) {
      this.logger.debug(`Video already ready: ${videoId} - skipping`);
      return {
        videoId,
        status: VideoStatus.READY,
      };
    }

    if (video.status === VideoStatus.PROCESSING) {
      // Check if another concurrent execution is happening (should not happen with jobId dedup)
      // Just proceed with this execution
      this.logger.debug(`Video is processing: ${videoId}`);
    }

    try {
      // 2. Transition to PROCESSING
      video.status = VideoStatus.PROCESSING;
      video.processing_started_at = new Date();
      video.processing_attempts = attemptNumber;
      video.last_error = null;
      video.last_error_at = null;
      video.last_error_stack_trace = null;
      await this.videoEntityRepository.save(video);

      // 3. Download video from storage
      const tempVideoPath = await this.downloadVideoToTemp(
        sourceBucket,
        sourceObjectKey,
        publicId,
      );

      try {
        // 4. Extract metadata with ffprobe
        let metadata: FFProbeMetadata | null = null;
        const existingMetadata = this.getPersistedMetadata(video);

        if (existingMetadata) {
          // Skip ffprobe if metadata already exists (partial failure recovery)
          this.logger.debug(
            `Metadata already exists for ${videoId} - skipping ffprobe`,
          );
          metadata = existingMetadata;
        } else {
          metadata = await this.extractMetadata(tempVideoPath, videoId);

          // 5. Persist metadata immediately after ffprobe success
          video.metadata_json = this.withMetadata(video.metadata_json, {
            duration: metadata.duration,
            resolution: metadata.resolution,
            bitrate: metadata.bitrate,
            codec: metadata.codec,
            fps: metadata.fps,
            extracted_at: new Date().toISOString(),
          });
          await this.videoEntityRepository.save(video);
          this.logger.debug(
            `Metadata persisted for ${videoId}: duration ${metadata.duration}s`,
          );
        }

        // 6. Generate thumbnail
        let thumbnailUrl: string | null = null;
        try {
          const timestamp = calculateThumbnailTimestamp(metadata.duration);
          thumbnailUrl = await this.generateAndUploadThumbnail(
            tempVideoPath,
            video,
            timestamp,
          );
          this.logger.debug(`Thumbnail generated and uploaded for ${videoId}`);
        } catch (thumbnailError) {
          // Thumbnail failure is not fatal - log but continue
          this.logger.warn(
            `Thumbnail generation failed for ${videoId}: ${thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError)}`,
          );

          // After 5 attempts, allow ready status without thumbnail
          if (attemptNumber >= 5) {
            this.logger.log(
              `Allowing ${videoId} to complete without thumbnail after 5 attempts`,
            );
            thumbnailUrl = null;
          } else {
            // Rethrow to trigger retry
            throw thumbnailError;
          }
        }

        // 7. Transition to READY
        video.status = VideoStatus.READY;
        video.processing_completed_at = new Date();
        await this.videoEntityRepository.save(video);

        this.logger.log(`Video ${videoId} processed successfully`);

        return {
          videoId,
          status: VideoStatus.READY,
          duration: metadata.duration,
          metadata,
          ...(thumbnailUrl && { thumbnailUrl }),
        };
      } finally {
        // Cleanup temp file
        await this.cleanupTempFile(tempVideoPath);
      }
    } catch (error) {
      // 8. Handle errors: transition to ERROR and record failure
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const stackTrace =
        error instanceof Error && error.stack ? error.stack : null;

      this.logger.error(
        `Video processing failed for ${videoId}: ${errorMessage}`,
        stackTrace ?? 'No stack trace',
      );

      video.status = VideoStatus.ERROR;
      video.last_error = errorMessage;
      video.last_error_at = new Date();
      video.last_error_stack_trace = stackTrace;
      await this.videoEntityRepository.save(video);

      // BullMQ will handle retries based on job config
      throw error;
    }
  }

  /**
   * Download video file from S3 to temporary location
   */
  private async downloadVideoToTemp(
    bucket: string,
    objectKey: string,
    publicId: string,
  ): Promise<string> {
    const tempDir = path.join(os.tmpdir(), 'video-processing');
    const tempFilePath = path.join(tempDir, `${publicId}-source.mp4`);

    try {
      // Ensure temp directory exists
      await fs.promises.mkdir(tempDir, { recursive: true });

      this.logger.debug(
        `Downloading video from S3: bucket=${bucket}, key=${objectKey}, tempFile=${tempFilePath}`,
      );
      await this.s3Service.downloadObject(bucket, objectKey, tempFilePath);
      return tempFilePath;
    } catch (error) {
      const cause =
        error instanceof Error && 'cause' in error ? error.cause : null;
      const causeMessage =
        cause instanceof Error ? cause.message : String(cause);
      this.logger.error(
        `Failed to download video from storage: ${error instanceof Error ? error.message : String(error)}`,
        `Cause: ${causeMessage}`,
      );
      throw new Error(
        `Failed to download video from storage: ${error instanceof Error ? error.message : String(error)} (cause: ${causeMessage})`,
      );
    }
  }

  /**
   * Extract metadata using ffprobe
   */
  private async extractMetadata(
    videoPath: string,
    videoId: string,
  ): Promise<FFProbeMetadata> {
    try {
      const metadata = await extractMetadataWithFFProbe(videoPath);
      return metadata;
    } catch (error) {
      throw new Error(
        `Failed to extract metadata for ${videoId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Generate thumbnail and upload to storage
   */
  private async generateAndUploadThumbnail(
    videoPath: string,
    video: Video,
    timestamp: number,
  ): Promise<string> {
    const tempDir = path.join(os.tmpdir(), 'video-processing');
    const tempThumbnailPath = path.join(
      tempDir,
      `${video.public_id}-thumb.jpg`,
    );

    try {
      // Generate thumbnail locally
      await generateThumbnailWithFFmpeg({
        videoFilePath: videoPath,
        timestamp,
        outputFilePath: tempThumbnailPath,
        width: 320,
        height: 240,
      });

      // Read thumbnail file
      const thumbnailBuffer = await readThumbnailFile(tempThumbnailPath);

      // Upload to storage
      await this.s3Service.uploadObject(
        video.thumbnail_bucket,
        video.thumbnail_object_key,
        thumbnailBuffer,
        'image/jpeg',
      );

      return video.thumbnail_object_key;
    } finally {
      // Cleanup temp file
      await deleteThumbnailFile(tempThumbnailPath);
    }
  }

  /**
   * Get persisted metadata from video record
   */
  private getPersistedMetadata(video: Video): FFProbeMetadata | null {
    const metadata = video.metadata_json;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const videoMeta = metadata['video'] as Record<string, unknown> | undefined;
    if (
      !videoMeta ||
      typeof videoMeta !== 'object' ||
      Array.isArray(videoMeta)
    ) {
      return null;
    }

    // Check if all required fields exist
    if (
      typeof videoMeta['duration'] !== 'number' ||
      !videoMeta['resolution'] ||
      typeof videoMeta['bitrate'] !== 'number' ||
      typeof videoMeta['codec'] !== 'string' ||
      typeof videoMeta['fps'] !== 'number'
    ) {
      return null;
    }

    const resolution = videoMeta['resolution'] as Record<string, unknown>;
    if (
      typeof resolution['width'] !== 'number' ||
      typeof resolution['height'] !== 'number'
    ) {
      return null;
    }

    return {
      duration: videoMeta['duration'],
      resolution: {
        width: resolution['width'],
        height: resolution['height'],
      },
      bitrate: videoMeta['bitrate'],
      codec: videoMeta['codec'],
      fps: videoMeta['fps'],
    };
  }

  /**
   * Merge metadata into metadata_json field
   */
  private withMetadata(
    metadata: Record<string, unknown> | null,
    videoMetadata: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      video: videoMetadata,
    };
  }

  /**
   * Cleanup temporary file
   */
  private async cleanupTempFile(filePath: string): Promise<void> {
    try {
      const fs = await import('fs');
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (error) {
      this.logger.warn(`Failed to cleanup temp file ${filePath}: ${error}`);
    }
  }
}
