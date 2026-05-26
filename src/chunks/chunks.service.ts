import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';

import { AiService } from '../ai/ai.service';
import { AIResponse } from '../ai/ai.interface';
import { Job } from '../jobs/entities/job.entity';
import { Chunk } from './entities/chunk.entity';

const STALE_RUNNING_MS = 10 * 60 * 1000;
const RECOVER_RUNNING_ON_JOB_START_MS = 0;
const RETRYABLE_FAILURE_MESSAGE =
  'Job has retryable failed chunks; waiting for BullMQ retry';
const EXHAUSTED_FAILURE_MESSAGE = 'One or more chunks exhausted retry attempts';

interface FinalizedJobState {
  job: Job;
  hasRetryableFailures: boolean;
}

/**
 * Coordinates retry-safe chunk execution and parent-job finalization.
 *
 * Phase 2 mapping:
 * - Workflow: advances chunk summarization steps and finalizes the parent job.
 * - Orchestrator: gives ChunksProcessor chunk-level actions and event-safe
 *   finalization helpers.
 * - Memory: uses Postgres job/chunk rows as the source of truth.
 * - State Machine: owns chunk and job status transitions.
 * - Guardrails: skips completed chunks and derives job totals from chunks.
 */
@Injectable()
export class ChunksService {
  constructor(
    @InjectRepository(Job) private readonly jobRepo: Repository<Job>,
    @InjectRepository(Chunk) private readonly chunkRepo: Repository<Chunk>,
    private readonly aiService: AiService,
  ) {}

  /**
   * Runs one analysis pass for a job.
   *
   * BullMQ is the tool that wakes this method up, but database state decides
   * what still needs work. A fresh BullMQ pass means any already-running chunk
   * belongs to an earlier interrupted pass, so those chunks are recovered
   * immediately before selecting processable work. If retryable chunks fail
   * during this pass, the method throws after persisting their failed state so
   * BullMQ can schedule the next pass without losing chunk-level memory.
   */
  async runJob(jobId: string): Promise<void> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    await this.markJobRunning(job);
    await this.resetStaleRunningChunks(jobId, RECOVER_RUNNING_ON_JOB_START_MS);

    const chunks = await this.getProcessableChunks(jobId);
    for (const chunk of chunks) {
      await this.processChunkSafely(chunk.id);
    }

