import { Inject, Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import {
  CompleteUploadSessionPartDto,
  CompleteUploadSessionResponseDto,
} from './dto/complete-upload-session.dto';
import {
  UploadedPartDto,
  UploadPartsResponseDto,
} from './dto/upload-parts-response.dto';
import { UploadSessionResponseDto } from './dto/upload-session-response.dto';
import { Video } from './entities/video.entity';
import { InvalidPartListException } from './exceptions/invalid-part-list.exception';
import { StorageException } from './exceptions/storage.exception';
import { UploadSessionExpiredException } from './exceptions/upload-session-expired.exception';
import { VideoAccessDeniedException } from './exceptions/video-access-denied.exception';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoProcessRequestedPayload } from './queue/video-process-requested.payload';
import { VideoProcessingProducer } from './queue/video-processing.producer';
import {
  DEFAULT_MULTIPART_PART_SIZE_BYTES,
  S3Service,
} from './storage/s3.service';
import { VideoRepository } from './repositories/video.repository';
import { VideoStatus } from './video-status.enum';

interface UploadSessionMetadata {
  filename: string;
  contentType: string;
  sizeBytes: number;
  expectedPartCount: number;
  partSizeBytes: number;
}

@Injectable()
export class VideosService {
  constructor(
    private readonly videoRepository: VideoRepository,
    private readonly s3Service: S3Service,
    private readonly videoProcessingProducer: VideoProcessingProducer,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async createDraft(
    userId: string,
    createUploadSessionDto: CreateUploadSessionDto,
  ): Promise<Video> {
    const publicId = nanoid(12);

    const video = this.videoRepository.create({
      public_id: publicId,
      owner_user_id: userId,
      channel_id: createUploadSessionDto.channelId,
      status: VideoStatus.DRAFT,
      original_bucket: this.storage.bucketOriginals,
      original_object_key: `${publicId}/original.mp4`,
      thumbnail_bucket: this.storage.bucketPublic,
      thumbnail_object_key: `${publicId}/${publicId}_default.jpg`,
      upload_session_id: null,
      draft_created_at: new Date(),
      upload_completed_at: null,
      processing_started_at: null,
      processing_completed_at: null,
      metadata_json: null,
      processing_attempts: 0,
      last_error: null,
      last_error_at: null,
      last_error_stack_trace: null,
    });

    return this.videoRepository.save(video);
  }

  async initiateUploadSession(
    userId: string,
    dto: CreateUploadSessionDto,
  ): Promise<UploadSessionResponseDto> {
    await this.assertChannelOwnership(dto.channelId, userId);

    const draft = await this.createDraft(userId, dto);
    const expectedPartCount = this.calculateExpectedPartCount(dto.sizeBytes);
    const uploadMetadata: UploadSessionMetadata = {
      filename: dto.filename,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      expectedPartCount,
      partSizeBytes: this.s3Service.multipartPartSizeBytes,
    };

    const uploadId = await this.s3Service.createMultipartUpload({
      objectKey: draft.original_object_key,
      contentType: dto.contentType,
      metadata: {
        videoId: draft.id,
        publicId: draft.public_id,
        ownerUserId: draft.owner_user_id,
        filename: dto.filename,
        sizeBytes: String(dto.sizeBytes),
        partSizeBytes: String(this.s3Service.multipartPartSizeBytes),
        expectedPartCount: String(expectedPartCount),
      },
    });

    draft.upload_session_id = uploadId;
    draft.metadata_json = this.withUploadMetadata(
      draft.metadata_json,
      uploadMetadata,
    );
    const updatedDraft = await this.videoRepository.save(draft);

    const partUrls = await Promise.all(
      Array.from({ length: expectedPartCount }, (_, index) =>
        this.s3Service.generatePresignedUploadPartUrl({
          objectKey: updatedDraft.original_object_key,
          uploadId,
          partNumber: index + 1,
        }),
      ),
    );

    return {
      videoId: updatedDraft.id,
      publicId: updatedDraft.public_id,
      uploadId,
      objectKey: updatedDraft.original_object_key,
      partUrls,
      expiresIn: this.s3Service.uploadPartUrlExpiresInSeconds,
    };
  }

  async getUploadParts(
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<UploadPartsResponseDto> {
    const video = await this.getById(videoId);
    this.assertVideoOwnership(video, userId);
    this.assertActiveUploadSession(video, uploadId);

    const uploadMetadata = this.getUploadMetadata(video);
    if (!uploadMetadata) {
      throw new UploadSessionExpiredException();
    }

    try {
      const uploadedParts = await this.s3Service.listParts(
        uploadId,
        video.original_object_key,
      );
      const reconciliation = this.s3Service.reconcileUploadedParts(
        uploadMetadata.expectedPartCount,
        uploadedParts,
      );

      return {
        uploadId,
        uploadedParts: reconciliation.uploadedParts,
        missingParts: reconciliation.missingParts,
      };
    } catch (error) {
      if (this.isExpiredUploadSessionError(error)) {
        throw new UploadSessionExpiredException();
      }

      throw error;
    }
  }

  async completeUploadSession(
    userId: string,
    videoId: string,
    uploadId: string,
    parts: CompleteUploadSessionPartDto[],
  ): Promise<CompleteUploadSessionResponseDto> {
    const video = await this.getById(videoId);
    this.assertVideoOwnership(video, userId);
    this.assertActiveUploadSession(video, uploadId);

    const uploadMetadata = this.getUploadMetadata(video);
    if (!uploadMetadata) {
      throw new UploadSessionExpiredException();
    }

    const listedParts = await this.getUploadParts(userId, videoId, uploadId);
    if (listedParts.missingParts.length > 0) {
      throw new InvalidPartListException();
    }

    const completedParts = this.reconcileCompletionParts(
      parts,
      listedParts.uploadedParts,
    );

    await this.s3Service.completeMultipartUpload({
      objectKey: video.original_object_key,
      uploadId,
      parts: completedParts,
    });

    video.upload_completed_at = new Date();
    video.metadata_json = this.withUploadMetadata(
      video.metadata_json,
      uploadMetadata,
    );
    await this.videoRepository.save(video);

    const jobId = await this.publishProcessingRequested(video);

    return {
      videoId: video.id,
      publicId: video.public_id,
      status: VideoStatus.DRAFT,
      uploadCompletedAt: video.upload_completed_at,
      jobId,
    };
  }

  async abortUploadSession(userId: string, videoId: string): Promise<void> {
    const video = await this.getById(videoId);
    this.assertVideoOwnership(video, userId);

    if (!video.upload_session_id) {
      throw new UploadSessionExpiredException();
    }

    try {
      await this.s3Service.abortMultipartUpload(
        video.upload_session_id,
        video.original_object_key,
      );
    } catch (error) {
      if (this.isExpiredUploadSessionError(error)) {
        throw new UploadSessionExpiredException();
      }

      throw error;
    }

    video.upload_session_id = null;
    video.metadata_json = this.withoutUploadMetadata(video.metadata_json);
    await this.videoRepository.save(video);
  }

  async getByPublicId(publicId: string): Promise<Video> {
    const video =
      await this.videoRepository.findByPublicIdWithRelations(publicId);

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async getById(id: string): Promise<Video> {
    const video = await this.videoRepository.findByIdWithRelations(id);

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async getVideoDetails(
    publicId: string,
    userId: string | null,
  ): Promise<Video> {
    return this.getAccessibleVideo(publicId, userId);
  }

  async listByChannel(channelId: string): Promise<Video[]> {
    return this.videoRepository.findByChannelId(channelId);
  }

  async listByChannelPaginated(
    channelId: string,
    page: number,
    limit: number,
    userId?: string,
  ): Promise<{ items: Video[]; page: number; limit: number; total: number }> {
    const { items, total } =
      await this.videoRepository.findByChannelIdPaginated(
        channelId,
        page,
        limit,
        userId,
      );

    return { items, page, limit, total };
  }

  async getStreamUrl(publicId: string, userId: string | null): Promise<string> {
    const video = await this.getAccessibleVideo(publicId, userId);

    if (video.status !== VideoStatus.READY) {
      throw new VideoAccessDeniedException();
    }

    return this.s3Service.generateStreamUrl(video.original_object_key);
  }

  async getDownloadUrl(
    publicId: string,
    userId: string | null,
  ): Promise<{ url: string; filename: string }> {
    const video = await this.getAccessibleVideo(publicId, userId);

    if (video.status !== VideoStatus.READY) {
      throw new VideoAccessDeniedException();
    }

    const filename = `video-${publicId}.mp4`;
    const url = await this.s3Service.generateDownloadUrl(
      video.original_object_key,
      filename,
    );

    return { url, filename };
  }

  validateOwnership(video: Video, userId: string): boolean {
    return video.owner_user_id === userId;
  }

  validateChannelOwnership(video: Video, channelId: string): boolean {
    return video.channel_id === channelId;
  }

  private async assertChannelOwnership(
    channelId: string,
    userId: string,
  ): Promise<void> {
    const channel = await this.channelRepository.findOne({
      where: { id: channelId, user_id: userId },
    });

    if (!channel) {
      throw new VideoAccessDeniedException();
    }
  }

  private assertVideoOwnership(video: Video, userId: string): void {
    if (!this.validateOwnership(video, userId)) {
      throw new VideoAccessDeniedException();
    }
  }

  private assertActiveUploadSession(video: Video, uploadId: string): void {
    if (!video.upload_session_id || video.upload_session_id !== uploadId) {
      throw new UploadSessionExpiredException();
    }
  }

  private async getAccessibleVideo(
    publicId: string,
    userId: string | null,
  ): Promise<Video> {
    const video = await this.getByPublicId(publicId);

    if (video.status === VideoStatus.READY) {
      return video;
    }

    if (userId && this.validateOwnership(video, userId)) {
      return video;
    }

    throw new VideoAccessDeniedException();
  }

  private calculateExpectedPartCount(sizeBytes: number): number {
    const partSizeBytes =
      this.s3Service.multipartPartSizeBytes ||
      DEFAULT_MULTIPART_PART_SIZE_BYTES;

    return Math.ceil(sizeBytes / partSizeBytes);
  }

  private getUploadMetadata(video: Video): UploadSessionMetadata | null {
    const metadata = video.metadata_json;

    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const upload = metadata['upload'];
    if (!upload || typeof upload !== 'object' || Array.isArray(upload)) {
      return null;
    }

    const candidate = upload as Record<string, unknown>;
    if (
      typeof candidate['filename'] !== 'string' ||
      typeof candidate['contentType'] !== 'string' ||
      typeof candidate['sizeBytes'] !== 'number' ||
      typeof candidate['expectedPartCount'] !== 'number' ||
      typeof candidate['partSizeBytes'] !== 'number'
    ) {
      return null;
    }

    return {
      filename: candidate['filename'],
      contentType: candidate['contentType'],
      sizeBytes: candidate['sizeBytes'],
      expectedPartCount: candidate['expectedPartCount'],
      partSizeBytes: candidate['partSizeBytes'],
    };
  }

  private withUploadMetadata(
    metadata: Record<string, unknown> | null,
    uploadMetadata: UploadSessionMetadata,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      upload: uploadMetadata,
    };
  }

  private withoutUploadMetadata(
    metadata: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const nextMetadata = { ...metadata };
    delete nextMetadata['upload'];

    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
  }

  private reconcileCompletionParts(
    providedParts: CompleteUploadSessionPartDto[],
    uploadedParts: UploadedPartDto[],
  ): CompleteUploadSessionPartDto[] {
    if (providedParts.length !== uploadedParts.length) {
      throw new InvalidPartListException();
    }

    const uploadedPartsByNumber = new Map(
      uploadedParts.map((part) => [part.partNumber, part]),
    );

    const reconciledParts = providedParts.map((part) => {
      const uploadedPart = uploadedPartsByNumber.get(part.partNumber);
      if (!uploadedPart) {
        throw new InvalidPartListException();
      }

      const normalizedProvided = this.s3Service.normalizeEtag(part.eTag);
      const normalizedUploaded = this.s3Service.normalizeEtag(
        uploadedPart.eTag,
      );
      if (normalizedProvided !== normalizedUploaded) {
        throw new InvalidPartListException();
      }

      return {
        partNumber: part.partNumber,
        eTag: uploadedPart.eTag,
      };
    });

    const sortedPartNumbers = [...reconciledParts]
      .sort((left, right) => left.partNumber - right.partNumber)
      .map((part) => part.partNumber);

    const expectedPartNumbers = [...uploadedParts]
      .sort((left, right) => left.partNumber - right.partNumber)
      .map((part) => part.partNumber);

    if (sortedPartNumbers.join(',') !== expectedPartNumbers.join(',')) {
      throw new InvalidPartListException();
    }

    return reconciledParts;
  }

  private isExpiredUploadSessionError(error: unknown): boolean {
    if (!(error instanceof StorageException)) {
      return false;
    }

    const cause = error.cause as { name?: string; Code?: string } | undefined;
    const code = cause?.name ?? cause?.Code;

    return (
      code === 'NoSuchUpload' || code === 'NoSuchKey' || code === 'NotFound'
    );
  }

  private async publishProcessingRequested(video: Video): Promise<string> {
    const payload: VideoProcessRequestedPayload = {
      eventId: `evt-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      videoId: video.id,
      publicId: video.public_id,
      ownerUserId: video.owner_user_id,
      sourceBucket: video.original_bucket,
      sourceObjectKey: video.original_object_key,
      storageProvider: 's3',
      uploadSessionId: video.upload_session_id ?? '',
      attempt: 1,
    };

    return this.videoProcessingProducer.enqueueProcessRequested(payload);
  }
}
