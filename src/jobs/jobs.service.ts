import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Job } from './entities/job.entity';
import { Chunk } from './entities/chunk.entity';
import { Idempotency } from './entities/idempotency.entity';

const DEFAULT_CHUNK_MAX_ATTEMPTS = 3;
const CHUNK_QUEUE_JOB_NAME = 'analyze-chunk';

interface CreatedChunkJob {
  chunkId: string;
  jobId: string;
  maxAttempts: number;
}

interface CreateJobTransactionResult {
  jobId: string;
  reused: boolean;
  chunksToEnqueue: CreatedChunkJob[];
}

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
   * - Tools: enqueues one BullMQ job per chunk after the DB transaction commits.
   * - Memory: stores the idempotency claim before creating the job.
   * - Guardrails: prevents duplicate POST /jobs requests from creating duplicate jobs
   *   and uses stable BullMQ chunk job IDs to avoid duplicate chunk queue items.
   */
  async createJob(
    text: string,
    headers: { idempotencyKey?: string },
  ): Promise<{ jobId: string; reused: boolean }> {
    const key = headers.idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const result = await this.jobRepo.manager.transaction(
      async (manager): Promise<CreateJobTransactionResult> => {
        // 0) Fast path (nice-to-have)
        const existing = await manager.findOne(Idempotency, {
          where: { key },
        });
        if (existing) {
          return {
            jobId: existing.resourceId,
            reused: true,
            chunksToEnqueue: [],
          };
        }

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
          if (again) {
            return {
              jobId: again.resourceId,
              reused: true,
              chunksToEnqueue: [],
            };
          }

          // extremely rare edge: if DB behaved unexpectedly
          throw new Error('IdempotencyKey claim failed unexpectedly');
        }

        // 2) Create job using the pre-generated jobId
        const job = manager.create(Job, { id: jobId, status: 'pending' });
        await manager.save(job);

        // 3) Create chunks
        const chunks = this.chunkText(text, 3000);
        const chunksToEnqueue: CreatedChunkJob[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = manager.create(Chunk, {
            job,
            index: i,
            content: chunks[i],
            status: 'pending',
            maxAttempts: DEFAULT_CHUNK_MAX_ATTEMPTS,
          });
          const savedChunk = await manager.save(chunk);
          chunksToEnqueue.push({
            chunkId: savedChunk.id,
            jobId,
            maxAttempts: savedChunk.maxAttempts,
          });
        }

        job.totalChunks = chunks.length;
        await manager.save(job);

        return { jobId, reused: false, chunksToEnqueue };
      },
    );

    // 4) Enqueue after commit, only if new
    if (!result.reused) {
      await this.enqueueChunkJobs(result.chunksToEnqueue);
    }

    return { jobId: result.jobId, reused: result.reused };
  }

  async getJob(id: string) {
    return this.jobRepo.findOne({
      where: { id },
      relations: ['chunks'],
    });
  }

  private async enqueueChunkJobs(chunks: CreatedChunkJob[]): Promise<void> {
    if (chunks.length === 0) return;

    await this.queue.addBulk(
      chunks.map((chunk) => ({
        name: CHUNK_QUEUE_JOB_NAME,
        data: { jobId: chunk.jobId, chunkId: chunk.chunkId },
        opts: {
          jobId: `chunk:${chunk.chunkId}`,
          attempts: chunk.maxAttempts,
          backoff: { type: 'exponential', delay: 1000 },
        },
      })),
    );
  }

  private chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size));
    }
    return chunks;
  }
}
