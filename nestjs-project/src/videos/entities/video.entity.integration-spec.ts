import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let userCounter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannelOwner() {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );

    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Video Channel ${userCounter}`,
        nickname: `video-channel-${userCounter}`,
        user_id: user.id,
      }),
    );

    return { user, channel };
  }

  async function createVideo(overrides: Partial<Video> = {}): Promise<Video> {
    const { user, channel } = await createChannelOwner();
    const publicId =
      overrides.public_id ?? `video${String(userCounter).padStart(7, '0')}`;

    return videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        owner_user_id: user.id,
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        original_bucket: 'videos-originals',
        original_object_key: `videos-originals/${publicId}/original.mp4`,
        thumbnail_bucket: 'videos-public',
        thumbnail_object_key: `videos-public/${publicId}/${publicId}_default.jpg`,
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

  it('should default status to draft and processing_attempts to zero', async () => {
    const { user, channel } = await createChannelOwner();
    const publicId = 'draftvideo01';

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        owner_user_id: user.id,
        channel_id: channel.id,
        original_bucket: 'videos-originals',
        original_object_key: `videos-originals/${publicId}/original.mp4`,
        thumbnail_bucket: 'videos-public',
        thumbnail_object_key: `videos-public/${publicId}/${publicId}_default.jpg`,
        upload_session_id: null,
        draft_created_at: new Date(),
        upload_completed_at: null,
        processing_started_at: null,
        processing_completed_at: null,
        metadata_json: null,
        last_error: null,
        last_error_at: null,
        last_error_stack_trace: null,
      }),
    );

    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.processing_attempts).toBe(0);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id', async () => {
    await createVideo({ public_id: 'publicid0012' });

    await expect(createVideo({ public_id: 'publicid0012' })).rejects.toThrow();
  });

  it('should enforce owner_user_id and channel_id foreign keys', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'fkcheck00001',
          owner_user_id: '7bb5fe1d-35d2-4b89-9b6f-bf1a23c77a5d',
          channel_id: 'e446d54b-e0db-46ef-906a-cd44dc27b6fb',
          status: VideoStatus.DRAFT,
          original_bucket: 'videos-originals',
          original_object_key: 'videos-originals/fkcheck00001/original.mp4',
          thumbnail_bucket: 'videos-public',
          thumbnail_object_key:
            'videos-public/fkcheck00001/fkcheck00001_default.jpg',
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
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load bidirectional relations for channel and owner', async () => {
    const saved = await createVideo({
      public_id: 'relation0001',
      metadata_json: { durationSeconds: 123 },
    });

    const foundVideo = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel', 'owner'],
    });
    const foundChannel = await channelRepository.findOne({
      where: { id: saved.channel_id },
      relations: ['videos'],
    });
    const foundOwner = await userRepository.findOne({
      where: { id: saved.owner_user_id },
      relations: ['ownedVideos'],
    });

    expect(foundVideo?.channel.id).toBe(saved.channel_id);
    expect(foundVideo?.owner.id).toBe(saved.owner_user_id);
    expect(foundChannel?.videos?.map((video) => video.id)).toContain(saved.id);
    expect(foundOwner?.ownedVideos?.map((video) => video.id)).toContain(
      saved.id,
    );
  });
});
