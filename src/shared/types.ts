export type ArticleState = "all" | "unread" | "read" | "starred";
export type FolderSortDirection = "newest" | "oldest";
export type ReadingMode = "magazine" | "expanded";
export type ExtractionStatus = "pending" | "processing" | "complete" | "failed" | "feed";
export type RuleField = "title" | "author" | "summary" | "content" | "media" | "any";
export type RuleAction = "hide" | "keep" | "mark_read";
export type RuleConditionOperator = "and" | "or";
export type AiProvider = "gemini" | "openai" | "anthropic";
export type AiFeature = "article_summary";
export type AiArticleSourceKind = "full" | "feed" | "excerpt";
export const MARK_READ_AGE_DAYS = [1, 2, 3, 7, 14] as const;
export type MarkReadAgeDays = (typeof MARK_READ_AGE_DAYS)[number];

export interface AiModelOption {
  id: string;
  label: string;
}

export interface AiProviderOption {
  id: AiProvider;
  label: string;
  configured: boolean;
  defaultModel: string;
  models: AiModelOption[];
}

export interface AiFeatureSetting {
  provider: AiProvider;
  model: string;
}

export interface AiSettings {
  credentialStorageAvailable: boolean;
  providers: AiProviderOption[];
  features: {
    articleSummary: AiFeatureSetting | null;
  };
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ArticleAiSummary {
  text: string;
  provider: AiProvider;
  model: string;
  sourceKind: AiArticleSourceKind;
  generatedAt: string;
  usage: AiUsage;
}

export interface RuleCondition {
  field: RuleField;
  pattern: string;
}

export interface ArticleMedia {
  provider: "youtube";
  type: "video" | "short";
  videoId: string;
  channelId: string | null;
  embedUrl: string;
  thumbnailUrl: string;
  viewCount: number | null;
  rating: {
    average: number;
    count: number;
  } | null;
}

export interface SessionUser {
  id: number;
  username: string;
}

export interface Folder {
  id: number;
  parentId: number | null;
  name: string;
  position: number;
  sortDirection: FolderSortDirection;
  unreadCount: number;
}

export interface Feed {
  id: number;
  folderId: number | null;
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  unreadCount: number;
  totalCount: number;
  paused: boolean;
  refreshing: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  nextPollAt: string | null;
}

export interface FeedPreviewArticle {
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  summary: string;
  imageUrl: string | null;
}

export interface FeedPreview {
  feedUrl: string;
  title: string;
  siteUrl: string | null;
  totalArticles: number;
  articles: FeedPreviewArticle[];
}

export interface Article {
  id: number;
  feedId: number;
  feedTitle: string;
  folderId: number | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  summary: string;
  imageUrl: string | null;
  media: ArticleMedia | null;
  feedContentHtml: string | null;
  contentHtml: string | null;
  contentSource: "article" | "feed" | null;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  aiSummary: ArticleAiSummary | null;
  isRead: boolean;
  isStarred: boolean;
}

export interface Rule {
  id: number;
  name: string;
  feedId: number | null;
  folderId: number | null;
  conditions: RuleCondition[];
  conditionOperator: RuleConditionOperator;
  action: RuleAction;
  enabled: boolean;
  matchedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  pollIntervalMinutes: number;
  singleKeyShortcuts: boolean;
  markReadOnScroll: boolean;
}

export interface BootstrapData {
  folders: Folder[];
  feeds: Feed[];
  settings: AppSettings;
  aiSettings: AiSettings;
  counts: {
    unread: number;
    starred: number;
    all: number;
  };
}

export interface ArticleQuery {
  state: ArticleState;
  feedId?: number;
  folderId?: number;
  search?: string;
  limit?: number;
  cursor?: string;
  includeContent?: boolean;
}

export interface MarkReadRequest {
  articleIds?: number[];
  feedId?: number;
  folderId?: number;
  olderThanDays?: MarkReadAgeDays;
}

export interface ArticlePage {
  articles: Article[];
  nextCursor: string | null;
}

export interface ImportResult {
  imported: number;
  duplicates: number;
  failed: Array<{ title: string; url: string; error: string }>;
}

export interface RefreshResult {
  requested: number;
  refreshingFeedIds: number[];
}
