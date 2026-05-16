export interface AIRequest {
  prompt: string;
  maxTokens: number;
}

export interface AIResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIProvider {
  generate(request: AIRequest): Promise<AIResponse>;
}
