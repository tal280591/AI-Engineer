import { Injectable } from '@nestjs/common';
import { AIProvider, AIRequest, AIResponse } from './ai.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { MockProvider } from './providers/mock.provider';
import { OllamaProvider } from './providers/ollama.provider';

type ProviderName = 'mock' | 'anthropic' | 'openai' | 'ollama';

@Injectable()
export class AiService {
  private readonly providerName: ProviderName;

  constructor(
    private readonly mockProvider: MockProvider,
    private readonly anthropicProvider: AnthropicProvider,
    private readonly ollamaProvider: OllamaProvider,
    // later: private readonly openaiProvider: OpenAIProvider
  ) {
    this.providerName = (process.env.AI_PROVIDER as ProviderName) ?? 'mock';
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const provider = this.pickProvider();
    return provider.generate(request);
  }

  private pickProvider(): AIProvider {
    switch (this.providerName) {
      case 'anthropic':
        return this.anthropicProvider;
      case 'ollama':
        return this.ollamaProvider;
      case 'mock':
      default:
        return this.mockProvider;
    }
  }
}
