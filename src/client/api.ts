import type {
  AiFeature,
  AiProvider,
  AiSettings,
  AppSettings,
  Article,
  ArticleAiSummary,
  ArticlePage,
  ArticleQuery,
  BootstrapData,
  Feed,
  FeedPreview,
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
} from "../shared/types";

export const AUTH_REQUIRED_EVENT = "echovale:auth-required";
const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");

export function appUrl(path: string): string {
  return `${appBase}${path}`;
}

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(appUrl(path), { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
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
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function queryString(query: ArticleQuery): string {
  const params = new URLSearchParams({ state: query.state });
  if (query.feedId !== undefined) params.set("feedId", String(query.feedId));
  if (query.folderId !== undefined) params.set("folderId", String(query.folderId));
  if (query.search) params.set("search", query.search);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.includeContent) params.set("includeContent", "true");
  return params.toString();
}

export interface FeedInput {
  title?: string;
  feedUrl: string;
  siteUrl?: string | null;
  folderId: number | null;
}

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
    const body = await request<{ user: SessionUser }>("/api/auth/session");
    return body.user;
  },

  async login(username: string, password: string): Promise<SessionUser> {
    const body = await request<{ user: SessionUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return body.user;
  },

  async register(username: string, password: string): Promise<SessionUser> {
    const body = await request<{ user: SessionUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return body.user;
  },

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  bootstrap: () => request<BootstrapData>("/api/bootstrap"),

  articles: (query: ArticleQuery) => request<ArticlePage>(`/api/articles?${queryString(query)}`),

  article: (id: number) => request<Article>(`/api/articles/${id}`),

  loadFullContent: (id: number) =>
    request<Article>(`/api/articles/${id}/extract`, { method: "POST" }),

  summarizeArticle: (id: number, regenerate = false) =>
    request<ArticleAiSummary>(`/api/articles/${id}/summary`, {
      method: "POST",
      body: JSON.stringify(regenerate ? { regenerate: true } : {}),
    }),

  updateArticleState: (id: number, state: { isRead?: boolean; isStarred?: boolean }) =>
    request<Article>(`/api/articles/${id}/state`, {
      method: "PATCH",
      body: JSON.stringify(state),
    }),

  markRead: (body: MarkReadRequest) =>
    request<{ updated: number }>("/api/articles/mark-read", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  refresh: (feedIds?: number[]) =>
    request<RefreshResult>("/api/refresh", {
      method: "POST",
      body: JSON.stringify(feedIds ? { feedIds } : {}),
    }),

  discoverFeed: (url: string) =>
    request<FeedPreview>("/api/feeds/discover", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  createFeed: (input: FeedInput) =>
    request<Feed>("/api/feeds", { method: "POST", body: JSON.stringify(input) }),

  feed: (id: number) => request<Feed>(`/api/feeds/${id}`),

  updateFeed: (id: number, input: Partial<FeedInput> & { paused?: boolean }) =>
    request<Feed>(`/api/feeds/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  deleteFeed: (id: number) => request<void>(`/api/feeds/${id}`, { method: "DELETE" }),

  refreshFeed: (id: number) =>
    request<RefreshResult>(`/api/feeds/${id}/refresh`, { method: "POST" }),

  createFolder: (input: FolderInput) =>
    request<Folder>("/api/folders", { method: "POST", body: JSON.stringify(input) }),

  updateFolder: (id: number, input: Partial<FolderInput>) =>
    request<Folder>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  deleteFolder: (id: number) => request<void>(`/api/folders/${id}`, { method: "DELETE" }),

  async rules(): Promise<Rule[]> {
    const body = await request<{ rules: Rule[] }>("/api/rules");
    return body.rules;
  },

  createRule: (input: RuleInput) =>
    request<Rule>("/api/rules", { method: "POST", body: JSON.stringify(input) }),

  updateRule: (id: number, input: Partial<RuleInput>) =>
    request<Rule>(`/api/rules/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  deleteRule: (id: number) => request<void>(`/api/rules/${id}`, { method: "DELETE" }),

  updateSettings: (input: Partial<AppSettings>) =>
    request<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(input) }),

  aiSettings: () => request<AiSettings>("/api/ai/settings"),

  updateAiFeature: (feature: AiFeature, input: { provider: AiProvider; model?: string }) =>
    request<AiSettings>(`/api/ai/features/${feature}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  saveAiProviderKey: (provider: AiProvider, apiKey: string) =>
    request<AiSettings>(`/api/ai/providers/${provider}/key`, {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),

  deleteAiProviderKey: (provider: AiProvider) =>
    request<AiSettings>(`/api/ai/providers/${provider}/key`, { method: "DELETE" }),

  importOpml: async (file: File) =>
    request<ImportResult>("/api/opml/import", {
      method: "POST",
      body: JSON.stringify({ opml: await file.text() }),
    }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
