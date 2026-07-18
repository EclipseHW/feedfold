import type {
  AiFeature,
  AiFeatureSetting,
  AiProvider,
  AiSettings,
  ArticleAiSummary,
} from "../../shared/types.js";
import type { AppDatabase, StoredArticleAiSummary } from "../db.js";
import {
  ARTICLE_SUMMARY_MAX_OUTPUT_TOKENS,
  ARTICLE_SUMMARY_PROMPT_VERSION,
  ARTICLE_SUMMARY_SYSTEM_PROMPT,
  prepareArticleSummary,
} from "./article-summary.js";
import type { CredentialCipher } from "./credential-cipher.js";
import { AiError } from "./errors.js";
import { createAiProviders } from "./providers.js";
import type { AiGenerationResult, AiProviderAdapter } from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface AiServiceOptions {
  credentialCipher: CredentialCipher | null;
  providers?: ReadonlyMap<AiProvider, AiProviderAdapter>;
  requestTimeoutMs?: number;
}

interface FeatureGenerationRequest {
  system: string;
  input: string;
  maxOutputTokens: number;
}

interface FeatureGenerationResult extends AiGenerationResult {
  provider: AiProvider;
  model: string;
}

function publicSummary(summary: StoredArticleAiSummary): ArticleAiSummary {
  return {
    text: summary.text,
    provider: summary.provider,
    model: summary.model,
    sourceKind: summary.sourceKind,
    generatedAt: summary.generatedAt,
    usage: summary.usage,
  };
}

export class AiService {
  private readonly providers: ReadonlyMap<AiProvider, AiProviderAdapter>;
  private readonly requestTimeoutMs: number;
  private readonly summariesInFlight = new Map<string, Promise<ArticleAiSummary | null>>();

  constructor(
    private readonly database: AppDatabase,
    private readonly options: AiServiceOptions,
  ) {
    this.providers = options.providers ?? createAiProviders();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  getSettings(userId: number): AiSettings {
    const configured = new Set(this.database.listConfiguredAiProviders(userId));
    const articleSummary = this.validFeatureSetting(
      this.database.getAiFeatureSetting(userId, "article_summary"),
    );
    return {
      credentialStorageAvailable: this.options.credentialCipher !== null,
      providers: [...this.providers.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        configured: configured.has(provider.id),
        defaultModel: provider.defaultModel,
        models: provider.models.map((model) => ({ ...model })),
      })),
      features: { articleSummary },
    };
  }

  setFeatureSetting(
    userId: number,
    feature: AiFeature,
    providerId: AiProvider,
    model?: string,
  ): AiSettings {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AiError("AI_NOT_CONFIGURED", 422, "Choose a supported AI provider.");
    }
    const selectedModel = model?.trim() || provider.defaultModel;
    if (!provider.models.some((candidate) => candidate.id === selectedModel)) {
      throw new AiError(
        "AI_MODEL_UNAVAILABLE",
        422,
        `Choose an available ${provider.label} model.`,
      );
    }
    this.database.setAiFeatureSetting(userId, feature, {
      provider: providerId,
      model: selectedModel,
    });
    return this.getSettings(userId);
  }

  setApiKey(userId: number, provider: AiProvider, apiKey: string): AiSettings {
    const cipher = this.options.credentialCipher;
    if (!cipher) {
      throw new AiError(
        "AI_CREDENTIAL_STORAGE_UNAVAILABLE",
        503,
        "API key storage is unavailable until AI_CREDENTIALS_KEY is configured on the server.",
      );
    }
    const encrypted = cipher.encrypt(userId, provider, apiKey.trim());
    this.database.setEncryptedAiCredential(userId, provider, encrypted);
    return this.getSettings(userId);
  }

  deleteApiKey(userId: number, provider: AiProvider): AiSettings {
    this.database.deleteAiCredential(userId, provider);
    return this.getSettings(userId);
  }

  async generateText(
    userId: number,
    feature: AiFeature,
    request: FeatureGenerationRequest,
  ): Promise<FeatureGenerationResult> {
    const setting = this.validFeatureSetting(this.database.getAiFeatureSetting(userId, feature));
    if (!setting) {
      throw new AiError(
        "AI_NOT_CONFIGURED",
        422,
        "Choose an AI provider and model in Settings first.",
      );
    }
    const provider = this.providers.get(setting.provider) as AiProviderAdapter;
    const encryptedKey = this.database.getEncryptedAiCredential(userId, setting.provider);
    if (!encryptedKey) {
      throw new AiError(
        "AI_KEY_MISSING",
        422,
        `Add an API key for ${provider.label} in Settings first.`,
      );
    }
    const cipher = this.options.credentialCipher;
    if (!cipher) {
      throw new AiError(
        "AI_CREDENTIAL_STORAGE_UNAVAILABLE",
        503,
        "The server cannot open saved API keys until AI_CREDENTIALS_KEY is configured.",
      );
    }
    const result = await provider.generateText({
      apiKey: cipher.decrypt(userId, setting.provider, encryptedKey),
      model: setting.model,
      ...request,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    return { ...result, provider: setting.provider, model: setting.model };
  }

  summarizeArticle(
    userId: number,
    articleId: number,
    regenerate = false,
  ): Promise<ArticleAiSummary | null> {
    const key = `${userId}:${articleId}`;
    const running = this.summariesInFlight.get(key);
    if (running) return running;
    const summary = this.createArticleSummary(userId, articleId, regenerate).finally(() => {
      this.summariesInFlight.delete(key);
    });
    this.summariesInFlight.set(key, summary);
    return summary;
  }

  private async createArticleSummary(
    userId: number,
    articleId: number,
    regenerate: boolean,
  ): Promise<ArticleAiSummary | null> {
    const article = this.database.getArticleForAiSummary(userId, articleId);
    if (!article) return null;
    if (!regenerate && article.currentSummary?.promptVersion === ARTICLE_SUMMARY_PROMPT_VERSION) {
      return publicSummary(article.currentSummary);
    }
    const prepared = prepareArticleSummary(article);
    const generated = await this.generateText(userId, "article_summary", {
      system: ARTICLE_SUMMARY_SYSTEM_PROMPT,
      input: prepared.input,
      maxOutputTokens: ARTICLE_SUMMARY_MAX_OUTPUT_TOKENS,
    });
    const saved = this.database.saveArticleAiSummary(userId, articleId, article.revision, {
      promptVersion: ARTICLE_SUMMARY_PROMPT_VERSION,
      sourceKind: prepared.sourceKind,
      provider: generated.provider,
      model: generated.model,
      text: generated.text,
      usage: generated.usage,
    });
    if (!saved) {
      throw new AiError(
        "ARTICLE_CHANGED",
        409,
        "The article changed while it was being summarized. Try again.",
      );
    }
    return publicSummary(saved);
  }

  private validFeatureSetting(setting: AiFeatureSetting | null): AiFeatureSetting | null {
    if (!setting) return null;
    const provider = this.providers.get(setting.provider);
    if (!provider?.models.some((model) => model.id === setting.model)) return null;
    return setting;
  }
}
