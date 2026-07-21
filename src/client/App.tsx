import { Check } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Article,
  ArticleQuery,
  ArticleState,
  BootstrapData,
  Feed,
  Folder as FolderType,
  MarkReadAgeDays,
  ReadingMode,
  Rule,
  SessionUser,
} from "../shared/types";
import { AUTH_REQUIRED_EVENT, api, errorMessage } from "./api";
import { fullContentToggleAction } from "./article-content";
import { LoginPage, SessionLoading } from "./auth";
import { articlesWithContextReturn, type ContextArticleReturn } from "./contextual-filter";
import {
  ContextManagementDialog,
  type FeedManagementAction,
  type FolderManagementAction,
  type ManagementRequest,
} from "./feed-management";
import { FeedsPage, type RuleFormDraft, RulesPage, SettingsPage, ShortcutHelp } from "./management";
import { motionExitDuration } from "./motion";
import { type AppView, ReaderToolbar, Sidebar } from "./navigation";
import {
  AppSkeleton,
  ArticleList,
  ArticleListSkeleton,
  type ArticleSummaryViewState,
  EMPTY_ARTICLE_SUMMARY_STATE,
  EmptyArticles,
  ExpandedStream,
  InlineError,
  ReaderPane,
  StartupError,
} from "./reader";
import {
  type AppRoute,
  appRoutePath,
  appRouteUrl,
  DEFAULT_READER_ROUTE,
  parseAppRoute,
  type ReaderRoute,
} from "./routes";

type Theme = "dark" | "light";

const ARTICLE_FONT_MIN = 15;
const ARTICLE_FONT_MAX = 23;
const ARTICLE_FONT_DEFAULT = 18;
const FILTER_RULE_NAME_TEXT_LIMIT = 72;
const APP_BASE_PATH = import.meta.env.BASE_URL;

function feedManagementRequest(feedId: number, action: FeedManagementAction): ManagementRequest {
  if (action === "settings") return { kind: "feed-settings", feedId };
  if (action === "rename") return { kind: "rename-feed", feedId };
  if (action === "move") return { kind: "move-feed", feedId };
  if (action === "rule") return { kind: "create-feed-rule", feedId };
  return { kind: "unsubscribe-feed", feedId };
}

interface AppHistoryState {
  echovale?: true;
  returnTo?: string;
  returnsWithBack?: boolean;
  articleIndex?: number;
}

function selectedReaderRoute(
  state: ArticleState,
  feedId: number | null,
  folderId: number | null,
  search: string,
): ReaderRoute {
  if (feedId !== null) {
    return { kind: "reader", scope: "feed", scopeId: feedId, state, search };
  }
  if (folderId !== null) {
    return { kind: "reader", scope: "folder", scopeId: folderId, state, search };
  }
  return { kind: "reader", scope: "all", scopeId: null, state, search };
}

function readerRouteFromReturnPath(path: string | undefined): ReaderRoute | null {
  if (!path) return null;
  const base = APP_BASE_PATH.replace(/\/$/, "");
  const url = new URL(`${base}${path}`, window.location.origin);
  const route = parseAppRoute(url.pathname, url.search, APP_BASE_PATH);
  return route.kind === "reader" ? route : null;
}

function articleQueryForReaderRoute(
  route: ReaderRoute,
  options: {
    limit: number;
    includeContent: boolean;
    cursor?: string;
  },
): ArticleQuery {
  return {
    state: route.state,
    ...(route.scope === "feed" && route.scopeId !== null ? { feedId: route.scopeId } : {}),
    ...(route.scope === "folder" && route.scopeId !== null ? { folderId: route.scopeId } : {}),
    ...(route.search ? { search: route.search } : {}),
    ...options,
  };
}

function filterRuleName(text: string): string {
  const label =
    text.length > FILTER_RULE_NAME_TEXT_LIMIT
      ? `${text.slice(0, FILTER_RULE_NAME_TEXT_LIMIT - 1).trimEnd()}…`
      : text;
  return `Filter: ${label}`;
}

function storedValue<T extends string>(key: string, fallback: T): T {
  const value = window.localStorage.getItem(key);
  return (value as T | null) ?? fallback;
}

function storedNumber(key: string, fallback: number): number {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? value : fallback;
}

function accountStorageKey(userId: number, setting: string): string {
  return `echovale-account-${userId}-${setting}`;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function sourceLabel(
  bootstrap: BootstrapData,
  feedId: number | null,
  folderId: number | null,
): string {
  if (feedId !== null) return bootstrap.feeds.find((feed) => feed.id === feedId)?.title ?? "Feed";
  if (folderId !== null)
    return bootstrap.folders.find((folder) => folder.id === folderId)?.name ?? "Folder";
  return "All articles";
}

function folderTreeIds(folders: FolderType[], rootId: number): Set<number> {
  const ids = new Set([rootId]);
  let foundChild = true;
  while (foundChild) {
    foundChild = false;
    for (const folder of folders) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        foundChild = true;
      }
    }
  }
  return ids;
}

function updateBootstrapCounts(
  bootstrap: BootstrapData,
  article: Article,
  unreadDelta: number,
  starredDelta: number,
): BootstrapData {
  return {
    ...bootstrap,
    counts: {
      ...bootstrap.counts,
      unread: Math.max(0, bootstrap.counts.unread + unreadDelta),
      starred: Math.max(0, bootstrap.counts.starred + starredDelta),
    },
    feeds: bootstrap.feeds.map((feed) =>
      feed.id === article.feedId
        ? { ...feed, unreadCount: Math.max(0, feed.unreadCount + unreadDelta) }
        : feed,
    ),
    folders: bootstrap.folders.map((folder) =>
      folder.id === article.folderId
        ? { ...folder, unreadCount: Math.max(0, folder.unreadCount + unreadDelta) }
        : folder,
    ),
  };
}

