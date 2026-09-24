import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { CompleteUploadSessionPartDto } from './dto/complete-upload-session.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { Video } from './entities/video.entity';
import { InvalidPartListException } from './exceptions/invalid-part-list.exception';
import { UploadSessionExpiredException } from './exceptions/upload-session-expired.exception';
import { VideoAccessDeniedException } from './exceptions/video-access-denied.exception';
import { VideoProcessRequestedPayload } from './queue/video-process-requested.payload';
import { VideoProcessingProducer } from './queue/video-processing.producer';
import { VideoRepository } from './repositories/video.repository';
import { S3Service } from './storage/s3.service';
import { VideosService } from './videos.service';
import { VideoStatus } from './video-status.enum';

describe('VideosService', () => {
  let service: VideosService;

  const videoRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findByPublicIdWithRelations: jest.fn(),
    findByIdWithRelations: jest.fn(),
    findByChannelId: jest.fn(),
    findByChannelIdPaginated: jest.fn(),
  } satisfies Partial<Record<keyof VideoRepository, jest.Mock>>;

  const s3Service = {
    originalsBucket: 'videos-originals',
    publicBucket: 'videos-public',
    multipartPartSizeBytes: 10,
    uploadPartUrlExpiresInSeconds: 3600,
    streamUrlExpiresInSeconds: 1800,
    downloadUrlExpiresInSeconds: 86400,
    createMultipartUpload: jest.fn(),
    generatePresignedUploadPartUrl: jest.fn(),
    listParts: jest.fn(),
    reconcileUploadedParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    generateStreamUrl: jest.fn(),
    generateDownloadUrl: jest.fn(),
    normalizeEtag: jest.fn((eTag: string) => `"${eTag.replace(/^"|"$/g, '')}"`),
  } satisfies Partial<Record<keyof S3Service, unknown>>;

  const channelRepository = {
    findOne: jest.fn(),
  };

  const videoProcessingProducer = {
    enqueueProcessRequested: jest.fn(),
  };

  const storage = {
    bucketOriginals: 'videos-originals',
    bucketPublic: 'videos-public',
  } as ConfigType<typeof storageConfig>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: VideoRepository,
          useValue: videoRepository,
        },
        {
          provide: S3Service,
          useValue: s3Service,
        },
        {
          provide: VideoProcessingProducer,
          useValue: videoProcessingProducer,
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: channelRepository,
        },
        {
          provide: storageConfig.KEY,
          useValue: storage,
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    it('should create a draft video with generated public id and default storage fields', async () => {
      const dto: CreateUploadSessionDto = {
        channelId: '73dfe527-31c3-40d2-a423-75546e36a050',
        filename: 'sample.mp4',
        contentType: 'video/mp4',
        sizeBytes: 4096,
      };

      let createPayload: Video | undefined;
      videoRepository.create.mockImplementation((payload: Partial<Video>) => {
        createPayload = payload as Video;
        return payload as Video;
      });
      videoRepository.save.mockImplementation((video: Video) =>
        Promise.resolve({
          ...video,
          id: 'c7ae9d11-2a2b-46fb-981f-09a845362542',
        }),
      );

      const result = await service.createDraft(
        '8c1eec7c-928f-4cb6-a0af-4f4b399731ae',
        dto,
      );

      expect(videoRepository.create).toHaveBeenCalledTimes(1);
      expect(createPayload).toBeDefined();
      const payload = createPayload as Video;
      expect(payload.public_id).toHaveLength(12);
      expect(payload.owner_user_id).toBe(
        '8c1eec7c-928f-4cb6-a0af-4f4b399731ae',
      );
      expect(payload.channel_id).toBe(dto.channelId);
      expect(payload.status).toBe(VideoStatus.DRAFT);
      expect(payload.original_bucket).toBe('videos-originals');
      expect(payload.original_object_key).toBe(
        `${payload.public_id}/original.mp4`,
      );
      expect(payload.thumbnail_bucket).toBe('videos-public');
      expect(payload.thumbnail_object_key).toBe(
        `${payload.public_id}/${payload.public_id}_default.jpg`,
      );
      expect(payload.upload_session_id).toBeNull();
      expect(payload.processing_attempts).toBe(0);
      expect(payload.metadata_json).toBeNull();
      expect(payload.last_error).toBeNull();
      expect(payload.draft_created_at).toBeInstanceOf(Date);
      expect(result.id).toBeDefined();
      expect(videoRepository.save).toHaveBeenCalledWith(payload);
    });
  });

  describe('initiateUploadSession', () => {
    it('creates draft, starts multipart upload, persists upload metadata, and signs all parts', async () => {
      const dto: CreateUploadSessionDto = {
        channelId: 'channel-id',
        filename: 'sample.mp4',
        contentType: 'video/mp4',
        sizeBytes: 21,
      };
      channelRepository.findOne.mockResolvedValue({ id: dto.channelId });
      let currentSaveCount = 0;
      videoRepository.create.mockImplementation(
        (payload: Partial<Video>) => payload as Video,
      );
      videoRepository.save.mockImplementation((video: Video) => {
        currentSaveCount += 1;
        return Promise.resolve({
          ...video,
          id: 'video-id',
          metadata_json:
            currentSaveCount > 1
              ? {
                  upload: {
                    filename: dto.filename,
                    contentType: dto.contentType,
                    sizeBytes: dto.sizeBytes,
                    expectedPartCount: 3,
                    partSizeBytes: 10,
                  },
                }
              : video.metadata_json,
        });
      });
      s3Service.createMultipartUpload.mockImplementation(
        (args: {
          objectKey: string;
          contentType: string;
          metadata?: Record<string, string>;
        }) => {
          expect(args.objectKey).toMatch(/\/original\.mp4$/);
          expect(args.contentType).toBe(dto.contentType);
          expect(args.metadata).toEqual(
            expect.objectContaining({
              filename: dto.filename,
              sizeBytes: String(dto.sizeBytes),
              expectedPartCount: '3',
            }),
          );

          return Promise.resolve('upload-id');
        },
      );
      s3Service.generatePresignedUploadPartUrl
        .mockResolvedValueOnce({
          partNumber: 1,
          url: 'http://signed/1',
          expiresIn: 3600,
        })
        .mockResolvedValueOnce({
          partNumber: 2,
          url: 'http://signed/2',
          expiresIn: 3600,
        })
        .mockResolvedValueOnce({
          partNumber: 3,
          url: 'http://signed/3',
          expiresIn: 3600,
        });

      const result = await service.initiateUploadSession('user-id', dto);

      expect(channelRepository.findOne).toHaveBeenCalledWith({
        where: { id: dto.channelId, user_id: 'user-id' },
      });
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      expect(result.uploadId).toBe('upload-id');
      expect(result.partUrls).toHaveLength(3);
      expect(result.expiresIn).toBe(3600);
    });
  });

  describe('getUploadParts', () => {
    it('returns uploaded and missing parts for an active upload session', async () => {
      videoRepository.findByIdWithRelations.mockResolvedValue({
        id: 'video-id',
        owner_user_id: 'owner-id',
        upload_session_id: 'upload-id',
        original_object_key: 'public-id/original.mp4',
        metadata_json: {
          upload: {
            filename: 'video.mp4',
            contentType: 'video/mp4',
            sizeBytes: 25,
            expectedPartCount: 3,
            partSizeBytes: 10,
          },
        },
      } as unknown as Video);
      s3Service.listParts.mockResolvedValue([
        {
          partNumber: 1,
          eTag: '"etag-1"',
          lastModified: '2026-09-23T20:00:00.000Z',
        },
      ]);
      s3Service.reconcileUploadedParts.mockReturnValue({
        uploadId: '',
        uploadedParts: [
          {
            partNumber: 1,
            eTag: '"etag-1"',
            lastModified: '2026-09-23T20:00:00.000Z',
          },
        ],
        missingParts: [2, 3],
      });

      await expect(
        service.getUploadParts('owner-id', 'video-id', 'upload-id'),
      ).resolves.toEqual({
        uploadId: 'upload-id',
        uploadedParts: [
          {
            partNumber: 1,
            eTag: '"etag-1"',
            lastModified: '2026-09-23T20:00:00.000Z',
          },
        ],
        missingParts: [2, 3],
      });
    });

    it('throws UploadSessionExpiredException when upload session is not active', async () => {
      videoRepository.findByIdWithRelations.mockResolvedValue({
        id: 'video-id',
        owner_user_id: 'owner-id',
        upload_session_id: null,
      } as unknown as Video);

      await expect(
        service.getUploadParts('owner-id', 'video-id', 'upload-id'),
      ).rejects.toThrow(UploadSessionExpiredException);
    });
  });

  describe('completeUploadSession', () => {
    it('completes multipart upload with corrected etags and returns canonical job id', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        owner_user_id: 'owner-id',
        original_bucket: 'videos-originals',
        original_object_key: 'public-id/original.mp4',
        upload_session_id: 'upload-id',
        upload_completed_at: null,
        metadata_json: {
          upload: {
            filename: 'sample.mp4',
            contentType: 'video/mp4',
            sizeBytes: 10,
            expectedPartCount: 1,
            partSizeBytes: 10,
          },
        },
      } as unknown as Video;
      videoRepository.findByIdWithRelations.mockResolvedValue(video);
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
        'video-video-id',
      );
      videoRepository.save.mockImplementation((entity: Video) =>
        Promise.resolve(entity),
      );

      const result = await service.completeUploadSession(
        'owner-id',
        'video-id',
        'upload-id',
        [{ partNumber: 1, eTag: 'etag-1' }],
      );

      expect(s3Service.completeMultipartUpload).toHaveBeenCalledWith({
        objectKey: 'public-id/original.mp4',
        uploadId: 'upload-id',
        parts: [{ partNumber: 1, eTag: '"etag-1"' }],
      });
      expect(result.jobId).toBe('video-video-id');
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.uploadCompletedAt).toBeInstanceOf(Date);
      const [publishedPayload] = videoProcessingProducer.enqueueProcessRequested
        .mock.calls[0] as [VideoProcessRequestedPayload];

      expect(publishedPayload).toEqual(
        expect.objectContaining({
          videoId: 'video-id',
          publicId: 'public-id',
        }),
      );
    });

    it('throws InvalidPartListException when uploaded parts are missing', async () => {
      videoRepository.findByIdWithRelations.mockResolvedValue({
        id: 'video-id',
        owner_user_id: 'owner-id',
        upload_session_id: 'upload-id',
        original_object_key: 'public-id/original.mp4',
        metadata_json: {
          upload: {
            filename: 'sample.mp4',
            contentType: 'video/mp4',
            sizeBytes: 10,
            expectedPartCount: 1,
            partSizeBytes: 10,
          },
        },
      } as unknown as Video);
      s3Service.listParts.mockResolvedValue([]);
      s3Service.reconcileUploadedParts.mockReturnValue({
        uploadId: '',
        uploadedParts: [],
        missingParts: [1],
      });

      const parts: CompleteUploadSessionPartDto[] = [
        { partNumber: 1, eTag: 'etag-1' },
      ];

      await expect(
        service.completeUploadSession(
          'owner-id',
          'video-id',
          'upload-id',
          parts,
        ),
      ).rejects.toThrow(InvalidPartListException);
    });
  });

  describe('abortUploadSession', () => {
    it('aborts multipart upload and clears the active session from the draft', async () => {
      const video = {
        id: 'video-id',
        owner_user_id: 'owner-id',
        upload_session_id: 'upload-id',
        original_object_key: 'public-id/original.mp4',
        metadata_json: {
          upload: { filename: 'sample.mp4' },
          media: { duration: 1 },
        },
      } as unknown as Video;
      videoRepository.findByIdWithRelations.mockResolvedValue(video);
      videoRepository.save.mockImplementation((entity: Video) =>
        Promise.resolve(entity),
      );

      await service.abortUploadSession('owner-id', 'video-id');

      expect(s3Service.abortMultipartUpload).toHaveBeenCalledWith(
        'upload-id',
        'public-id/original.mp4',
      );
      expect(video.upload_session_id).toBeNull();
      expect(video.metadata_json).toEqual({ media: { duration: 1 } });
    });
  });

  describe('getByPublicId', () => {
    it('should return video when found', async () => {
      const video = {
        id: 'video-id',
        public_id: 'publicvideo1',
        status: VideoStatus.READY,
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);

      await expect(service.getByPublicId('publicvideo1')).resolves.toBe(video);
    });
  });

  describe('validateOwnership', () => {
    it('should return true when user id matches owner', () => {
      expect(
        service.validateOwnership(
          { owner_user_id: 'owner-id' } as Video,
          'owner-id',
        ),
      ).toBe(true);
    });

    it('should return false when user id does not match owner', () => {
      expect(
        service.validateOwnership(
          { owner_user_id: 'owner-id' } as Video,
          'other-id',
        ),
      ).toBe(false);
    });
  });

  describe('validateChannelOwnership', () => {
    it('should return true when channel id matches video channel', () => {
      expect(
        service.validateChannelOwnership(
          { channel_id: 'channel-id' } as Video,
          'channel-id',
        ),
      ).toBe(true);
    });

    it('should return false when channel id does not match video channel', () => {
      expect(
        service.validateChannelOwnership(
          { channel_id: 'channel-id' } as Video,
          'other-channel-id',
        ),
      ).toBe(false);
    });
  });

  describe('ownership guards', () => {
    it('throws VideoAccessDeniedException when the channel is not owned by the user', async () => {
      channelRepository.findOne.mockResolvedValue(null);

      await expect(
        service.initiateUploadSession('user-id', {
          channelId: 'channel-id',
          filename: 'sample.mp4',
          contentType: 'video/mp4',
          sizeBytes: 10,
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });
  });

  describe('getStreamUrl', () => {
    it('generates stream url for ready video when unauthenticated', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.READY,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);
      s3Service.generateStreamUrl.mockResolvedValue('http://signed-stream-url');

      const result = await service.getStreamUrl('public-id', null);

      expect(result).toBe('http://signed-stream-url');
      expect(s3Service.generateStreamUrl).toHaveBeenCalledWith(
        'public-id/original.mp4',
      );
    });

    it('generates stream url for ready video when authenticated as owner', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.READY,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);
      s3Service.generateStreamUrl.mockResolvedValue('http://signed-stream-url');

      const result = await service.getStreamUrl('public-id', 'owner-id');

      expect(result).toBe('http://signed-stream-url');
      expect(s3Service.generateStreamUrl).toHaveBeenCalledWith(
        'public-id/original.mp4',
      );
    });

    it('throws VideoAccessDeniedException when trying to stream draft video (even as owner)', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.DRAFT,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);

      await expect(
        service.getStreamUrl('public-id', 'owner-id'),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws VideoAccessDeniedException when trying to stream non-ready video as non-owner', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.DRAFT,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'other-owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);

      await expect(
        service.getStreamUrl('public-id', 'different-user-id'),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws VideoAccessDeniedException when trying to stream non-ready video without authentication', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.PROCESSING,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);

      await expect(service.getStreamUrl('public-id', null)).rejects.toThrow(
        VideoAccessDeniedException,
      );
    });

    it('throws VideoNotFoundException when video does not exist', async () => {
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(null);

      await expect(service.getStreamUrl('nonexistent', null)).rejects.toThrow();
    });
  });

  describe('getDownloadUrl', () => {
    it('generates download url for ready video when unauthenticated', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.READY,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);
      s3Service.generateDownloadUrl.mockResolvedValue(
        'http://signed-download-url',
      );

      const result = await service.getDownloadUrl('public-id', null);

      expect(result.url).toBe('http://signed-download-url');
      expect(result.filename).toBe('video-public-id.mp4');
      expect(s3Service.generateDownloadUrl).toHaveBeenCalledWith(
        'public-id/original.mp4',
        'video-public-id.mp4',
      );
    });

    it('generates download url for ready video when authenticated as owner', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.READY,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);
      s3Service.generateDownloadUrl.mockResolvedValue(
        'http://signed-download-url',
      );

      const result = await service.getDownloadUrl('public-id', 'owner-id');

      expect(result.url).toBe('http://signed-download-url');
      expect(result.filename).toBe('video-public-id.mp4');
      expect(s3Service.generateDownloadUrl).toHaveBeenCalledWith(
        'public-id/original.mp4',
        'video-public-id.mp4',
      );
    });

    it('throws VideoAccessDeniedException when trying to download error video (even as owner)', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.ERROR,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);

      await expect(
        service.getDownloadUrl('public-id', 'owner-id'),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws VideoAccessDeniedException when trying to download non-ready video as non-owner', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.ERROR,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'other-owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);

      await expect(
        service.getDownloadUrl('public-id', 'different-user-id'),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws VideoAccessDeniedException when trying to download processing video without authentication', async () => {
      const video = {
        id: 'video-id',
        public_id: 'public-id',
        status: VideoStatus.PROCESSING,
        original_object_key: 'public-id/original.mp4',
        owner_user_id: 'owner-id',
      } as unknown as Video;
      videoRepository.findByPublicIdWithRelations.mockResolvedValue(video);

      await expect(service.getDownloadUrl('public-id', null)).rejects.toThrow(
        VideoAccessDeniedException,
      );
    });
  });

  describe('listByChannelPaginated', () => {
    it('returns paginated ready videos for anonymous users', async () => {
      const videos = [
        {
          id: 'video-1',
          public_id: 'pub-1',
          status: VideoStatus.READY,
          owner_user_id: 'owner-1',
        },
        {
          id: 'video-2',
          public_id: 'pub-2',
          status: VideoStatus.READY,
          owner_user_id: 'owner-1',
        },
      ] as unknown as Video[];

      videoRepository.findByChannelIdPaginated = jest.fn().mockResolvedValue({
        items: videos,
        total: 2,
      });

      const result = await service.listByChannelPaginated(
        'channel-id',
        1,
        10,
        undefined,
      );

      expect(result.items).toEqual(videos);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(2);
      expect(videoRepository.findByChannelIdPaginated).toHaveBeenCalledWith(
        'channel-id',
        1,
        10,
        undefined,
      );
    });

    it('returns all video statuses (including drafts) for channel owner', async () => {
      const videos = [
        {
          id: 'video-1',
          public_id: 'pub-1',
          status: VideoStatus.READY,
          owner_user_id: 'owner-1',
        },
        {
          id: 'video-2',
          public_id: 'pub-2',
          status: VideoStatus.DRAFT,
          owner_user_id: 'owner-1',
        },
        {
          id: 'video-3',
          public_id: 'pub-3',
          status: VideoStatus.PROCESSING,
          owner_user_id: 'owner-1',
        },
      ] as unknown as Video[];

      videoRepository.findByChannelIdPaginated = jest.fn().mockResolvedValue({
        items: videos,
        total: 3,
      });

      const result = await service.listByChannelPaginated(
        'channel-id',
        1,
        10,
        'owner-1',
      );

      expect(result.items).toEqual(videos);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(3);
      expect(videoRepository.findByChannelIdPaginated).toHaveBeenCalledWith(
        'channel-id',
        1,
        10,
        'owner-1',
      );
    });

    it('respects pagination parameters', async () => {
      videoRepository.findByChannelIdPaginated = jest.fn().mockResolvedValue({
        items: [],
        total: 0,
      });

      await service.listByChannelPaginated('channel-id', 5, 20, undefined);

      expect(videoRepository.findByChannelIdPaginated).toHaveBeenCalledWith(
        'channel-id',
        5,
        20,
        undefined,
      );
    });
  });
});
