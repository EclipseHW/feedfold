export type ArticleState = "all" | "unread" | "read" | "starred";
export type ReadingMode = "magazine" | "expanded";
export type ExtractionStatus = "pending" | "processing" | "complete" | "failed" | "feed";
export type RuleField = "title" | "author" | "summary" | "content" | "any";
export type RuleAction = "hide" | "mark_read";

export interface Folder {
  id: number;
  parentId: number | null;
  name: string;
  position: number;
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
  contentHtml: string | null;
  contentSource: "article" | "feed" | null;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  isRead: boolean;
  isStarred: boolean;
}

export interface Rule {
  id: number;
  name: string;
  feedId: number | null;
  folderId: number | null;
  field: RuleField;
  pattern: string;
  action: RuleAction;
  enabled: boolean;
  matchedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  pollIntervalMinutes: number;
  singleKeyShortcuts: boolean;
}

export interface BootstrapData {
  folders: Folder[];
  feeds: Feed[];
  settings: AppSettings;
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