export function App() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  useEffect(() => {
    let active = true;
    void api
      .session()
      .then((sessionUser) => {
        if (active) setUser(sessionUser);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const requireAuthentication = () => {
      setUser(null);
      setCheckingSession(false);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  if (checkingSession) return <SessionLoading />;
  if (!user) return <LoginPage onAuthenticated={setUser} />;
  return <ReaderApp key={user.id} user={user} onLogout={logout} />;
}

function ReaderApp({ user, onLogout }: { user: SessionUser; onLogout: () => Promise<void> }) {
  const initialRoute = useRef(
    parseAppRoute(window.location.pathname, window.location.search, APP_BASE_PATH),
  ).current;
  const initialArticleReturnRoute = useRef(
    initialRoute.kind === "article"
      ? readerRouteFromReturnPath(((window.history.state ?? {}) as AppHistoryState).returnTo)
      : null,
  ).current;
  const initialReaderRoute = useRef<ReaderRoute>(
    initialRoute.kind === "reader"
      ? initialRoute
      : initialRoute.kind === "article"
        ? (initialArticleReturnRoute ?? { ...DEFAULT_READER_ROUTE, state: "all" })
        : DEFAULT_READER_ROUTE,
  ).current;
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [articlesLoadingMore, setArticlesLoadingMore] = useState(false);
  const [articlesError, setArticlesError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeArticleId, setActiveArticleId] = useState<number | null>(
    initialRoute.kind === "article" ? initialRoute.articleId : null,
  );
  const [routedArticleId, setRoutedArticleId] = useState<number | null>(
    initialRoute.kind === "article" ? initialRoute.articleId : null,
  );
  const [routedArticleRetry, setRoutedArticleRetry] = useState(0);
  const [articleStateFilter, setArticleStateFilter] = useState<ArticleState>(
    initialReaderRoute.state,
  );
  const [selectedFeedId, setSelectedFeedId] = useState<number | null>(
    initialReaderRoute.scope === "feed" ? initialReaderRoute.scopeId : null,
  );
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(
    initialReaderRoute.scope === "folder" ? initialReaderRoute.scopeId : null,
  );
  const [searchInput, setSearchInput] = useState(initialReaderRoute.search);
  const [search, setSearch] = useState(initialReaderRoute.search);
  const [readingMode, setReadingMode] = useState<ReadingMode>(() =>
    storedValue<ReadingMode>(accountStorageKey(user.id, "reading-mode"), "magazine"),
  );
  const [theme, setTheme] = useState<Theme>(() =>
    storedValue<Theme>(accountStorageKey(user.id, "theme"), "dark"),
  );
  const [articleFontSize, setArticleFontSize] = useState(() =>
    Math.min(
      ARTICLE_FONT_MAX,
      Math.max(
        ARTICLE_FONT_MIN,
        storedNumber(accountStorageKey(user.id, "article-font-size"), ARTICLE_FONT_DEFAULT),
      ),
    ),
  );
  const [view, setView] = useState<AppView>(
    initialRoute.kind === "reader" || initialRoute.kind === "article"
      ? "reader"
      : initialRoute.kind === "add-feed"
        ? "feeds"
        : initialRoute.kind,
  );
  const [addFeedSourceUrl, setAddFeedSourceUrl] = useState<string | null>(
    initialRoute.kind === "add-feed" ? initialRoute.sourceUrl : null,
  );
  const [rules, setRules] = useState<Rule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleFormDraft | null>(null);
  const [managementRequest, setManagementRequest] = useState<ManagementRequest | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(initialRoute.kind === "article");
  const [expandedKeyboardTargetId, setExpandedKeyboardTargetId] = useState<number | null>(
    initialRoute.kind === "article" ? initialRoute.articleId : null,
  );
  const [fullContentVisibleIds, setFullContentVisibleIds] = useState<Set<number>>(() => new Set());
  const [articleSummaryStates, setArticleSummaryStates] = useState<
    Map<number, ArticleSummaryViewState>
  >(() => new Map());
  const [markReadPending, setMarkReadPending] = useState(false);
  const [toast, setToast] = useState<{ message: string; visible: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const toastExitTimer = useRef<number | null>(null);
  const sequence = useRef<{ startedAt: number } | null>(null);
  const ruleDraftId = useRef(0);
  const contextArticleReturn = useRef<ContextArticleReturn | null>(null);
  const contextArticleReturnRoute = useRef<ReaderRoute | null>(null);
  const articlesRef = useRef(articles);
  const fullContentVisibleIdsRef = useRef(new Set<number>());
  const fullContentLoadedIds = useRef(new Set<number>());
  const fullContentLoadingIds = useRef(new Set<number>());
  const summaryLoadingIds = useRef(new Set<number>());
  const manuallyUnreadArticleIds = useRef(new Set<number>());
  const lastReaderRoute = useRef<ReaderRoute>(initialReaderRoute);
  const currentRoute = useRef<AppRoute>(initialRoute);
  const articleListRequestId = useRef(0);
  const loadedReaderRequestKey = useRef<string | null>(null);
  const bootstrapReady = bootstrap !== null;
  articlesRef.current = articles;

  const applyAppRoute = useCallback((route: AppRoute) => {
    currentRoute.current = route;
    articleListRequestId.current += 1;
    setArticlesLoadingMore(false);
    setNavOpen(false);
    if (route.kind === "reader") {
      lastReaderRoute.current = route;
      setView("reader");
      setAddFeedSourceUrl(null);
      setRoutedArticleId(null);
      setArticleStateFilter(route.state);
      setSelectedFeedId(route.scope === "feed" ? route.scopeId : null);
      setSelectedFolderId(route.scope === "folder" ? route.scopeId : null);
      setSearchInput(route.search);
      setSearch(route.search);
      setReaderOpen(false);
      setExpandedKeyboardTargetId(null);
      return;
    }
    if (route.kind === "article") {
      setView("reader");
      setAddFeedSourceUrl(null);
      setRoutedArticleId(route.articleId);
      setActiveArticleId(route.articleId);
      setArticlesLoading(false);
      setArticlesError(null);
      setReaderOpen(true);
      setExpandedKeyboardTargetId(route.articleId);
      return;
    }
    if (route.kind === "add-feed") {
      loadedReaderRequestKey.current = null;
      setView("feeds");
      setAddFeedSourceUrl(route.sourceUrl);
      setRoutedArticleId(null);
      setReaderOpen(false);
      setExpandedKeyboardTargetId(null);
      return;
    }
    loadedReaderRequestKey.current = null;
    setView(route.kind);
    setAddFeedSourceUrl(null);
    setRoutedArticleId(null);
    setReaderOpen(false);
    setExpandedKeyboardTargetId(null);
  }, []);

  const navigateToRoute = useCallback(
    (route: AppRoute, historyMode: "push" | "replace" = "push") => {
      const url = appRouteUrl(route, APP_BASE_PATH);
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      const previousState = (window.history.state ?? {}) as AppHistoryState;
      if (currentUrl === url) {
        window.history.replaceState({ ...previousState, echovale: true }, "", url);
        setNavOpen(false);
        return;
      }
      const state: AppHistoryState = { echovale: true };
      if (route.kind === "article") {
        state.returnTo = appRoutePath(lastReaderRoute.current);
        const articleIndex = articlesRef.current.findIndex(
          (article) => article.id === route.articleId,
        );
        if (articleIndex >= 0) state.articleIndex = articleIndex;
        state.returnsWithBack =
          (historyMode === "push" && currentRoute.current.kind === "reader") ||
          (historyMode === "replace" &&
            currentRoute.current.kind === "article" &&
            previousState.returnsWithBack === true);
      }
      if (historyMode === "replace") window.history.replaceState(state, "", url);
      else window.history.pushState(state, "", url);
      applyAppRoute(route);
    },
    [applyAppRoute],
  );

  useEffect(() => {
    const currentRoute = parseAppRoute(
      window.location.pathname,
      window.location.search,
      APP_BASE_PATH,
    );
    const currentState = (window.history.state ?? {}) as AppHistoryState;
    const state: AppHistoryState = { ...currentState, echovale: true };
    window.history.replaceState(state, "", appRouteUrl(currentRoute, APP_BASE_PATH));

    const restoreRoute = () => {
      applyAppRoute(parseAppRoute(window.location.pathname, window.location.search, APP_BASE_PATH));
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [applyAppRoute]);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (toastExitTimer.current) window.clearTimeout(toastExitTimer.current);
    setToast({ message, visible: true });
    toastTimer.current = window.setTimeout(() => {
      setToast((current) => (current ? { ...current, visible: false } : current));
      toastExitTimer.current = window.setTimeout(() => setToast(null), motionExitDuration());
    }, 2800);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      if (toastExitTimer.current) window.clearTimeout(toastExitTimer.current);
    },
    [],
  );

  const loadBootstrap = useCallback(async () => {
    setBootstrapError(null);
    try {
      setBootstrap(await api.bootstrap());
    } catch (error) {
      setBootstrapError(errorMessage(error));
    }
  }, []);

  const loadArticles = useCallback(async () => {
    if (!bootstrapReady || currentRoute.current.kind !== "reader") return;
    const requestKey = `${appRoutePath(currentRoute.current)}:${readingMode}`;
    const requestId = articleListRequestId.current + 1;
    articleListRequestId.current = requestId;
    setArticlesLoadingMore(false);
    const returnTarget =
      contextArticleReturn.current &&
      contextArticleReturnRoute.current &&
      appRoutePath(contextArticleReturnRoute.current) === appRoutePath(currentRoute.current)
        ? contextArticleReturn.current
        : null;
    if (contextArticleReturn.current && !returnTarget) {
      contextArticleReturn.current = null;
      contextArticleReturnRoute.current = null;
    }
    if (!returnTarget) setArticlesLoading(true);
    setArticlesError(null);
    try {
      const page = await api.articles({
        state: articleStateFilter,
        ...(selectedFeedId !== null ? { feedId: selectedFeedId } : {}),
        ...(selectedFolderId !== null ? { folderId: selectedFolderId } : {}),
        ...(search ? { search } : {}),
        limit: readingMode === "expanded" ? 20 : 100,
        includeContent: readingMode === "expanded",
      });
      if (articleListRequestId.current !== requestId || currentRoute.current.kind !== "reader") {
        return;
      }
      const nextArticles = articlesWithContextReturn(page.articles, returnTarget);
      loadedReaderRequestKey.current = requestKey;
      setArticles(nextArticles);
      fullContentVisibleIdsRef.current = new Set();
      setFullContentVisibleIds(new Set());
      setNextCursor(page.nextCursor);
      fullContentLoadedIds.current = new Set(
        readingMode === "expanded" ? page.articles.map((article) => article.id) : [],
      );
      fullContentLoadingIds.current.clear();
      setReaderOpen(returnTarget ? readingMode === "magazine" : false);
      setExpandedKeyboardTargetId(
        returnTarget && readingMode === "expanded" ? returnTarget.article.id : null,
      );
      setActiveArticleId((current) => {
        if (returnTarget) return returnTarget.article.id;
        if (current !== null && nextArticles.some((article) => article.id === current))
          return current;
        return nextArticles[0]?.id ?? null;
      });
      if (contextArticleReturn.current === returnTarget) {
        contextArticleReturn.current = null;
        contextArticleReturnRoute.current = null;
      }
    } catch (error) {
      if (articleListRequestId.current === requestId) setArticlesError(errorMessage(error));
    } finally {
      if (articleListRequestId.current === requestId) setArticlesLoading(false);
    }
  }, [articleStateFilter, bootstrapReady, readingMode, search, selectedFeedId, selectedFolderId]);

  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    setRulesError(null);
    try {
      setRules(await api.rules());
    } catch (error) {
      setRulesError(errorMessage(error));
    } finally {
      setRulesLoading(false);
    }
  }, []);

  const loadOlderArticles = useCallback(async (): Promise<Article[]> => {
    const route =
      currentRoute.current.kind === "reader"
        ? currentRoute.current
        : currentRoute.current.kind === "article"
          ? lastReaderRoute.current
          : null;
    if (!bootstrapReady || !nextCursor || articlesLoadingMore || !route) {
      return [];
    }
    const requestId = articleListRequestId.current;
    setArticlesLoadingMore(true);
    try {
      const page = await api.articles(
        articleQueryForReaderRoute(route, {
          limit: readingMode === "expanded" ? 20 : 100,
          includeContent: readingMode === "expanded",
          cursor: nextCursor,
        }),
      );
      if (
        articleListRequestId.current !== requestId ||
        (currentRoute.current.kind !== "reader" && currentRoute.current.kind !== "article")
      ) {
        return [];
      }
      const existingIds = new Set(articles.map((article) => article.id));
      const appended = page.articles.filter((article) => !existingIds.has(article.id));
      setArticles((current) => {
        const ids = new Set(current.map((article) => article.id));
        return [...current, ...page.articles.filter((article) => !ids.has(article.id))];
      });
      setNextCursor(page.nextCursor);
      if (readingMode === "expanded") {
        for (const article of appended) fullContentLoadedIds.current.add(article.id);
      }
      return appended;
    } catch (error) {
      if (articleListRequestId.current === requestId) {
        showToast(`Could not load older articles: ${errorMessage(error)}`);
      }
      return [];
    } finally {
      if (articleListRequestId.current === requestId) setArticlesLoadingMore(false);
    }
  }, [articles, articlesLoadingMore, bootstrapReady, nextCursor, readingMode, showToast]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (view !== "reader" || routedArticleId !== null || currentRoute.current.kind !== "reader") {
      return;
    }
    const requestKey = `${appRoutePath(currentRoute.current)}:${readingMode}`;
    if (contextArticleReturn.current || loadedReaderRequestKey.current !== requestKey) {
      void loadArticles();
    }
  }, [loadArticles, readingMode, routedArticleId, view]);

  useEffect(() => {
    if (view === "rules") void loadRules();
  }, [loadRules, view]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(accountStorageKey(user.id, "theme"), theme);
  }, [theme, user.id]);

  useEffect(() => {
    document.documentElement.style.setProperty("--article-font-size", `${articleFontSize}px`);
    window.localStorage.setItem(
      accountStorageKey(user.id, "article-font-size"),
      String(articleFontSize),
    );
  }, [articleFontSize, user.id]);

  useEffect(() => {
    window.localStorage.setItem(accountStorageKey(user.id, "reading-mode"), readingMode);
  }, [readingMode, user.id]);

  const activeArticle = useMemo(
    () => articles.find((article) => article.id === activeArticleId) ?? null,
    [activeArticleId, articles],
  );

  const mergeFullArticle = useCallback((updated: Article) => {
    fullContentLoadedIds.current.add(updated.id);
    setArticles((current) =>
      current.map((article) =>
        article.id === updated.id
          ? { ...updated, isRead: article.isRead, isStarred: article.isStarred }
          : article,
      ),
    );
  }, []);

  const loadFullArticle = useCallback(
    async (article: Article) => {
      if (fullContentLoadedIds.current.has(article.id)) return;
      if (fullContentLoadingIds.current.has(article.id)) return;

      fullContentLoadingIds.current.add(article.id);
      try {
        const fullArticle = await api.article(article.id);
        if (!fullContentVisibleIdsRef.current.has(article.id)) mergeFullArticle(fullArticle);
      } catch (error) {
        showToast(`Could not load full article: ${errorMessage(error)}`);
      } finally {
        fullContentLoadingIds.current.delete(article.id);
      }
    },
    [mergeFullArticle, showToast],
  );

  useEffect(() => {
    if (
      (readingMode === "magazine" && !readerOpen) ||
      !activeArticle ||
      !fullContentVisibleIds.has(activeArticle.id) ||
      (activeArticle.extractionStatus !== "pending" &&
        activeArticle.extractionStatus !== "processing")
    ) {
      return;
    }
    const articleId = activeArticle.id;
    const poll = window.setInterval(() => {
      void api
        .article(articleId)
        .then((updated) => {
          mergeFullArticle(updated);
        })
        .catch(() => {
          // A transient poll error should not replace readable feed content with an error screen.
        });
    }, 2000);
    return () => window.clearInterval(poll);
  }, [activeArticle, fullContentVisibleIds, mergeFullArticle, readerOpen, readingMode]);

  const changeArticleState = useCallback(
    async (article: Article, change: { isRead?: boolean; isStarred?: boolean }) => {
      const nextRead = change.isRead ?? article.isRead;
      const nextStarred = change.isStarred ?? article.isStarred;
      const unreadDelta = nextRead === article.isRead ? 0 : nextRead ? -1 : 1;
      const starredDelta = nextStarred === article.isStarred ? 0 : nextStarred ? 1 : -1;
      const wasManuallyUnread = manuallyUnreadArticleIds.current.has(article.id);

      if (change.isRead === false) manuallyUnreadArticleIds.current.add(article.id);
      if (change.isRead === true) manuallyUnreadArticleIds.current.delete(article.id);

      setArticles((current) =>
        current.map((item) =>
          item.id === article.id ? { ...item, isRead: nextRead, isStarred: nextStarred } : item,
        ),
      );
      setBootstrap((current) =>
        current ? updateBootstrapCounts(current, article, unreadDelta, starredDelta) : current,
      );

      try {
        await api.updateArticleState(article.id, change);
      } catch (error) {
        if (wasManuallyUnread) manuallyUnreadArticleIds.current.add(article.id);
        else manuallyUnreadArticleIds.current.delete(article.id);
        showToast(`Could not update article: ${errorMessage(error)}`);
        await loadBootstrap();
        if (currentRoute.current.kind === "article") {
          setArticles((current) => current.filter((item) => item.id !== article.id));
          setRoutedArticleRetry((current) => current + 1);
        } else {
          await loadArticles();
        }
      }
    },
    [loadArticles, loadBootstrap, showToast],
  );

  const activateArticle = useCallback(
    (article: Article, openReader = true) => {
      setActiveArticleId(article.id);
      if (openReader) setReaderOpen(true);
      if (!article.isRead) void changeArticleState(article, { isRead: true });
      void loadFullArticle(article);
    },
    [changeArticleState, loadFullArticle],
  );

  const openArticle = useCallback(
    (article: Article, openReader = true, historyMode: "push" | "replace" = "push") => {
      activateArticle(article, openReader);
      if (openReader) {
        navigateToRoute({ kind: "article", articleId: article.id }, historyMode);
      }
    },
    [activateArticle, navigateToRoute],
  );

  useEffect(() => {
    if (!bootstrapReady || view !== "reader" || routedArticleId === null) return;
    void routedArticleRetry;
    let active = true;
    const existing = articlesRef.current.find((article) => article.id === routedArticleId);

    const showArticle = (article: Article) => {
      if (!active) return;
      if (!existing) loadedReaderRequestKey.current = null;
      setArticles((current) =>
        current.some((item) => item.id === article.id)
          ? current.map((item) =>
              item.id === article.id
                ? { ...article, isRead: item.isRead, isStarred: item.isStarred }
                : item,
            )
          : [article, ...current],
      );
      setArticlesError(null);
      activateArticle(article, true);
    };

    if (existing) {
      showArticle(existing);
      return () => {
        active = false;
      };
    }

    setArticlesLoading(true);
    setArticlesError(null);
    void api
      .article(routedArticleId)
      .then(async (article) => {
        const state = (window.history.state ?? {}) as AppHistoryState;
        const queueRoute =
          readerRouteFromReturnPath(state.returnTo) ??
          selectedReaderRoute("all", article.feedId, null, "");
        lastReaderRoute.current = queueRoute;
        setArticleStateFilter(queueRoute.state);
        setSelectedFeedId(queueRoute.scope === "feed" ? queueRoute.scopeId : null);
        setSelectedFolderId(queueRoute.scope === "folder" ? queueRoute.scopeId : null);
        setSearchInput(queueRoute.search);
        setSearch(queueRoute.search);

        const page = await api.articles(
          articleQueryForReaderRoute(queueRoute, {
            limit: readingMode === "expanded" ? 20 : 100,
            includeContent: readingMode === "expanded",
          }),
        );
        return { article, page, queueRoute, articleIndex: state.articleIndex };
      })
      .then(({ article, page, queueRoute, articleIndex }) => {
        if (!active) return;
        const pageIndex = page.articles.findIndex((item) => item.id === article.id);
        const nextArticles = articlesWithContextReturn(page.articles, {
          article,
          index: articleIndex ?? Math.max(0, pageIndex),
        });
        loadedReaderRequestKey.current = `${appRoutePath(queueRoute)}:${readingMode}`;
        fullContentLoadedIds.current.add(article.id);
        setArticles(nextArticles);
        setNextCursor(page.nextCursor);
        setArticlesError(null);
        activateArticle(article, true);
      })
      .catch((error) => {
        if (active) setArticlesError(errorMessage(error));
      })
      .finally(() => {
        if (active) setArticlesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activateArticle, bootstrapReady, readingMode, routedArticleId, routedArticleRetry, view]);

  const moveArticle = useCallback(
    async (direction: 1 | -1): Promise<boolean> => {
      if (articles.length === 0) return false;
      const openReader = readingMode === "magazine" || routedArticleId !== null;
      if (openReader && !readerOpen && activeArticle) {
        openArticle(activeArticle, true);
        return true;
      }
      const currentIndex = articles.findIndex((article) => article.id === activeArticleId);
      if (
        direction === 1 &&
        currentIndex === articles.length - 1 &&
        nextCursor &&
        !articlesLoadingMore
      ) {
        const appended = await loadOlderArticles();
        const next = appended[0];
        if (!next) return false;
        if (!openReader) setExpandedKeyboardTargetId(next.id);
        openArticle(next, openReader, readerOpen ? "replace" : "push");
        return true;
      }
      const nextIndex = Math.min(
        articles.length - 1,
        Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + direction),
      );
      const next = articles[nextIndex];
      if (next && next.id !== activeArticleId) {
        if (!openReader) setExpandedKeyboardTargetId(next.id);
        openArticle(next, openReader, readerOpen ? "replace" : "push");
        return true;
      }
      return false;
    },
    [
      activeArticle,
      activeArticleId,
      articles,
      articlesLoadingMore,
      loadOlderArticles,
      nextCursor,
      openArticle,
      readingMode,
      readerOpen,
      routedArticleId,
    ],
  );

  const copyArticleUrl = useCallback(
    async (article: Article | null) => {
      if (!article?.url) {
        showToast("This article has no source URL");
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(article.url);
        } else {
          const input = document.createElement("textarea");
          input.value = article.url;
          input.style.position = "fixed";
          input.style.opacity = "0";
          document.body.append(input);
          input.select();
          document.execCommand("copy");
          input.remove();
        }
        showToast("Article URL copied");
      } catch {
        showToast("Could not copy the article URL");
      }
    },
    [showToast],
  );

  const openArticleSource = useCallback(
    (article: Article | null) => {
      if (!article?.url) {
        showToast("This article has no source URL");
        return;
      }
      window.open(article.url, "_blank", "noopener,noreferrer");
    },
    [showToast],
  );

  const toggleFullContent = useCallback(
    async (article: Article) => {
      if (!article.url || article.media) return;
      const action = fullContentToggleAction(
        article,
        fullContentVisibleIdsRef.current.has(article.id),
      );
      if (action === "wait") return;
      if (action === "hide") {
        fullContentVisibleIdsRef.current.delete(article.id);
        setFullContentVisibleIds((current) => {
          const next = new Set(current);
          next.delete(article.id);
          return next;
        });
        return;
      }
      fullContentVisibleIdsRef.current.add(article.id);
      setFullContentVisibleIds((current) => new Set(current).add(article.id));
      if (action === "show") return;
      try {
        mergeFullArticle(await api.loadFullContent(article.id));
      } catch (error) {
        fullContentVisibleIdsRef.current.delete(article.id);
        setFullContentVisibleIds((current) => {
          const next = new Set(current);
          next.delete(article.id);
          return next;
        });
        showToast(`Could not load full content: ${errorMessage(error)}`);
        void loadFullArticle(article);
      }
    },
    [loadFullArticle, mergeFullArticle, showToast],
  );

  const selectScope = useCallback(
    (feedId: number | null, folderId: number | null, state: ArticleState = articleStateFilter) => {
      navigateToRoute(selectedReaderRoute(state, feedId, folderId, search));
    },
    [articleStateFilter, navigateToRoute, search],
  );

  const navigateTo = useCallback(
    (nextView: AppView) => {
      navigateToRoute(nextView === "reader" ? lastReaderRoute.current : { kind: nextView });
    },
    [navigateToRoute],
  );

  const patchArticleSummaryState = useCallback(
    (articleId: number, change: Partial<ArticleSummaryViewState>) => {
      setArticleSummaryStates((current) => {
        const next = new Map(current);
        next.set(articleId, {
          ...(current.get(articleId) ?? EMPTY_ARTICLE_SUMMARY_STATE),
          ...change,
        });
        return next;
      });
    },
    [],
  );

  const generateArticleSummary = useCallback(
    async (article: Article, regenerate: boolean) => {
      if (summaryLoadingIds.current.has(article.id)) return;
      const feature = bootstrap?.aiSettings.features.articleSummary;
      const provider = feature
        ? bootstrap?.aiSettings.providers.find((option) => option.id === feature.provider)
        : null;
      if (!bootstrap?.aiSettings.credentialStorageAvailable || !feature || !provider?.configured) {
        patchArticleSummaryState(article.id, {
          visible: true,
          loading: false,
          error: null,
          configurationMissing: true,
        });
        return;
      }

      summaryLoadingIds.current.add(article.id);
      patchArticleSummaryState(article.id, {
        visible: true,
        loading: true,
        error: null,
        configurationMissing: false,
      });
      try {
        const summary = await api.summarizeArticle(article.id, regenerate);
        setArticles((current) =>
          current.map((item) => (item.id === article.id ? { ...item, aiSummary: summary } : item)),
        );
        patchArticleSummaryState(article.id, { loading: false });
      } catch (caught) {
        patchArticleSummaryState(article.id, {
          loading: false,
          error: errorMessage(caught),
        });
      } finally {
        summaryLoadingIds.current.delete(article.id);
      }
    },
    [bootstrap?.aiSettings, patchArticleSummaryState],
  );

  const toggleArticleSummary = useCallback(
    (article: Article) => {
      const state = articleSummaryStates.get(article.id) ?? EMPTY_ARTICLE_SUMMARY_STATE;
      if (state.loading) return;
      if (state.visible) {
        patchArticleSummaryState(article.id, { visible: false });
        return;
      }
      if (article.aiSummary) {
        patchArticleSummaryState(article.id, {
          visible: true,
          error: null,
          configurationMissing: false,
        });
        return;
      }
      void generateArticleSummary(article, false);
    },
    [articleSummaryStates, generateArticleSummary, patchArticleSummaryState],
  );

  const regenerateArticleSummary = useCallback(
    (article: Article) => void generateArticleSummary(article, true),
    [generateArticleSummary],
  );

  const filterSelectedText = useCallback(
    (article: Article, text: string) => {
      const pattern = text.replace(/\s+/g, " ").trim();
      if (!pattern) return;
      ruleDraftId.current += 1;
      setRuleDraft({
        id: ruleDraftId.current,
        name: filterRuleName(pattern),
        article,
        articleIndex: Math.max(
          0,
          articles.findIndex((item) => item.id === article.id),
        ),
        feedId: article.feedId,
        field: "any",
        pattern,
      });
      contextArticleReturnRoute.current = lastReaderRoute.current;
      const state = (window.history.state ?? {}) as AppHistoryState;
      const fromReaderRoute = currentRoute.current.kind === "reader";
      const returnsWithBack =
        fromReaderRoute ||
        (currentRoute.current.kind === "article" && state.returnsWithBack === true);
      navigateToRoute({ kind: "rules" }, fromReaderRoute ? "push" : "replace");
      const rulesState = (window.history.state ?? {}) as AppHistoryState;
      window.history.replaceState(
        {
          ...rulesState,
          returnTo: appRoutePath(lastReaderRoute.current),
          returnsWithBack,
        },
        "",
      );
    },
    [articles, navigateToRoute],
  );

  const clearRuleDraft = useCallback(() => setRuleDraft(null), []);

  const openFeedManagement = useCallback((feed: Feed, action: FeedManagementAction) => {
    setManagementRequest(feedManagementRequest(feed.id, action));
  }, []);

  const openFeedManagementById = useCallback(
    (feedId: number, action: FeedManagementAction) => {
      const feed = bootstrap?.feeds.find((candidate) => candidate.id === feedId);
      if (feed) openFeedManagement(feed, action);
    },
    [bootstrap, openFeedManagement],
  );

  const openFolderManagement = useCallback((folder: FolderType, action: FolderManagementAction) => {
    if (action === "settings") {
      setManagementRequest({ kind: "folder-settings", folderId: folder.id });
    } else if (action === "add-feed") {
      setManagementRequest({ kind: "add-feed-to-folder", folderId: folder.id });
    } else if (action === "add-folder") {
      setManagementRequest({ kind: "add-folder", parentId: folder.id });
    } else {
      setManagementRequest({ kind: "create-folder-rule", folderId: folder.id });
    }
  }, []);

  const reloadContextManagement = useCallback(async () => {
    const route = currentRoute.current;
    const readerRoute =
      route.kind === "reader" ? route : route.kind === "article" ? lastReaderRoute.current : null;
    const routePath = appRoutePath(route);
    const activeIndex = articlesRef.current.findIndex((article) => article.id === activeArticleId);
    const preserveActive =
      activeIndex >= 0 && (route.kind === "article" || readingMode === "expanded")
        ? articlesRef.current[activeIndex]
        : null;
    const requestId = readerRoute ? articleListRequestId.current + 1 : null;
    if (requestId !== null) {
      articleListRequestId.current = requestId;
      setArticlesLoadingMore(false);
    }

    const articleReload = readerRoute
      ? (async () => {
          const targetCount = Math.max(
            articlesRef.current.length,
            readingMode === "expanded" ? 20 : 100,
          );
          const reloaded: Article[] = [];
          let cursor: string | null = null;
          do {
            const page = await api.articles({
              state: readerRoute.state,
              ...(readerRoute.scope === "feed" && readerRoute.scopeId !== null
                ? { feedId: readerRoute.scopeId }
                : {}),
              ...(readerRoute.scope === "folder" && readerRoute.scopeId !== null
                ? { folderId: readerRoute.scopeId }
                : {}),
              ...(readerRoute.search ? { search: readerRoute.search } : {}),
              limit: Math.min(500, targetCount - reloaded.length),
              includeContent: readingMode === "expanded",
              ...(cursor ? { cursor } : {}),
            });
            reloaded.push(...page.articles);
            cursor = page.nextCursor;
          } while (cursor && reloaded.length < targetCount);

          return {
            articles: reloaded,
            nextCursor: cursor,
            activeArticle: preserveActive ? await api.article(preserveActive.id) : null,
          };
        })()
      : Promise.resolve(null);

    const [bootstrapResult, , articleResult] = await Promise.allSettled([
      api.bootstrap(),
      loadRules(),
      articleReload,
    ]);
    if (bootstrapResult.status === "fulfilled") {
      setBootstrap(bootstrapResult.value);
    }
    if (
      readerRoute &&
      requestId !== null &&
      articleResult.status === "fulfilled" &&
      articleResult.value &&
      articleListRequestId.current === requestId &&
      appRoutePath(currentRoute.current) === routePath
    ) {
      const refreshed = articleResult.value;
      const nextArticles = articlesWithContextReturn(
        refreshed.articles,
        refreshed.activeArticle
          ? { article: refreshed.activeArticle, index: activeIndex }
          : preserveActive
            ? { article: preserveActive, index: activeIndex }
            : null,
      );
      setArticles(nextArticles);
      setNextCursor(refreshed.nextCursor);
      setActiveArticleId((current) =>
        current !== null && nextArticles.some((article) => article.id === current)
          ? current
          : (nextArticles[0]?.id ?? null),
      );
      if (readingMode === "expanded") {
        for (const article of refreshed.articles) fullContentLoadedIds.current.add(article.id);
      }
      loadedReaderRequestKey.current = `${appRoutePath(readerRoute)}:${readingMode}`;
    } else {
      loadedReaderRequestKey.current = null;
    }
  }, [activeArticleId, loadRules, readingMode]);

  const returnToContextArticle = useCallback(
    (draft: RuleFormDraft) => {
      contextArticleReturn.current = { article: draft.article, index: draft.articleIndex };
      setActiveArticleId(draft.article.id);
      setReaderOpen(readingMode === "magazine");
      setExpandedKeyboardTargetId(readingMode === "expanded" ? draft.article.id : null);
      const rulesState = (window.history.state ?? {}) as AppHistoryState;
      const returnTo = appRoutePath(contextArticleReturnRoute.current ?? lastReaderRoute.current);
      const returnsWithBack =
        rulesState.returnTo === returnTo && rulesState.returnsWithBack === true;
      navigateToRoute({ kind: "article", articleId: draft.article.id }, "replace");
      const articleState = (window.history.state ?? {}) as AppHistoryState;
      window.history.replaceState({ ...articleState, returnTo, returnsWithBack }, "");
    },
    [navigateToRoute, readingMode],
  );

  const moveScope = useCallback(
    (direction: 1 | -1) => {
      if (!bootstrap) return;
      const scopes = [
        { feedId: null, folderId: null },
        ...bootstrap.folders.map((folder) => ({ feedId: null, folderId: folder.id })),
        ...bootstrap.feeds.map((feed) => ({ feedId: feed.id, folderId: null })),
      ];
      const current = scopes.findIndex(
        (scope) => scope.feedId === selectedFeedId && scope.folderId === selectedFolderId,
      );
      const next = (Math.max(current, 0) + direction + scopes.length) % scopes.length;
      const scope = scopes[next];
      if (scope) selectScope(scope.feedId, scope.folderId);
    },
    [bootstrap, selectScope, selectedFeedId, selectedFolderId],
  );

  const returnToArticleList = useCallback(() => {
    const state = (window.history.state ?? {}) as AppHistoryState;
    if (state.echovale && state.returnTo && state.returnsWithBack) {
      window.history.back();
      return;
    }
    const returnRoute = readerRouteFromReturnPath(state.returnTo);
    if (state.echovale && returnRoute) {
      navigateToRoute(returnRoute, "replace");
      return;
    }
    navigateToRoute(lastReaderRoute.current, "replace");
  }, [navigateToRoute]);

  const unsubscribeFromFeed = useCallback(
    async (feed: Feed): Promise<boolean> => {
      try {
        await api.deleteFeed(feed.id);
        showToast(`Unsubscribed from ${feed.title}`);
        await loadBootstrap();

        const current = currentRoute.current;
        const readerRoute =
          current.kind === "article"
            ? lastReaderRoute.current
            : current.kind === "reader"
              ? current
              : DEFAULT_READER_ROUTE;
        const nextRoute: ReaderRoute =
          readerRoute.scope === "feed" && readerRoute.scopeId === feed.id
            ? { ...readerRoute, scope: "all", scopeId: null }
            : readerRoute;
        loadedReaderRequestKey.current = null;

        if (current.kind === "article" || appRoutePath(current) !== appRoutePath(nextRoute)) {
          navigateToRoute(nextRoute, "replace");
          return true;
        }
        await loadArticles();
        return true;
      } catch (error) {
        showToast(`Could not unsubscribe: ${errorMessage(error)}`);
        return false;
      }
    },
    [loadArticles, loadBootstrap, navigateToRoute, showToast],
  );

  const refresh = useCallback(
    async (feedId?: number, forceAll = false) => {
      if (!bootstrap) return;
      let ids: number[] | undefined;
      if (!forceAll) {
        if (feedId !== undefined) {
          ids = [feedId];
        } else if (selectedFeedId !== null) {
          ids = [selectedFeedId];
        } else if (selectedFolderId !== null) {
          const folderIds = folderTreeIds(bootstrap.folders, selectedFolderId);
          ids = bootstrap.feeds
            .filter((feed) => feed.folderId !== null && folderIds.has(feed.folderId))
            .map((feed) => feed.id);
        }
      }
      setBootstrap((current) =>
        current
          ? {
              ...current,
              feeds: current.feeds.map((feed) =>
                !ids || ids.includes(feed.id) ? { ...feed, refreshing: true } : feed,
              ),
            }
          : current,
      );
      try {
        const result =
          feedId !== undefined && !forceAll
            ? await api.refreshFeed(feedId)
            : await api.refresh(ids);
        showToast(`Refreshing ${result.requested} ${result.requested === 1 ? "feed" : "feeds"}`);
        const trackedIds = new Set(result.refreshingFeedIds);
        let latest = await api.bootstrap();
        setBootstrap(latest);
        while (latest.feeds.some((feed) => trackedIds.has(feed.id) && feed.refreshing)) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
          latest = await api.bootstrap();
          setBootstrap(latest);
        }
        if (currentRoute.current.kind === "reader") await loadArticles();
        else loadedReaderRequestKey.current = null;
        showToast("Refresh complete");
      } catch (error) {
        showToast(`Refresh failed: ${errorMessage(error)}`);
        await loadBootstrap();
      }
    },
    [bootstrap, loadArticles, loadBootstrap, selectedFeedId, selectedFolderId, showToast],
  );

  const markArticleBatchRead = useCallback(
    async (candidates: Article[]): Promise<boolean> => {
      const unique = new Map<number, Article>();
      for (const article of candidates) {
        if (!article.isRead) unique.set(article.id, article);
      }
      const unreadArticles = [...unique.values()];
      if (unreadArticles.length === 0) return true;

      const ids = new Set(unreadArticles.map((article) => article.id));
      const protectedIds = unreadArticles
        .filter((article) => manuallyUnreadArticleIds.current.has(article.id))
        .map((article) => article.id);
      for (const id of ids) manuallyUnreadArticleIds.current.delete(id);
      setArticles((current) =>
        current.map((article) => (ids.has(article.id) ? { ...article, isRead: true } : article)),
      );
      setBootstrap((current) => {
        if (!current) return current;
        return unreadArticles.reduce(
          (next, article) => updateBootstrapCounts(next, article, -1, 0),
          current,
        );
      });

      try {
        await api.markRead({ articleIds: [...ids] });
        return true;
      } catch (error) {
        for (const id of protectedIds) manuallyUnreadArticleIds.current.add(id);
        showToast(`Could not mark articles read: ${errorMessage(error)}`);
        await Promise.all([loadBootstrap(), loadArticles()]);
        return false;
      }
    },
    [loadArticles, loadBootstrap, showToast],
  );

  const markPassedArticlesRead = useCallback(
    (candidates: Article[]) =>
      markArticleBatchRead(
        candidates.filter((article) => !manuallyUnreadArticleIds.current.has(article.id)),
      ),
    [markArticleBatchRead],
  );

  const markVisibleRead = useCallback(async () => {
    const unreadArticles = articles.filter((article) => !article.isRead);
    if (unreadArticles.length === 0) {
      showToast("No unread articles in this view");
      return;
    }

    if (await markArticleBatchRead(unreadArticles)) {
      showToast(
        `Marked ${unreadArticles.length} ${unreadArticles.length === 1 ? "article" : "articles"} read`,
      );
    }
  }, [articles, markArticleBatchRead, showToast]);

  const markOlderArticlesRead = useCallback(
    async (days: MarkReadAgeDays) => {
      setMarkReadPending(true);
      try {
        const result = await api.markRead({
          olderThanDays: days,
          ...(selectedFeedId !== null ? { feedId: selectedFeedId } : {}),
          ...(selectedFolderId !== null ? { folderId: selectedFolderId } : {}),
        });
        await Promise.all([loadBootstrap(), loadArticles()]);
        showToast(
          result.updated === 0
            ? "No unread articles matched that age"
            : `Marked ${result.updated} ${result.updated === 1 ? "article" : "articles"} read`,
        );
      } catch (error) {
        showToast(`Could not mark older articles read: ${errorMessage(error)}`);
      } finally {
        setMarkReadPending(false);
      }
    },
    [loadArticles, loadBootstrap, selectedFeedId, selectedFolderId, showToast],
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    navigateToRoute(
      selectedReaderRoute(articleStateFilter, selectedFeedId, selectedFolderId, searchInput.trim()),
    );
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (managementRequest) return;
      if (event.key === "Escape") {
        setShortcutHelpOpen(false);
        setNavOpen(false);
        if (readerOpen) returnToArticleList();
        return;
      }
      if (isEditable(event.target) || !bootstrap?.settings.singleKeyShortcuts) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (sequence.current && Date.now() - sequence.current.startedAt < 1200) {
        sequence.current = null;
        const destinations: Record<string, () => void> = {
          u: () => selectScope(null, null, "unread"),
          s: () => selectScope(null, null, "starred"),
          a: () => selectScope(null, null, "all"),
          f: () => navigateTo("feeds"),
          r: () => navigateTo("rules"),
          ",": () => navigateTo("settings"),
        };
        if (destinations[key]) {
          event.preventDefault();
          destinations[key]();
        }
        return;
      }

      if (key === "g") {
        sequence.current = { startedAt: Date.now() };
        return;
      }
      if (event.shiftKey && key === "r") {
        event.preventDefault();
        void refresh(undefined, true);
        return;
      }

      const actions: Record<string, () => void> = {
        j: () => moveArticle(1),
        k: () => moveArticle(-1),
        u: () => {
          if (!activeArticle) return;
          const nextRead = !activeArticle.isRead;
          void changeArticleState(activeArticle, { isRead: nextRead });
          showToast(nextRead ? "Marked read" : "Marked unread");
        },
        s: () => {
          if (activeArticle) {
            void changeArticleState(activeArticle, { isStarred: !activeArticle.isStarred });
            showToast(activeArticle.isStarred ? "Star removed" : "Article starred");
          }
        },
        c: () => void copyArticleUrl(activeArticle),
        o: () => openArticleSource(activeArticle),
        w: () => {
          const articleVisible = view === "reader" && (readingMode === "expanded" || readerOpen);
          if (articleVisible && activeArticle) void toggleFullContent(activeArticle);
        },
        m: () => {
          const articleVisible = view === "reader" && (readingMode === "expanded" || readerOpen);
          if (articleVisible && activeArticle) toggleArticleSummary(activeArticle);
        },
        r: () => void refresh(),
        "[": () =>
          setArticleFontSize((current) => {
            const next = Math.max(ARTICLE_FONT_MIN, current - 1);
            showToast(`Global article text: ${next}px`);
            return next;
          }),
        "]": () =>
          setArticleFontSize((current) => {
            const next = Math.min(ARTICLE_FONT_MAX, current + 1);
            showToast(`Global article text: ${next}px`);
            return next;
          }),
        "1": () => {
          setReaderOpen(routedArticleId !== null);
          setExpandedKeyboardTargetId(null);
          setReadingMode("magazine");
        },
        "2": () => {
          setReaderOpen(routedArticleId !== null);
          setExpandedKeyboardTargetId(null);
          setReadingMode("expanded");
        },
        "?": () => setShortcutHelpOpen(true),
      };
      if (actions[key]) {
        event.preventDefault();
        actions[key]();
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    activeArticle,
    bootstrap?.settings.singleKeyShortcuts,
    changeArticleState,
    copyArticleUrl,
    openArticleSource,
    toggleFullContent,
    readerOpen,
    readingMode,
    moveArticle,
    managementRequest,
    navigateTo,
    refresh,
    returnToArticleList,
    routedArticleId,
    selectScope,
    showToast,
    toggleArticleSummary,
    view,
  ]);

  if (!bootstrap) {
    return bootstrapError ? (
      <StartupError message={bootstrapError} retry={() => void loadBootstrap()} />
    ) : (
      <AppSkeleton />
    );
  }

  const title = sourceLabel(bootstrap, selectedFeedId, selectedFolderId);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to articles
      </a>
      <Sidebar
        bootstrap={bootstrap}
        user={user}
        currentState={articleStateFilter}
        selectedFeedId={selectedFeedId}
        selectedFolderId={selectedFolderId}
        currentView={view}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onSelectState={(state) => selectScope(null, null, state)}
        onSelectScope={selectScope}
        onNavigate={navigateTo}
        onFeedAction={openFeedManagement}
        onFolderAction={openFolderManagement}
        onRefresh={() => void refresh()}
        onLogout={onLogout}
      />

      <main id="main-content" className="main-column" tabIndex={-1}>
        {view === "reader" ? (
          <>
            <ReaderToolbar
              title={title}
              count={articles.length}
              state={articleStateFilter}
              searchInput={searchInput}
              searchActive={Boolean(search)}
              mode={readingMode}
              refreshing={bootstrap.feeds.some((feed) => feed.refreshing)}
              markReadPending={markReadPending}
              navOpen={navOpen}
              readingArticle={readerOpen && readingMode === "magazine"}
              onToggleNav={() => setNavOpen((current) => !current)}
              onStateChange={(state) => {
                navigateToRoute(
                  selectedReaderRoute(state, selectedFeedId, selectedFolderId, search),
                );
              }}
              onSearchInput={setSearchInput}
              onSearch={submitSearch}
              onClearSearch={() => {
                navigateToRoute(
                  selectedReaderRoute(articleStateFilter, selectedFeedId, selectedFolderId, ""),
                );
              }}
              onModeChange={(mode) => {
                setReaderOpen(routedArticleId !== null);
                setExpandedKeyboardTargetId(null);
                setReadingMode(mode);
              }}
              onRefresh={() => void refresh()}
              onRefreshAll={() => void refresh(undefined, true)}
              onMarkRead={() => void markVisibleRead()}
              onMarkReadByAge={(days) => void markOlderArticlesRead(days)}
              onPreviousScope={() => moveScope(-1)}
              onNextScope={() => moveScope(1)}
              onHelp={() => setShortcutHelpOpen(true)}
            />

            <div
              className={`reading-workspace mode-${readingMode}${readerOpen ? " is-reading-article" : ""}`}
            >
              {articlesLoading ? (
                <ArticleListSkeleton mode={readingMode} />
              ) : articlesError ? (
                <InlineError
                  title={
                    routedArticleId === null
                      ? "Articles could not be loaded"
                      : "Article could not be loaded"
                  }
                  detail={articlesError}
                  retry={() =>
                    routedArticleId === null
                      ? void loadArticles()
                      : setRoutedArticleRetry((current) => current + 1)
                  }
                />
              ) : articles.length === 0 ? (
                <EmptyArticles
                  hasFeeds={bootstrap.feeds.length > 0}
                  search={search}
                  state={articleStateFilter}
                  onAddFeed={() => navigateTo("feeds")}
                  onShowAll={() =>
                    navigateToRoute(
                      selectedReaderRoute("all", selectedFeedId, selectedFolderId, search),
                    )
                  }
                  onClearSearch={() => {
                    navigateToRoute(
                      selectedReaderRoute(articleStateFilter, selectedFeedId, selectedFolderId, ""),
                    );
                  }}
                />
              ) : readingMode === "magazine" ? (
                <>
                  <ArticleList
                    key={`${articleStateFilter}:${selectedFeedId ?? "all"}:${selectedFolderId ?? "all"}:${search}`}
                    articles={articles}
                    activeId={activeArticleId}
                    markReadOnScroll={bootstrap.settings.markReadOnScroll}
                    hasMore={nextCursor !== null}
                    loadingMore={articlesLoadingMore}
                    onLoadMore={() => void loadOlderArticles()}
                    onOpen={openArticle}
                    onMarkPassedRead={markPassedArticlesRead}
                    onToggleRead={(article) =>
                      void changeArticleState(article, { isRead: !article.isRead })
                    }
                    onToggleStar={(article) =>
                      void changeArticleState(article, { isStarred: !article.isStarred })
                    }
                  />
                  <ReaderPane
                    article={activeArticle}
                    fullContentVisible={
                      activeArticle ? fullContentVisibleIds.has(activeArticle.id) : false
                    }
                    summaryState={
                      activeArticle
                        ? (articleSummaryStates.get(activeArticle.id) ??
                          EMPTY_ARTICLE_SUMMARY_STATE)
                        : EMPTY_ARTICLE_SUMMARY_STATE
                    }
                    onBack={returnToArticleList}
                    onPrevious={() => moveArticle(-1)}
                    onNext={() => moveArticle(1)}
                    onToggleRead={(article) =>
                      void changeArticleState(article, { isRead: !article.isRead })
                    }
                    onToggleStar={(article) =>
                      void changeArticleState(article, { isStarred: !article.isStarred })
                    }
                    onCopy={(article) => void copyArticleUrl(article)}
                    onOpenSource={openArticleSource}
                    onFeedAction={openFeedManagementById}
                    onToggleFullContent={(article) => void toggleFullContent(article)}
                    onToggleSummary={toggleArticleSummary}
                    onRegenerateSummary={regenerateArticleSummary}
                    onOpenAiSettings={() => navigateTo("settings")}
                    onFilterSelection={filterSelectedText}
                  />
                </>
              ) : (
                <ExpandedStream
                  articles={routedArticleId !== null && activeArticle ? [activeArticle] : articles}
                  activeId={activeArticleId}
                  topAlignedId={expandedKeyboardTargetId}
                  fullContentVisibleIds={fullContentVisibleIds}
                  summaryStates={articleSummaryStates}
                  markReadOnScroll={bootstrap.settings.markReadOnScroll}
                  hasMore={routedArticleId === null && nextCursor !== null}
                  loadingMore={articlesLoadingMore}
                  onLoadMore={() => void loadOlderArticles()}
                  onActivate={(article) => {
                    setExpandedKeyboardTargetId(null);
                    setActiveArticleId(article.id);
                  }}
                  onMarkPassedRead={markPassedArticlesRead}
                  onToggleRead={(article) =>
                    void changeArticleState(article, { isRead: !article.isRead })
                  }
                  onToggleStar={(article) =>
                    void changeArticleState(article, { isStarred: !article.isStarred })
                  }
                  onCopy={(article) => void copyArticleUrl(article)}
                  onOpenSource={openArticleSource}
                  onFeedAction={openFeedManagementById}
                  onToggleFullContent={(article) => void toggleFullContent(article)}
                  onToggleSummary={toggleArticleSummary}
                  onRegenerateSummary={regenerateArticleSummary}
                  onOpenAiSettings={() => navigateTo("settings")}
                  onFilterSelection={filterSelectedText}
                />
              )}
            </div>
          </>
        ) : view === "feeds" ? (
          <FeedsPage
            bootstrap={bootstrap}
            addFeedSourceUrl={addFeedSourceUrl}
            onMenu={() => setNavOpen(true)}
            onReload={loadBootstrap}
            onRefresh={(feedId) => void refresh(feedId)}
            onCloseAddFeedRoute={() => navigateToRoute({ kind: "feeds" }, "replace")}
            showToast={showToast}
          />
        ) : view === "rules" ? (
          <RulesPage
            bootstrap={bootstrap}
            rules={rules}
            loading={rulesLoading}
            error={rulesError}
            draft={ruleDraft}
            onMenu={() => setNavOpen(true)}
            onClearDraft={clearRuleDraft}
            onReturnToArticle={returnToContextArticle}
            onReload={async () => {
              await Promise.all([loadRules(), loadBootstrap()]);
            }}
            showToast={showToast}
          />
        ) : (
          <SettingsPage
            settings={bootstrap.settings}
            aiSettings={bootstrap.aiSettings}
            theme={theme}
            fontSize={articleFontSize}
            onMenu={() => setNavOpen(true)}
            onTheme={setTheme}
            onFontSize={setArticleFontSize}
            onSettings={(settings) =>
              setBootstrap((current) => (current ? { ...current, settings } : current))
            }
            onAiSettings={(aiSettings) =>
              setBootstrap((current) => (current ? { ...current, aiSettings } : current))
            }
            onReload={loadBootstrap}
            showToast={showToast}
          />
        )}
      </main>

      <ShortcutHelp
        open={shortcutHelpOpen}
        enabled={bootstrap.settings.singleKeyShortcuts}
        onClose={() => setShortcutHelpOpen(false)}
      />
      {managementRequest ? (
        <ContextManagementDialog
          key={
            "feedId" in managementRequest
              ? `${managementRequest.kind}:${managementRequest.feedId}`
              : "folderId" in managementRequest
                ? `${managementRequest.kind}:${managementRequest.folderId}`
                : `${managementRequest.kind}:${managementRequest.parentId}`
          }
          request={managementRequest}
          bootstrap={bootstrap}
          onClose={() => setManagementRequest(null)}
          onReload={reloadContextManagement}
          onRefresh={(feedId) => refresh(feedId)}
          onUnsubscribe={unsubscribeFromFeed}
          showToast={showToast}
        />
      ) : null}
      <button
        className={`nav-scrim${navOpen ? " is-open" : ""}`}
        type="button"
        aria-label="Close navigation"
        onClick={() => setNavOpen(false)}
      />
      <div className="toast" role="status" aria-live="polite" aria-atomic="true">
        {toast ? (
          <span data-state={toast.visible ? "open" : "closed"}>
            <Check aria-hidden="true" size={16} />
            {toast.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
