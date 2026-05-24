import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiModule } from '../ai/ai.module';
import { AnalysisExecutionService } from '../jobs/analysis-execution.service';
import { Chunk } from '../jobs/entities/chunk.entity';
import { Job } from '../jobs/entities/job.entity';
import { ChunksProcessor } from './chunks.processor';

/**
 * Owns chunk execution infrastructure.
 *
 * Phase 2 mapping:
 * - Workflow: executes individual chunk-analysis steps.
 * - Tools: registers the BullMQ analysis queue worker side.
 * - Orchestrator: hosts ChunksProcessor for chunk queue jobs.
 * - Memory: gives the execution service access to Job and Chunk repositories.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Job, Chunk]),
    BullModule.registerQueue({ name: 'analysis' }),
    AiModule,
  ],
  providers: [ChunksProcessor, AnalysisExecutionService],
})
export class ChunksModule {}
