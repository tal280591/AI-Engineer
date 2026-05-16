import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { MockProvider } from './providers/mock.provider';

@Module({
  providers: [AiService, AnthropicProvider, MockProvider],
  exports: [AiService],
})
export class AiModule {}
