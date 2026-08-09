import type { DesktopOperation } from "../shared/desktop.js";
import type {
  AiArticleSourceKind,
  AiFeature,
  AiProvider,
  AiSettings,
  AppSettings,
  Article,
  ArticleAiSummary,
  ArticleAiTranslation,
  ArticlePage,
  ArticleQuery,
  BootstrapData,
  Feed,
  FeedDiscoveryResult,
  FeedSourceKind,
  Folder,
  FolderSortDirection,
  ImportResult,
  MarkReadRequest,
  RefreshResult,
  Rule,
  RuleAction,
  RuleCondition,
  RuleConditionOperator,
  SessionUser,
  TelegramArticleMedia,
  WebFeedAnalysis,
  WebFeedConfig,
  XArticleMedia,
} from "../shared/types.js";
import { invokeDesktop, isDesktopApp } from "./desktop.js";

export const AUTH_REQUIRED_EVENT = "echovale:auth-required";
const appBase =
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL?.replace(/\/$/, "") ??
  "";

export function appUrl(path: string): string {
  return `${appBase}${path}`;
}

export class ApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function httpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(appUrl(path), { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = `The request failed with HTTP ${response.status}. Try again.`;
    let code: string | null = null;
    try {
      const body = (await response.json()) as { error?: string; message?: string; code?: string };
      message = body.error ?? body.message ?? message;
      code = body.code ?? null;
    } catch {
      // The status code still gives the user a useful error when no JSON body exists.
    }
    if (
      response.status === 401 &&
      !path.startsWith("/api/auth/") &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(message, response.status, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException("The request was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The request was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function request<T>(
  operation: DesktopOperation,
  payload: unknown,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!isDesktopApp()) return httpRequest<T>(path, init);
  try {
    return await abortable(invokeDesktop<T>(operation, payload), init?.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const desktopError = error as Error & { status?: number; code?: string | null };
    throw new ApiError(desktopError.message, desktopError.status ?? 500, desktopError.code ?? null);
  }
}

function queryString(query: ArticleQuery): string {
  const params = new URLSearchParams({ state: query.state });
  if (query.feedId !== undefined) params.set("feedId", String(query.feedId));
  if (query.folderId !== undefined) params.set("folderId", String(query.folderId));
  if (query.search) params.set("search", query.search);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.anchorId !== undefined) params.set("anchorId", String(query.anchorId));
  if (query.includeContent) params.set("includeContent", "true");
  return params.toString();
}

export interface FeedInput {
  title?: string;
  feedUrl: string;
  siteUrl?: string | null;
  folderId: number | null;
  sourceKind: FeedSourceKind;
  webConfig?: WebFeedConfig;
}

export type FeedUpdateInput = Partial<Omit<FeedInput, "sourceKind" | "webConfig">> & {
  paused?: boolean;
};

export interface FolderInput {
  name: string;
  parentId: number | null;
  sortDirection: FolderSortDirection;
}

export interface RuleInput {
  name: string;
  feedId: number | null;
  folderId: number | null;
  conditions: RuleCondition[];
  conditionOperator: RuleConditionOperator;
  action: RuleAction;
  enabled: boolean;
}

export const api = {
  async session(): Promise<SessionUser> {
    const body = await request<{ user: SessionUser }>("session", undefined, "/api/auth/session");
    return body.user;
  },

  async login(username: string, password: string): Promise<SessionUser> {
    const body = await request<{ user: SessionUser }>(
      "login",
      { username, password },
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      },
    );
    return body.user;
  },

  async register(username: string, password: string): Promise<SessionUser> {
    const body = await request<{ user: SessionUser }>(
      "register",
      { username, password },
      "/api/auth/register",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      },
    );
    return body.user;
  },

  logout: () => request<void>("logout", undefined, "/api/auth/logout", { method: "POST" }),

  bootstrap: (signal?: AbortSignal) =>
    request<BootstrapData>("bootstrap", undefined, "/api/bootstrap", { signal }),

  articles: (query: ArticleQuery, signal?: AbortSignal) =>
    request<ArticlePage>("articles", query, `/api/articles?${queryString(query)}`, { signal }),

  article: (id: number, signal?: AbortSignal) =>
    request<Article>("article", { id }, `/api/articles/${id}`, { signal }),

  telegramArticleMedia: (id: number, signal?: AbortSignal) =>
    request<TelegramArticleMedia>(
      "telegramArticleMedia",
      { id },
      `/api/articles/${id}/telegram-media`,
      { signal },
    ),

  xArticleMedia: (id: number, signal?: AbortSignal) =>
    request<XArticleMedia>("xArticleMedia", { id }, `/api/articles/${id}/x-media`, { signal }),

  loadFullContent: (id: number) =>
    request<Article>("loadFullContent", { id }, `/api/articles/${id}/extract`, {
      method: "POST",
    }),

  summarizeArticle: (id: number, promptId: string | null, regenerate = false) =>
    request<ArticleAiSummary>(
      "summarizeArticle",
      { id, promptId, regenerate },
      `/api/articles/${id}/summary`,
      {
        method: "POST",
        body: JSON.stringify({ promptId, regenerate }),
      },
    ),

  translateArticle: (id: number, sourceKind: AiArticleSourceKind) =>
    request<ArticleAiTranslation>(
      "translateArticle",
      { id, sourceKind },
      `/api/articles/${id}/translation`,
      {
        method: "POST",
        body: JSON.stringify({ sourceKind }),
      },
    ),

  updateArticleState: (id: number, state: { isRead?: boolean; isStarred?: boolean }) =>
    request<Article>("updateArticleState", { id, state }, `/api/articles/${id}/state`, {
      method: "PATCH",
      body: JSON.stringify(state),
    }),

  markRead: (body: MarkReadRequest) =>
    request<{ updated: number }>("markRead", body, "/api/articles/mark-read", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  refresh: (feedIds?: number[]) =>
    request<RefreshResult>("refresh", feedIds ? { feedIds } : {}, "/api/refresh", {
      method: "POST",
      body: JSON.stringify(feedIds ? { feedIds } : {}),
    }),

  discoverFeed: (url: string) =>
    request<FeedDiscoveryResult>("discoverFeed", { url }, "/api/feeds/discover", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  analyzeWebPage: (url: string) =>
    request<WebFeedAnalysis>("analyzeWebPage", { url }, "/api/web-feeds/analyze", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  createFeed: (input: FeedInput) =>
    request<Feed>("createFeed", input, "/api/feeds", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  feed: (id: number) => request<Feed>("feed", { id }, `/api/feeds/${id}`),

  updateFeed: (id: number, input: FeedUpdateInput) =>
    request<Feed>("updateFeed", { id, input }, `/api/feeds/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteFeed: (id: number) =>
    request<void>("deleteFeed", { id }, `/api/feeds/${id}`, { method: "DELETE" }),

  analyzeWebFeed: (id: number) =>
    request<WebFeedAnalysis>("analyzeWebFeed", { id }, `/api/feeds/${id}/web-feed/analyze`, {
      method: "POST",
    }),

  updateWebFeedSelection: (id: number, config: WebFeedConfig) =>
    request<Feed>("updateWebFeedSelection", { id, config }, `/api/feeds/${id}/web-feed`, {
      method: "PATCH",
      body: JSON.stringify({ config }),
    }),

  createFolder: (input: FolderInput) =>
    request<Folder>("createFolder", input, "/api/folders", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateFolder: (id: number, input: Partial<FolderInput>) =>
    request<Folder>("updateFolder", { id, input }, `/api/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteFolder: (id: number) =>
    request<void>("deleteFolder", { id }, `/api/folders/${id}`, { method: "DELETE" }),

  async rules(signal?: AbortSignal): Promise<Rule[]> {
    const body = await request<{ rules: Rule[] }>("rules", undefined, "/api/rules", {
      signal,
    });
    return body.rules;
  },

  createRule: (input: RuleInput) =>
    request<Rule>("createRule", input, "/api/rules", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateRule: (id: number, input: Partial<RuleInput>) =>
    request<Rule>("updateRule", { id, input }, `/api/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteRule: (id: number) =>
    request<void>("deleteRule", { id }, `/api/rules/${id}`, { method: "DELETE" }),

  updateSettings: (input: Partial<AppSettings>) =>
    request<AppSettings>("updateSettings", input, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  aiSettings: () => request<AiSettings>("aiSettings", undefined, "/api/ai/settings"),

  updateAiFeature: (feature: AiFeature, input: { provider: AiProvider; model?: string }) =>
    request<AiSettings>("updateAiFeature", { feature, input }, `/api/ai/features/${feature}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  saveAiProviderKey: (provider: AiProvider, apiKey: string) =>
    request<AiSettings>(
      "saveAiProviderKey",
      { provider, apiKey },
      `/api/ai/providers/${provider}/key`,
      {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
      },
    ),

  deleteAiProviderKey: (provider: AiProvider) =>
    request<AiSettings>("deleteAiProviderKey", { provider }, `/api/ai/providers/${provider}/key`, {
      method: "DELETE",
    }),

  async importOpml(file: File): Promise<ImportResult> {
    const opml = await file.text();
    return request<ImportResult>("importOpml", { opml }, "/api/opml/import", {
      method: "POST",
      body: JSON.stringify({ opml }),
    });
  },

  async exportOpml(): Promise<void> {
    const bridge = window.echovaleDesktop;
    if (!bridge) {
      window.location.assign(appUrl("/api/opml/export"));
      return;
    }
    const response = await bridge.exportOpml();
    if (!response.ok) {
      throw new ApiError(response.error.message, response.error.status, response.error.code);
    }
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
