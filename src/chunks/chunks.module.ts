import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiModule } from '../ai/ai.module';
import { Job } from '../jobs/entities/job.entity';
import { ChunksProcessor } from './chunks.processor';
import { ChunksService } from './chunks.service';
import { Chunk } from './entities/chunk.entity';

/**
 * Owns chunk execution infrastructure.
 *
 * Phase 2 mapping:
 * - Workflow: executes individual chunk-analysis steps.
 * - Tools: registers the BullMQ analysis queue worker side.
 * - Orchestrator: hosts ChunksProcessor for chunk queue jobs.
 * - Memory: gives ChunksService access to Job and Chunk repositories.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Job, Chunk]),
    BullModule.registerQueue({ name: 'analysis' }),
    AiModule,
  ],
  providers: [ChunksProcessor, ChunksService],
})
export class ChunksModule {}
