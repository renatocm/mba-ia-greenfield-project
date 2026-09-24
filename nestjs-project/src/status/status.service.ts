import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE_NAME } from '../videos/queue/video-processing.constants';

@Injectable()
export class StatusService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectQueue(VIDEO_PROCESSING_QUEUE_NAME)
    private readonly queue: Queue,
  ) {}

  async getStatus(): Promise<{
    service: string;
    status: 'ok';
    checkedAt: string;
    queue: { name: string; counts: Awaited<ReturnType<Queue['getJobCounts']>> };
  }> {
    try {
      await this.dataSource.query('SELECT 1');
      const counts = await this.queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );

      return {
        service: process.env.SERVICE_NAME ?? 'api',
        status: 'ok',
        checkedAt: new Date().toISOString(),
        queue: {
          name: VIDEO_PROCESSING_QUEUE_NAME,
          counts,
        },
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        service: process.env.SERVICE_NAME ?? 'api',
        status: 'error',
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown status error',
      });
    }
  }
}
