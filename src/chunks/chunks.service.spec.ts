import { Repository } from 'typeorm';

import { AiService } from '../ai/ai.service';
import { Job } from '../jobs/entities/job.entity';
import { ChunksService } from './chunks.service';
import { Chunk } from './entities/chunk.entity';

describe('ChunksService', () => {
  let jobRepo: { findOne: jest.Mock; save: jest.Mock };
  let chunkRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let claimQueryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  let aiService: { generate: jest.Mock };
  let service: ChunksService;

  beforeEach(() => {
    jobRepo = {
      findOne: jest.fn(),
      save: jest.fn((job: Job) => job),
    };
    claimQueryBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn(),
    };
    claimQueryBuilder.update.mockReturnValue(claimQueryBuilder);
    claimQueryBuilder.set.mockReturnValue(claimQueryBuilder);
    claimQueryBuilder.where.mockReturnValue(claimQueryBuilder);
    claimQueryBuilder.andWhere.mockReturnValue(claimQueryBuilder);
    claimQueryBuilder.returning.mockReturnValue(claimQueryBuilder);

    chunkRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn((chunk: Chunk) => chunk),
      createQueryBuilder: jest.fn(() => claimQueryBuilder),
    };
    aiService = {
      generate: jest.fn(),
    };

    service = new ChunksService(
      jobRepo as unknown as Repository<Job>,
      chunkRepo as unknown as Repository<Chunk>,
      aiService as unknown as AiService,
    );
  });

  it('skips completed chunks without calling the AI provider', async () => {
    const completedChunk = makeChunk({ status: 'completed', summary: 'done' });
    mockMissedClaim();
    chunkRepo.findOne.mockResolvedValue(completedChunk);

    const result = await service.processChunkSafely(completedChunk.id);

    expect(result).toBe(completedChunk);
    expect(aiService.generate).not.toHaveBeenCalled();
    expect(chunkRepo.save).not.toHaveBeenCalled();
  });

  it('claims pending chunks atomically before calling the AI provider', async () => {
    const chunk = makeChunk({ status: 'running', attempts: 1 });
    mockClaimedChunk(chunk);
    aiService.generate.mockResolvedValue({
      content: 'summary',
      inputTokens: 10,
      outputTokens: 4,
    });

    await service.processChunkSafely(chunk.id);

    expect(claimQueryBuilder.set).toHaveBeenCalledWith({
      status: 'running',
      attempts: expect.any(Function),
      startedAt: expect.any(Date),
      failedAt: null,
      lastError: null,
    });
    expect(claimQueryBuilder.where).toHaveBeenCalledWith('id = :chunkId', {
      chunkId: chunk.id,
    });
    expect(claimQueryBuilder.andWhere).toHaveBeenCalledWith(
      'status IN (:...statuses)',
      { statuses: ['pending', 'failed'] },
    );
    expect(claimQueryBuilder.andWhere).toHaveBeenCalledWith(
      'attempts < "maxAttempts"',
    );
    expect(claimQueryBuilder.returning).toHaveBeenCalledWith('*');
    expect(aiService.generate).toHaveBeenCalledTimes(1);
  });

  it('does not call the AI provider when another worker already claimed the chunk', async () => {
    const runningChunk = makeChunk({ status: 'running', attempts: 1 });
    mockMissedClaim();
    chunkRepo.findOne.mockResolvedValue(runningChunk);

    const result = await service.processChunkSafely(runningChunk.id);

    expect(result).toBe(runningChunk);
    expect(aiService.generate).not.toHaveBeenCalled();
    expect(chunkRepo.save).not.toHaveBeenCalled();
  });

  it('stores summary and token usage on the chunk when processing succeeds', async () => {
    const chunk = makeChunk({ status: 'running', attempts: 1 });
    mockClaimedChunk(chunk);
    aiService.generate.mockResolvedValue({
      content: 'summary',
      inputTokens: 10,
      outputTokens: 4,
    });

    const result = await service.processChunkSafely(chunk.id);

    expect(aiService.generate).toHaveBeenCalledWith({
      prompt: `Summarize this:\n${chunk.content}`,
      maxTokens: 500,
    });
    expect(result.status).toBe('completed');
    expect(result.attempts).toBe(1);
    expect(result.summary).toBe('summary');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(4);
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it('marks failed chunks without hiding the provider error', async () => {
    const chunk = makeChunk({ status: 'running', attempts: 1 });
    mockClaimedChunk(chunk);
    aiService.generate.mockRejectedValue(new Error('provider unavailable'));

    const result = await service.processChunkSafely(chunk.id);

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBe('provider unavailable');
    expect(result.failedAt).toBeInstanceOf(Date);
  });

  it('throws failed queued chunks back to BullMQ after persisting state', async () => {
    const chunk = makeChunk({ status: 'running', attempts: 1 });
    mockClaimedChunk(chunk);
    aiService.generate.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.processQueuedChunk(chunk.id)).rejects.toThrow(
      'provider unavailable',
    );

    expect(chunk.status).toBe('failed');
    expect(chunk.attempts).toBe(1);
    expect(chunk.lastError).toBe('provider unavailable');
  });

  it('finalizes the parent job for a chunk queue event', async () => {
    const job = makeJob({ id: 'job-for-chunk' });
    const chunk = makeChunk({ id: 'chunk-for-event', job });
    const completed = makeChunk({
      index: 0,
      status: 'completed',
      summary: 'done',
      inputTokens: 8,
      outputTokens: 2,
    });
    const jobWithChunks = makeJob({ id: job.id, chunks: [completed] });
    chunkRepo.findOne.mockResolvedValue(chunk);
    jobRepo.findOne.mockResolvedValue(jobWithChunks);

    const result = await service.finalizeJobForChunk(chunk.id);

    expect(result.job.status).toBe('completed');
    expect(result.job.totalInputTokens).toBe(8);
    expect(result.job.totalOutputTokens).toBe(2);
  });

  it('finalizes a job from chunk state without double-counting tokens', async () => {
    const completed = makeChunk({
      index: 0,
      status: 'completed',
      summary: 'summary one',
      inputTokens: 10,
      outputTokens: 3,
    });
    const retryableFailed = makeChunk({
      index: 1,
      status: 'failed',
      attempts: 1,
      maxAttempts: 3,
    });
    const job = makeJob({ chunks: [retryableFailed, completed] });
    jobRepo.findOne.mockResolvedValue(job);

    const result = await service.finalizeJobStatus(job.id);

    expect(result.hasRetryableFailures).toBe(true);
    expect(job.status).toBe('running');
    expect(job.completedChunks).toBe(1);
    expect(job.totalInputTokens).toBe(10);
    expect(job.totalOutputTokens).toBe(3);
    expect(job.finalSummary).toBeNull();
    expect(job.lastError).toContain('retryable failed chunks');
  });

  it('only marks a job completed when every chunk completed', async () => {
    const first = makeChunk({
      index: 0,
      status: 'completed',
      summary: 'first',
      inputTokens: 5,
      outputTokens: 2,
    });
    const second = makeChunk({
      index: 1,
      status: 'completed',
      summary: 'second',
      inputTokens: 7,
      outputTokens: 3,
    });
    const job = makeJob({ chunks: [second, first] });
    jobRepo.findOne.mockResolvedValue(job);

    const result = await service.finalizeJobStatus(job.id);

    expect(result.hasRetryableFailures).toBe(false);
    expect(job.status).toBe('completed');
    expect(job.completedChunks).toBe(2);
    expect(job.totalInputTokens).toBe(12);
    expect(job.totalOutputTokens).toBe(5);
    expect(job.finalSummary).toBe('first\nsecond');
    expect(job.completedAt).toBeInstanceOf(Date);
  });

  it('marks the job failed when a chunk exhausts retry attempts', async () => {
    const exhausted = makeChunk({
      status: 'failed',
      attempts: 3,
      maxAttempts: 3,
      lastError: 'still failing',
    });
    const job = makeJob({ chunks: [exhausted] });
    jobRepo.findOne.mockResolvedValue(job);

    const result = await service.finalizeJobStatus(job.id);

    expect(result.hasRetryableFailures).toBe(false);
    expect(job.status).toBe('failed');
    expect(job.lastError).toContain('exhausted retry attempts');
    expect(job.failedAt).toBeInstanceOf(Date);
  });

  function mockClaimedChunk(chunk: Chunk): void {
    claimQueryBuilder.execute.mockResolvedValue({ raw: [chunk] });
  }

  function mockMissedClaim(): void {
    claimQueryBuilder.execute.mockResolvedValue({ raw: [] });
  }
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    status: 'pending',
    totalChunks: 0,
    completedChunks: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    finalSummary: null,
    lastError: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    chunks: [],
    ...overrides,
  } as Job;
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: 'chunk-1',
    index: 0,
    content: 'chunk content',
    status: 'pending',
    summary: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    job: makeJob(),
    ...overrides,
  } as Chunk;
}