    const finalized = await this.finalizeJobStatus(jobId);
    if (finalized.hasRetryableFailures) {
      throw new Error(RETRYABLE_FAILURE_MESSAGE);
    }
  }

  /**
   * Processes one BullMQ chunk job and throws when the queue should retry it.
   *
   * Phase 2 mapping:
   * - Tools: aligns BullMQ attempts with one durable chunk unit.
   * - Memory: the chunk row still decides whether work is safe to run.
   * - State Machine: a failed result remains failed in Postgres before the
   *   error is rethrown to BullMQ.
   * - Guardrails: duplicate queue deliveries become no-ops for completed chunks.
   */
  async processQueuedChunk(chunkId: string): Promise<Chunk> {
    const chunk = await this.processChunkSafely(chunkId);

    if (chunk.status === 'failed') {
      throw new Error(chunk.lastError ?? `Chunk ${chunk.id} failed`);
    }

    return chunk;
  }

  /**
   * Recalculates the parent job for a chunk-level queue event.
   *
   * Phase 2 mapping:
   * - Orchestrator: lets BullMQ lifecycle listeners finalize the parent job.
   * - Memory: loads the chunk->job relationship from Postgres.
   * - Guardrails: finalization still derives status from all chunks, not from
   *   the queue event alone.
   */
  async finalizeJobForChunk(chunkId: string): Promise<FinalizedJobState> {
    const chunk = await this.chunkRepo.findOne({
      where: { id: chunkId },
      relations: ['job'],
    });

    if (!chunk) {
      throw new Error(`Chunk ${chunkId} not found`);
    }

    return this.finalizeJobStatus(chunk.job.id);
  }

  /**
   * Converts stale running chunks into retryable failed chunks.
   *
   * Phase 2 mapping:
   * - Memory: uses startedAt to detect work abandoned by a crashed worker.
   * - State Machine: moves stale running -> failed.
   * - Guardrails: prevents chunks from being stuck in running forever.
   */
  async resetStaleRunningChunks(
    jobId: string,
    staleAfterMs = STALE_RUNNING_MS,
  ): Promise<number> {
    const staleBefore = new Date(Date.now() - staleAfterMs);
    const staleChunks = await this.chunkRepo.find({
      where: [
        {
          job: { id: jobId },
          status: 'running',
          startedAt: LessThan(staleBefore),
        },
        {
          job: { id: jobId },
          status: 'running',
          startedAt: IsNull(),
        },
      ],
      relations: ['job'],
    });

    const now = new Date();
    for (const chunk of staleChunks) {
      chunk.status = 'failed';
      chunk.failedAt = now;
      chunk.lastError = `Chunk was running for more than ${staleAfterMs}ms and was reset for retry`;
      await this.chunkRepo.save(chunk);
    }

    return staleChunks.length;
  }

  /**
   * Returns chunks that are safe and useful to process for a job.
   *
   * Phase 2 mapping:
   * - Workflow: selects unfinished chunk-analysis steps.
   * - Memory: reads durable chunk state from Postgres.
   * - State Machine: allows pending chunks and retryable failed chunks.
   * - Guardrails: excludes completed chunks so summaries and token totals are
   *   not duplicated during retries.
   */
  async getProcessableChunks(jobId: string): Promise<Chunk[]> {
    const chunks = await this.chunkRepo.find({
      where: [
        { job: { id: jobId }, status: 'pending' },
        { job: { id: jobId }, status: 'failed' },
      ],
      relations: ['job'],
      order: { index: 'ASC' },
    });

    return chunks.filter(
      (chunk) =>
        chunk.status === 'pending' || chunk.attempts < chunk.maxAttempts,
    );
  }

  /**
   * Processes one chunk only after recovering stale state and claiming it.
   *
   * Phase 2 mapping:
   * - Tools: calls the configured AI provider only after the DB claim succeeds.
   * - Memory: Postgres performs stale recovery and claiming from durable state.
   * - State Machine: running(stale) -> failed, then pending/failed -> running.
   * - Guardrails: duplicate workers that do not receive a claimed row become
   *   no-ops, so they do not call the provider or duplicate token usage.
   */
  async processChunkSafely(chunkId: string): Promise<Chunk> {
    await this.recoverStaleRunningChunk(chunkId);

    const chunk = await this.claimChunkForProcessing(chunkId);

    if (!chunk) {
      return this.getChunkAfterMissedClaim(chunkId);
    }

    try {
      const response = await this.aiService.generate({
        prompt: `Summarize this:\n${chunk.content}`,
        maxTokens: 500,
      });

      return this.markChunkCompleted(chunk, response);
    } catch (error) {
      return this.markChunkFailed(chunk, error);
    }
  }

  /**
   * Recalculates the job from chunk state instead of trusting in-memory counts.
   *
   * Phase 2 mapping:
   * - Workflow: determines whether the whole job is done.
   * - Memory: derives aggregate totals from completed chunks.
   * - Evaluation: exposes truthful progress for status endpoints and tests.
   * - Guardrails: never marks a job completed unless every chunk completed.
   */
  async finalizeJobStatus(jobId: string): Promise<FinalizedJobState> {
    const job = await this.jobRepo.findOne({
      where: { id: jobId },
      relations: ['chunks'],
    });

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const chunks = [...job.chunks].sort((a, b) => a.index - b.index);
    const completedChunks = chunks.filter(
      (chunk) => chunk.status === 'completed',
    );
    const failedChunks = chunks.filter((chunk) => chunk.status === 'failed');
    const hasRetryableFailures = failedChunks.some(
      (chunk) => chunk.attempts < chunk.maxAttempts,
    );
    const hasExhaustedFailures = failedChunks.some(
      (chunk) => chunk.attempts >= chunk.maxAttempts,
    );

    job.totalChunks = chunks.length;
    job.completedChunks = completedChunks.length;
    job.totalInputTokens = completedChunks.reduce(
      (total, chunk) => total + chunk.inputTokens,
      0,
    );
    job.totalOutputTokens = completedChunks.reduce(
      (total, chunk) => total + chunk.outputTokens,
      0,
    );

    if (chunks.length === completedChunks.length) {
      await this.applyCompletedJobState(job, chunks);
    } else if (hasExhaustedFailures) {
      this.applyFailedJobState(job, EXHAUSTED_FAILURE_MESSAGE);
    } else {
      job.status = 'running';
      job.completedAt = null;
      job.failedAt = null;
      job.finalSummary = null;
      job.lastError = hasRetryableFailures ? RETRYABLE_FAILURE_MESSAGE : null;
    }

    await this.jobRepo.save(job);
    return { job, hasRetryableFailures };
  }

  /**
   * Converts this chunk from stale running to failed before claiming.
   *
   * Phase 2 mapping:
   * - Memory: startedAt tells us whether a running owner is too old to trust.
   * - State Machine: running(stale) moves to failed before normal retry logic.
   * - Guardrails: fresh running chunks are left alone, so active workers are not
   *   interrupted by duplicate deliveries.
   */
  private async recoverStaleRunningChunk(
    chunkId: string,
    staleAfterMs = STALE_RUNNING_MS,
  ): Promise<void> {
    const staleBefore = new Date(Date.now() - staleAfterMs);

    await this.chunkRepo
      .createQueryBuilder()
      .update(Chunk)
      .set({
        status: 'failed',
        failedAt: new Date(),
        lastError: `Chunk was running for more than ${staleAfterMs}ms and was reset for retry`,
      })
      .where('id = :chunkId', { chunkId })
      .andWhere('status = :status', { status: 'running' })
      .andWhere('("startedAt" < :staleBefore OR "startedAt" IS NULL)', {
        staleBefore,
      })
      .execute();
  }

  /**
   * Atomically claims a retryable chunk for one worker.
   *
   * Phase 2 mapping:
   * - Memory: the database combines eligibility checking and claiming.
   * - State Machine: only pending/failed chunks with attempts left can move to
   *   running.
   * - Guardrails: if another worker already changed the row, RETURNING yields
   *   no chunk and the caller must not process provider work.
   */
  private async claimChunkForProcessing(
    chunkId: string,
  ): Promise<Chunk | null> {
    const result = await this.chunkRepo
      .createQueryBuilder()
      .update(Chunk)
      .set({
        status: 'running',
        attempts: () => '"attempts" + 1',
        startedAt: new Date(),
        failedAt: null,
        lastError: null,
      })
      .where('id = :chunkId', { chunkId })
      .andWhere('status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .andWhere('attempts < "maxAttempts"')
      .returning('*')
      .execute();

    return this.getReturnedChunk(result.raw as unknown);
  }

  /**
   * Safely extracts the first returned row from TypeORM's untyped raw result.
   *
   * Phase 2 mapping:
   * - Memory: normalizes the database result into a typed chunk entity shape.
   * - Guardrails: treats malformed or empty RETURNING results as a missed claim
   *   instead of indexing into an unsafe any value.
   */
  private getReturnedChunk(rawResult: unknown): Chunk | null {
    if (!Array.isArray(rawResult) || rawResult.length === 0) {
      return null;
    }

    const [firstRow] = rawResult as unknown[];
    return firstRow ? (firstRow as Chunk) : null;
  }

  /**
   * Loads the current chunk state when this worker did not win the claim.
   *
   * Phase 2 mapping:
   * - Memory: returns the durable state that prevented claiming.
   * - Guardrails: completed, exhausted, or already-running chunks become safe
   *   no-ops for this worker.
   */
  private async getChunkAfterMissedClaim(chunkId: string): Promise<Chunk> {
    const chunk = await this.chunkRepo.findOne({
      where: { id: chunkId },
      relations: ['job'],
    });

    if (!chunk) {
      throw new Error(`Chunk ${chunkId} not found`);
    }

    return chunk;
  }

  private async markJobRunning(job: Job): Promise<Job> {
    job.status = 'running';
    job.startedAt ??= new Date();
    job.completedAt = null;
    job.failedAt = null;
    job.lastError = null;
    return this.jobRepo.save(job);
  }

  private async markChunkCompleted(
    chunk: Chunk,
    response: AIResponse,
  ): Promise<Chunk> {
    chunk.summary = response.content;
    chunk.inputTokens = response.inputTokens;
    chunk.outputTokens = response.outputTokens;
    chunk.status = 'completed';
    chunk.completedAt = new Date();
    chunk.failedAt = null;
    chunk.lastError = null;
    return this.chunkRepo.save(chunk);
  }

  private async markChunkFailed(chunk: Chunk, error: unknown): Promise<Chunk> {
    chunk.status = 'failed';
    chunk.failedAt = new Date();
    chunk.lastError = this.toErrorMessage(error);
    return this.chunkRepo.save(chunk);
  }

  private async applyCompletedJobState(
    job: Job,
    chunks: Chunk[],
  ): Promise<void> {
    const chunkSummaries = chunks
      .map((chunk) => chunk.summary)
      .filter((summary): summary is string => Boolean(summary))
      .join('\n\n');

    const response = await this.aiService.generate({
      prompt: `Create one coherent overall summary of the document from these chunk summaries:\n\n${chunkSummaries}`,
      maxTokens: 500,
    });

    job.status = 'completed';
    job.finalSummary = response.content;
    job.totalInputTokens += response.inputTokens;
    job.totalOutputTokens += response.outputTokens;
    job.completedAt = new Date();
    job.failedAt = null;
    job.lastError = null;
  }

  private applyFailedJobState(job: Job, message: string): void {
    job.status = 'failed';
    job.finalSummary = null;
    job.completedAt = null;
    job.failedAt = new Date();
    job.lastError = message;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
