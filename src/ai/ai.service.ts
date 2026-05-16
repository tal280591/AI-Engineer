import { Injectable } from '@nestjs/common';
import { AIProvider, AIRequest, AIResponse } from './ai.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { MockProvider } from './providers/mock.provider';

type ProviderName = 'mock' | 'anthropic' | 'openai';

@Injectable()
export class AiService {
  private readonly providerName: ProviderName;

  constructor(
    private readonly mockProvider: MockProvider,
    private readonly anthropicProvider: AnthropicProvider,
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
      case 'mock':
      default:
        return this.mockProvider;
    }
  }
}
