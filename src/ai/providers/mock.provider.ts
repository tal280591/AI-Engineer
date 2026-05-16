import { Injectable } from '@nestjs/common';
import { AIProvider, AIRequest, AIResponse } from '../ai.interface';
import { AIProviderError } from '../ai.errors';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * MockProvider simulates an LLM provider for:
 * - async pipelines
 * - retries / failure handling
 * - cost & token tracking
 * - chunk processing + resume
 *
 * It can simulate latency and random provider errors.
 */
@Injectable()
export class MockProvider implements AIProvider {
  private readonly latencyMs = clamp(
    Number(process.env.MOCK_AI_LATENCY_MS ?? 200),
    0,
    30_000,
  );

  private readonly errorRate = clamp(
    Number(process.env.MOCK_AI_ERROR_RATE ?? 0),
    0,
    1,
  );

  private readonly maxOutputChars = clamp(
    Number(process.env.MOCK_AI_MAX_OUTPUT_CHARS ?? 800),
    50,
    20_000,
  );

  async generate(request: AIRequest): Promise<AIResponse> {
    // Simulate network / model latency
    if (this.latencyMs > 0) await sleep(this.latencyMs);

    // Simulate intermittent provider failure
    if (Math.random() < this.errorRate) {
      throw new AIProviderError(
        'OVERLOADED',
        'MockProvider: simulated transient error',
      );
    }

    // A super rough token estimate. Good enough for practicing budgeting.
    const inputTokens = this.estimateTokens(request.prompt);
    const outputTokens = clamp(
      Math.round(request.maxTokens * 0.15),
      5,
      request.maxTokens,
    );

    // Make deterministic-ish output so reruns are stable (important for idempotency testing)
    const content = this.buildMockSummary(request.prompt, this.maxOutputChars);

    return {
      content,
      inputTokens,
      outputTokens,
    };
  }

  private estimateTokens(text: string): number {
    // rough heuristic: ~4 chars/token in English. For Hebrew it can differ, but ok for mock.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private buildMockSummary(prompt: string, maxChars: number): string {
    const trimmed = prompt.replace(/\s+/g, ' ').trim();
    const sample = trimmed.slice(0, maxChars);

    // Very simple "summary-like" output:
    return [
      'MOCK_SUMMARY:',
      '- Key points extracted (simulated)',
      `- Prompt preview: "${sample}${trimmed.length > sample.length ? '…' : ''}"`,
      '- Confidence: simulated',
    ].join('\n');
  }
}
