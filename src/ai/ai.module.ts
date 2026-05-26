import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { MockProvider } from './providers/mock.provider';
import { OllamaProvider } from './providers/ollama.provider';

@Module({
  providers: [AiService, AnthropicProvider, MockProvider, OllamaProvider],
  exports: [AiService],
})
export class AiModule {}
