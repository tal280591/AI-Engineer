import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job as BullJob } from 'bullmq';

import { AnalysisExecutionService } from '../jobs/analysis-execution.service';

const CHUNK_QUEUE_JOB_NAME = 'analyze-chunk';

interface AnalyzeChunkJobData {
  jobId: string;
  chunkId: string;
}

/**
 * BullMQ worker entrypoint for chunk analysis jobs.
 *
 * Phase 2 mapping:
 * - Workflow: advances one chunk step in the document-analysis workflow.
 * - Tools: BullMQ retries one chunk at a time.
 * - Orchestrator: this processor handles chunk queue lifecycle events.
 * - Memory: delegates durable state changes to AnalysisExecutionService.
 * - Guardrails: lifecycle events finalize the parent job from DB state instead
 *   of trusting the queue event as the source of truth.
 */
@Processor('analysis')
export class ChunksProcessor extends WorkerHost {
  constructor(private readonly analysisExecution: AnalysisExecutionService) {
    super();
  }

  /**
   * Processes exactly one chunk queue job.
   *
   * Phase 2 mapping:
   * - Workflow: runs one chunk analysis step.
   * - Tools: throws failed chunk work back to BullMQ attempts/backoff.
   * - Memory: the execution service reads and writes durable chunk state.
   */
  async process(job: BullJob<AnalyzeChunkJobData>) {
    if (job.name !== CHUNK_QUEUE_JOB_NAME) return;

    await this.analysisExecution.processQueuedChunk(job.data.chunkId);
  }

  /**
   * Finalizes the parent job after a chunk queue job completes.
   *
   * Phase 2 mapping:
   * - Orchestrator: responds to BullMQ's completed event.
   * - Evaluation: recalculates user-visible job progress after each chunk.
   * - Guardrails: completion is derived from all chunk rows, not this event alone.
   */
  @OnWorkerEvent('completed')
  async onCompleted(job: BullJob<AnalyzeChunkJobData>) {
    if (job.name !== CHUNK_QUEUE_JOB_NAME) return;

    await this.analysisExecution.finalizeJobForChunk(job.data.chunkId);
  }

  /**
   * Finalizes the parent job after a chunk queue job fails.
   *
   * Phase 2 mapping:
   * - Tools: observes BullMQ failure lifecycle for one chunk.
   * - Memory: failed chunk state has already been persisted by the execution service.
   * - Guardrails: the parent job is marked failed only if chunk state says retry
   *   attempts are exhausted.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: BullJob<AnalyzeChunkJobData> | undefined) {
    if (!job || job.name !== CHUNK_QUEUE_JOB_NAME) return;

    await this.analysisExecution.finalizeJobForChunk(job.data.chunkId);
  }
}
