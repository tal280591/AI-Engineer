import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';

import { AiService } from '../ai/ai.service';
import { AIResponse } from '../ai/ai.interface';
import { Chunk } from './entities/chunk.entity';
import { Job } from './entities/job.entity';

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
 * Coordinates retry-safe analysis execution for a persisted job.
 *
 * Phase 2 mapping:
 * - Workflow: advances a job through chunk summarization steps.
 * - Orchestrator: gives the BullMQ processor one clear job-level action.
 * - Memory: uses Postgres job/chunk rows as the source of truth.
 * - State Machine: owns chunk and job status transitions.
 * - Guardrails: skips completed chunks and derives job totals from chunks.
 */
@Injectable()
export class AnalysisExecutionService {
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
   * Processes one chunk with idempotent state checks around the provider call.
   *
   * Phase 2 mapping:
   * - Tools: calls the configured AI provider.
   * - Memory: stores attempts, errors, summary, and token usage on the chunk.
   * - State Machine: pending/failed -> running -> completed or failed.
   * - Guardrails: completed chunks are no-ops, and token usage is stored once
   *   beside the chunk output instead of incrementing job totals directly.
   */
  async processChunkSafely(chunkId: string): Promise<Chunk> {
    const chunk = await this.chunkRepo.findOne({
      where: { id: chunkId },
      relations: ['job'],
    });

    if (!chunk) {
      throw new Error(`Chunk ${chunkId} not found`);
    }

    if (chunk.status === 'completed') {
      return chunk;
    }

    if (chunk.status === 'failed' && chunk.attempts >= chunk.maxAttempts) {
      return chunk;
    }

    chunk.status = 'running';
    chunk.attempts += 1;
    chunk.startedAt = new Date();
    chunk.failedAt = null;
    chunk.lastError = null;
    await this.chunkRepo.save(chunk);

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
    const completedChunks = chunks.filter((chunk) => chunk.status === 'completed');
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
      this.applyCompletedJobState(job, chunks);
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

  private applyCompletedJobState(job: Job, chunks: Chunk[]): void {
    job.status = 'completed';
    job.finalSummary = chunks.map((chunk) => chunk.summary ?? '').join('\n');
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
