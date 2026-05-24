import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job as BullJob } from 'bullmq';

import { AnalysisExecutionService } from './analysis-execution.service';

/**
 * BullMQ worker entrypoint for analysis jobs.
 *
 * Phase 2 mapping:
 * - Tools: BullMQ wakes the backend when analysis work is available.
 * - Orchestrator: this processor delegates execution to a service that owns
 *   database-backed retry/resume rules.
 */
@Processor('analysis')
export class JobsProcessor extends WorkerHost {
  constructor(private readonly analysisExecution: AnalysisExecutionService) {
    super();
  }

  async process(job: BullJob<{ jobId: string }>) {
    if (job.name !== 'analyze') return;

    await this.analysisExecution.runJob(job.data.jobId);
  }
}
