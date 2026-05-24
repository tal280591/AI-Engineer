import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { Chunk } from '../chunks/entities/chunk.entity';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { Job } from './entities/job.entity';
import { Idempotency } from './entities/idempotency.entity';

/**
 * Owns the public jobs API and job creation workflow.
 *
 * Phase 2 mapping:
 * - Workflow: creates the parent job and its chunk records.
 * - Tools: enqueues chunk work onto BullMQ after DB commit.
 * - Memory: stores job, chunk, and idempotency records.
 * - Guardrails: preserves POST /jobs idempotency.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Job, Chunk, Idempotency]),
    BullModule.registerQueue({ name: 'analysis' }),
  ],
  providers: [JobsService],
  controllers: [JobsController],
})
export class JobsModule {}
