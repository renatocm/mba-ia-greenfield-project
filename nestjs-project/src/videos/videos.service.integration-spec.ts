import { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { Video } from './entities/video.entity';
import { UploadSessionExpiredException } from './exceptions/upload-session-expired.exception';
import { VideoProcessRequestedPayload } from './queue/video-process-requested.payload';
import { VideoProcessingProducer } from './queue/video-processing.producer';
import { VideoRepository } from './repositories/video.repository';
import { S3Service } from './storage/s3.service';
import { VideosService } from './videos.service';
import { VideoStatus } from './video-status.enum';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: VideoRepository;
  let videosService: VideosService;
  let userCounter = 0;

  const s3Service = {
    multipartPartSizeBytes: 10,
    uploadPartUrlExpiresInSeconds: 3600,
    createMultipartUpload: jest.fn(),
    generatePresignedUploadPartUrl: jest.fn(),
    listParts: jest.fn(),
    reconcileUploadedParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    generatePresignedGetUrl: jest.fn(),
    generatePresignedDownloadUrl: jest.fn(),
    normalizeEtag: jest.fn((eTag: string) => `"${eTag.replace(/^"|"$/g, '')}"`),
  } as unknown as jest.Mocked<S3Service>;

  const storage = {
    bucketOriginals: 'videos-originals',
    bucketPublic: 'videos-public',
  } as ConfigType<typeof storageConfig>;

  const videoProcessingProducer = {
    enqueueProcessRequested: jest.fn(),
  } as unknown as jest.Mocked<VideoProcessingProducer>;

  const dataSource = createTestDataSource(ALL_ENTITIES);

  beforeAll(async () => {
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = new VideoRepository(dataSource);
    videosService = new VideosService(
      videoRepository,
      s3Service,
      videoProcessingProducer,
      channelRepository,
      storage,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanAllTables(dataSource);
  });

  async function createOwnerWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const sequence = ++userCounter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_service_${sequence}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Video Service ${sequence}`,
        nickname: `video-service-${sequence}`,
        user_id: user.id,
      }),
    );

    return { user, channel };
  }

  async function createPersistedVideo(
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const { user, channel } = await createOwnerWithChannel();
    const publicId =
      overrides.public_id ?? `vid${String(userCounter).padStart(9, '0')}`;

    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        owner_user_id: user.id,
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        original_bucket: 'videos-originals',
        original_object_key: `${publicId}/original.mp4`,
        thumbnail_bucket: 'videos-public',
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
        ...overrides,
      }),
    );
  }

  describe('createDraft', () => {
    it('persists a draft video with default buckets and storage keys', async () => {
      const { user, channel } = await createOwnerWithChannel();
      const dto: CreateUploadSessionDto = {
        channelId: channel.id,
        filename: 'uploaded.mov',
        contentType: 'video/quicktime',
        sizeBytes: 2048,
      };

      const draft = await videosService.createDraft(user.id, dto);

      expect(draft.id).toBeDefined();
      expect(draft.public_id).toHaveLength(12);
      expect(draft.status).toBe(VideoStatus.DRAFT);
      expect(draft.owner_user_id).toBe(user.id);
      expect(draft.channel_id).toBe(channel.id);
      expect(draft.original_bucket).toBe('videos-originals');
      expect(draft.original_object_key).toBe(`${draft.public_id}/original.mp4`);
      expect(draft.thumbnail_bucket).toBe('videos-public');
      expect(draft.thumbnail_object_key).toBe(
        `${draft.public_id}/${draft.public_id}_default.jpg`,
      );
      expect(draft.processing_attempts).toBe(0);
      expect(draft.upload_session_id).toBeNull();
      expect(draft.metadata_json).toBeNull();
      expect(draft.last_error).toBeNull();

      const persisted = await videoRepository.findByIdWithRelations(draft.id);
      expect(persisted).not.toBeNull();
      expect(persisted?.channel.id).toBe(channel.id);
      expect(persisted?.owner.id).toBe(user.id);
    });
  });

  describe('initiateUploadSession', () => {
    it('persists upload_session_id and upload metadata after starting multipart upload', async () => {
      const { user, channel } = await createOwnerWithChannel();
      s3Service.createMultipartUpload.mockResolvedValue('upload-id');
      s3Service.generatePresignedUploadPartUrl
        .mockResolvedValueOnce({
          partNumber: 1,
          url: 'http://part-1',
          expiresIn: 3600,
        })
        .mockResolvedValueOnce({
          partNumber: 2,
          url: 'http://part-2',
          expiresIn: 3600,
        });

      const response = await videosService.initiateUploadSession(user.id, {
        channelId: channel.id,
        filename: 'sample.mp4',
        contentType: 'video/mp4',
        sizeBytes: 11,
      });

      const persisted = await videoRepository.findByIdWithRelations(
        response.videoId,
      );
      expect(response.partUrls).toHaveLength(2);
      expect(persisted?.upload_session_id).toBe('upload-id');
      expect(persisted?.metadata_json).toEqual({
        upload: {
          filename: 'sample.mp4',
          contentType: 'video/mp4',
          sizeBytes: 11,
          expectedPartCount: 2,
          partSizeBytes: 10,
        },
      });
    });
  });

  describe('completeUploadSession', () => {
    it('persists upload_completed_at after multipart completion', async () => {
      const video = await createPersistedVideo({
        upload_session_id: 'upload-id',
        metadata_json: {
          upload: {
            filename: 'video.mp4',
            contentType: 'video/mp4',
            sizeBytes: 10,
            expectedPartCount: 1,
            partSizeBytes: 10,
          },
        },
      });
      s3Service.listParts.mockResolvedValue([
        { partNumber: 1, eTag: '"etag-1"', lastModified: null },
      ]);
      s3Service.reconcileUploadedParts.mockReturnValue({
        uploadId: '',
        uploadedParts: [
          { partNumber: 1, eTag: '"etag-1"', lastModified: null },
        ],
        missingParts: [],
      });
      videoProcessingProducer.enqueueProcessRequested.mockResolvedValue(
        `video-${video.id}`,
      );

      const response = await videosService.completeUploadSession(
        video.owner_user_id,
        video.id,
        'upload-id',
        [{ partNumber: 1, eTag: 'etag-1' }],
      );

      const persisted = await videoRepository.findByIdWithRelations(video.id);
      expect(s3Service.completeMultipartUpload.mock.calls.length).toBe(1);
      expect(response.jobId).toBe(`video-${video.id}`);
      expect(persisted?.upload_completed_at).toBeInstanceOf(Date);
      const [publishedPayload] = videoProcessingProducer.enqueueProcessRequested
        .mock.calls[0] as [VideoProcessRequestedPayload];

      expect(publishedPayload).toEqual(
        expect.objectContaining({
          videoId: video.id,
          publicId: video.public_id,
        }),
      );
    });
  });

  describe('abortUploadSession', () => {
    it('clears upload_session_id and removes upload metadata after aborting', async () => {
      const video = await createPersistedVideo({
        upload_session_id: 'upload-id',
        metadata_json: {
          upload: {
            filename: 'video.mp4',
            contentType: 'video/mp4',
            sizeBytes: 10,
            expectedPartCount: 1,
            partSizeBytes: 10,
          },
          media: { durationSeconds: 180 },
        },
      });

      await videosService.abortUploadSession(video.owner_user_id, video.id);

      const persisted = await videoRepository.findByIdWithRelations(video.id);
      expect(s3Service.abortMultipartUpload.mock.calls[0]).toEqual([
        'upload-id',
        `${video.public_id}/original.mp4`,
      ]);
      expect(persisted?.upload_session_id).toBeNull();
      expect(persisted?.metadata_json).toEqual({
        media: { durationSeconds: 180 },
      });
    });

    it('throws UploadSessionExpiredException when there is no active upload session', async () => {
      const video = await createPersistedVideo();

      await expect(
        videosService.abortUploadSession(video.owner_user_id, video.id),
      ).rejects.toThrow(UploadSessionExpiredException);
    });
  });

  describe('getByPublicId', () => {
    it('loads video by public id with owner and channel relations', async () => {
      const saved = await createPersistedVideo({
        public_id: 'publicid0012',
        metadata_json: { media: { durationSeconds: 180 } },
      });

      const found = await videosService.getByPublicId(saved.public_id);

      expect(found.id).toBe(saved.id);
      expect(found.channel.id).toBe(saved.channel_id);
      expect(found.owner.id).toBe(saved.owner_user_id);
      expect(found.metadata_json).toEqual({ media: { durationSeconds: 180 } });
    });
  });

  describe('listByChannel', () => {
    it('returns channel videos ordered by most recent first', async () => {
      const { user, channel } = await createOwnerWithChannel();
      const older = await videoRepository.save(
        videoRepository.create({
          public_id: 'oldervideo01',
          owner_user_id: user.id,
          channel_id: channel.id,
          status: VideoStatus.DRAFT,
          original_bucket: 'videos-originals',
          original_object_key: 'oldervideo01/original.mp4',
          thumbnail_bucket: 'videos-public',
          thumbnail_object_key: 'oldervideo01/oldervideo01_default.jpg',
          upload_session_id: null,
          draft_created_at: new Date('2026-01-01T10:00:00Z'),
          upload_completed_at: null,
          processing_started_at: null,
          processing_completed_at: null,
          metadata_json: null,
          processing_attempts: 0,
          last_error: null,
          last_error_at: null,
          last_error_stack_trace: null,
        }),
      );

      await videoRepository.save(
        videoRepository.create({
          public_id: 'newervideo01',
          owner_user_id: user.id,
          channel_id: channel.id,
          status: VideoStatus.READY,
          original_bucket: 'videos-originals',
          original_object_key: 'newervideo01/original.mp4',
          thumbnail_bucket: 'videos-public',
          thumbnail_object_key: 'newervideo01/newervideo01_default.jpg',
          upload_session_id: null,
          draft_created_at: new Date('2026-01-01T11:00:00Z'),
          upload_completed_at: null,
          processing_started_at: null,
          processing_completed_at: null,
          metadata_json: null,
          processing_attempts: 0,
          last_error: null,
          last_error_at: null,
          last_error_stack_trace: null,
        }),
      );

      const listed = await videosService.listByChannel(channel.id);

      expect(listed.map((video) => video.public_id)).toEqual([
        'newervideo01',
        'oldervideo01',
      ]);
      expect(listed.find((video) => video.id === older.id)).toBeDefined();
    });
  });
});
