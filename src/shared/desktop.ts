export const DESKTOP_OPERATIONS = [
  "session",
  "login",
  "register",
  "logout",
  "bootstrap",
  "articles",
  "article",
  "telegramArticleMedia",
  "xArticleMedia",
  "loadFullContent",
  "summarizeArticle",
  "translateArticle",
  "updateArticleState",
  "markRead",
  "refresh",
  "discoverFeed",
  "analyzeWebPage",
  "createFeed",
  "feed",
  "updateFeed",
  "deleteFeed",
  "analyzeWebFeed",
  "updateWebFeedSelection",
  "createFolder",
  "updateFolder",
  "deleteFolder",
  "rules",
  "createRule",
  "updateRule",
  "deleteRule",
  "updateSettings",
  "aiSettings",
  "updateAiFeature",
  "saveAiProviderKey",
  "deleteAiProviderKey",
  "importOpml",
  "exportOpml",
] as const;

export type DesktopOperation = (typeof DESKTOP_OPERATIONS)[number];

export interface DesktopRequest {
  operation: DesktopOperation;
  payload?: unknown;
}

export type DesktopResponse =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: {
        message: string;
        status: number;
        code: string | null;
      };
    };

export interface EchovaleDesktopBridge {
  readonly platform: "desktop";
  invoke(request: DesktopRequest): Promise<DesktopResponse>;
  exportOpml(): Promise<DesktopResponse>;
}
