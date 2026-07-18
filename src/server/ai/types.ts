import type { AiModelOption, AiProvider, AiUsage } from "../../shared/types.js";

export interface AiGenerationRequest {
  apiKey: string;
  model: string;
  system: string;
  input: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface AiGenerationResult {
  text: string;
  usage: AiUsage;
}

export interface AiProviderAdapter {
  id: AiProvider;
  label: string;
  defaultModel: string;
  models: readonly AiModelOption[];
  generateText(request: AiGenerationRequest): Promise<AiGenerationResult>;
}
