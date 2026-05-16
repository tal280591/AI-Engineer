export type AIErrorCode = 'OVERLOADED' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNKNOWN';

export class AIProviderError extends Error {
  constructor(
    public readonly code: AIErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
