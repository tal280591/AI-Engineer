import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Job } from './entities/job.entity';
import { Chunk } from './entities/chunk.entity';
import { Idempotency } from './entities/idempotency.entity';

@Injectable()
export class JobsService {
  constructor(
    @InjectQueue('analysis') private queue: Queue,
    @InjectRepository(Job) private jobRepo: Repository<Job>,
  ) {}

  /**
   * Creates a new analysis job exactly once for an idempotency key.
   *
   * Phase 2 mapping:
   * - Workflow: starts the document analysis pipeline by creating a job and chunks.
   * - Tools: enqueues BullMQ work after the database transaction commits.
   * - Memory: stores the idempotency claim before creating the job.
   * - Guardrails: prevents duplicate POST /jobs requests from creating duplicate jobs.
   */
  async createJob(
    text: string,
    headers: { idempotencyKey?: string },
  ): Promise<{ jobId: string; reused: boolean }> {
    const key = headers.idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const result = await this.jobRepo.manager.transaction(async (manager) => {
      // 0) Fast path (nice-to-have)
      const existing = await manager.findOne(Idempotency, {
        where: { key },
      });
      if (existing) return { jobId: existing.resourceId, reused: true };

      // 1) CLAIM the key first (race-safe, no error-code checking)
      const jobId = randomUUID();

      const insertRes = await manager
        .createQueryBuilder()
        .insert()
        .into(Idempotency)
        .values({ key, resourceId: jobId, resourceType: 'job' })
        .orIgnore()
        .execute();

      // If ignored, someone else already claimed it -> return existing jobId
      const inserted = (insertRes.identifiers?.length ?? 0) > 0;

      if (!inserted) {
        const again = await manager.findOne(Idempotency, { where: { key } });
        if (again) return { jobId: again.resourceId, reused: true };

        // extremely rare edge: if DB behaved unexpectedly
        throw new Error('IdempotencyKey claim failed unexpectedly');
      }

      // 2) Create job using the pre-generated jobId
      const job = manager.create(Job, { id: jobId, status: 'pending' });
      await manager.save(job);

      // 3) Create chunks
      const chunks = this.chunkText(text, 3000);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = manager.create(Chunk, {
          job,
          index: i,
          content: chunks[i],
          status: 'pending',
        });
        await manager.save(chunk);
      }

      job.totalChunks = chunks.length;
      await manager.save(job);

      return { jobId, reused: false };
    });

    // 4) Enqueue after commit, only if new
    if (!result.reused) {
      await this.queue.add(
        'analyze',
        { jobId: result.jobId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
    }

    return result;
  }

  async getJob(id: string) {
    return this.jobRepo.findOne({
      where: { id },
      relations: ['chunks'],
    });
  }

  private chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size));
    }
    return chunks;
  }
}
