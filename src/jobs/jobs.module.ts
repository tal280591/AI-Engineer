import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { AnalysisExecutionService } from './analysis-execution.service';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { JobsProcessor } from './jobs.processor';
import { Job } from './entities/job.entity';
import { Chunk } from './entities/chunk.entity';
import { AiModule } from '../ai/ai.module';
import { Idempotency } from './entities/idempotency.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job, Chunk, Idempotency]),
    BullModule.registerQueue({ name: 'analysis' }),
    AiModule,
  ],
  providers: [JobsService, JobsProcessor, AnalysisExecutionService],
  controllers: [JobsController],
})
export class JobsModule {}
