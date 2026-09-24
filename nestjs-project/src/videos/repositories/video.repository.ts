import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';

@Injectable()
export class VideoRepository extends Repository<Video> {
  constructor(dataSource: DataSource) {
    super(Video, dataSource.createEntityManager());
  }

  async findByPublicId(publicId: string): Promise<Video | null> {
    return this.findOne({
      where: { public_id: publicId },
    });
  }

  async findByIdOrNull(id: string): Promise<Video | null> {
    return this.findOne({
      where: { id },
    });
  }

  async findByIdWithRelations(id: string): Promise<Video | null> {
    return this.findOne({
      where: { id },
      relations: {
        channel: true,
        owner: true,
      },
    });
  }

  async findByPublicIdWithRelations(publicId: string): Promise<Video | null> {
    return this.findOne({
      where: { public_id: publicId },
      relations: {
        channel: true,
        owner: true,
      },
    });
  }

  async findByChannelId(channelId: string): Promise<Video[]> {
    return this.find({
      where: { channel_id: channelId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * List videos for a channel with pagination and authorization filtering
   * - If userId matches channel owner, return all videos (including drafts)
   * - Otherwise, return only READY videos
   */
  async findByChannelIdPaginated(
    channelId: string,
    page: number,
    limit: number,
    ownerUserId?: string,
  ): Promise<{ items: Video[]; total: number }> {
    const query = this.createQueryBuilder('video')
      .where('video.channel_id = :channelId', { channelId })
      .orderBy('video.created_at', 'DESC');

    // If user is provided, check if they own the channel
    if (ownerUserId) {
      const isChannelOwner = await this.createQueryBuilder('video')
        .leftJoin('channels', 'channel', 'channel.id = video.channel_id')
        .select('COUNT(*)', 'count')
        .where('channel.id = :channelId', { channelId })
        .andWhere('channel.user_id = :ownerUserId', { ownerUserId })
        .getRawOne<{ count: string }>();

      // If user is not the channel owner, filter to only READY videos
      if (!isChannelOwner || parseInt(isChannelOwner.count, 10) === 0) {
        query.andWhere('video.status = :readyStatus', {
          readyStatus: VideoStatus.READY,
        });
      }
    } else {
      // If no user provided, filter to only READY videos
      query.andWhere('video.status = :readyStatus', {
        readyStatus: VideoStatus.READY,
      });
    }

    const total = await query.getCount();
    const items = await query
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { items, total };
  }
}
