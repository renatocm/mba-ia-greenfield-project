import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';

@Entity('videos')
@Index(['public_id'], { unique: true })
@Index(['channel_id'])
@Index(['owner_user_id'])
@Index(['status'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 12 })
  public_id: string;

  @Column({ type: 'uuid' })
  owner_user_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'videos_status_enum',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar' })
  original_bucket: string;

  @Column({ type: 'varchar' })
  original_object_key: string;

  @Column({ type: 'varchar' })
  thumbnail_bucket: string;

  @Column({ type: 'varchar' })
  thumbnail_object_key: string;

  @Column({ type: 'varchar', nullable: true })
  upload_session_id: string | null;

  @Column({ type: 'timestamp' })
  draft_created_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  upload_completed_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  processing_started_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  processing_completed_at: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata_json: Record<string, unknown> | null;

  @Column({ type: 'int', default: 0 })
  processing_attempts: number;

  @Column({ type: 'text', nullable: true })
  last_error: string | null;

  @Column({ type: 'timestamp', nullable: true })
  last_error_at: Date | null;

  @Column({ type: 'text', nullable: true })
  last_error_stack_trace: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  @ManyToOne(() => User, (user) => user.ownedVideos, { nullable: false })
  @JoinColumn({ name: 'owner_user_id' })
  owner: User;

  @ManyToOne(() => Channel, (channel) => channel.videos, { nullable: false })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
