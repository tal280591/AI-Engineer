import { Injectable } from '@nestjs/common';
import { Anthropic } from '@anthropic-ai/sdk';
import { AIProvider, AIRequest, AIResponse } from '../ai.interface';

@Injectable()
export class AnthropicProvider implements AIProvider {
  private client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  async generate(request: AIRequest): Promise<AIResponse> {
    const response = await this.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: request.maxTokens,
      messages: [{ role: 'user', content: request.prompt }],
    });

    return {
      content: extractText(response.content),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

function extractText(blocks: Anthropic.Messages.ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
