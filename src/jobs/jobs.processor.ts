import { Processor, Process } from '@nestjs/bull';
import { Job as BullJob } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from './entities/job.entity';
import { Chunk } from './entities/chunk.entity';
import { AiService } from '../ai/ai.service';

@Processor('analysis')
export class JobsProcessor {
  constructor(
    @InjectRepository(Job) private jobRepo: Repository<Job>,
    @InjectRepository(Chunk) private chunkRepo: Repository<Chunk>,
    private aiService: AiService,
  ) {}

  @Process('analyze')
  async handle(job: BullJob<{ jobId: string }>) {
    const jobEntity = await this.jobRepo.findOne({
      where: { id: job.data.jobId },
      relations: ['chunks'],
    });

    if (!jobEntity) {
      throw new Error(`Job ${job.data.jobId} not found`);
    }

    jobEntity.status = 'running';
    await this.jobRepo.save(jobEntity);

    for (const chunk of jobEntity.chunks) {
      if (chunk.status === 'completed') continue;

      chunk.status = 'running';
      await this.chunkRepo.save(chunk);

      const response = await this.aiService.generate({
        prompt: `Summarize this:\n${chunk.content}`,
        maxTokens: 500,
      });

      chunk.summary = response.content;
      chunk.status = 'completed';
      await this.chunkRepo.save(chunk);

      jobEntity.totalInputTokens += response.inputTokens;
      jobEntity.totalOutputTokens += response.outputTokens;
      jobEntity.completedChunks++;
      await this.jobRepo.save(jobEntity);
    }

    jobEntity.finalSummary = jobEntity.chunks.map((c) => c.summary).join('\n');

    jobEntity.status = 'completed';
    await this.jobRepo.save(jobEntity);
  }
}
