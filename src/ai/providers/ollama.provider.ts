// src/ai/providers/ollama.provider.ts

import { Injectable } from '@nestjs/common';
import { AIProvider, AIRequest, AIResponse } from '../ai.interface';

interface OllamaGenerateResponse {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Local Ollama provider for running real LLM calls without external API cost.
 *
 * Phase 2 mapping:
 * - Tools: uses a local Ollama model through its HTTP API.
 * - Evaluation: lets us test real summary behavior instead of mock output.
 * - Guardrails: keeps provider usage local so chunk experiments do not create
 *   paid API token costs.
 */
@Injectable()
export class OllamaProvider implements AIProvider {
  private readonly baseUrl =
    process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

  private readonly model = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';

  async generate(request: AIRequest): Promise<AIResponse> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: request.prompt,
        stream: false,
        options: {
          num_predict: request.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama request failed with ${response.status}: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    return {
      content: data.response ?? '',
      inputTokens: data.prompt_eval_count ?? estimateTokens(request.prompt),
      outputTokens: data.eval_count ?? estimateTokens(data.response ?? ''),
    };
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
