import { Check } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Article,
  ArticleState,
  BootstrapData,
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
import { FeedsPage, type RuleFormDraft, RulesPage, SettingsPage, ShortcutHelp } from "./management";
import { type AppView, ReaderToolbar, Sidebar } from "./navigation";
import {
  AppSkeleton,
  ArticleList,
  ArticleListSkeleton,
  EmptyArticles,
  ExpandedStream,
  InlineError,
  ReaderPane,
  StartupError,
} from "./reader";

type Theme = "dark" | "light";

const ARTICLE_FONT_MIN = 15;
const ARTICLE_FONT_MAX = 23;
const ARTICLE_FONT_DEFAULT = 18;
const TOAST_EXIT_MS = 140;
const FILTER_RULE_NAME_TEXT_LIMIT = 72;

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
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [articlesLoadingMore, setArticlesLoadingMore] = useState(false);
  const [articlesError, setArticlesError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeArticleId, setActiveArticleId] = useState<number | null>(null);
  const [articleStateFilter, setArticleStateFilter] = useState<ArticleState>("unread");
  const [selectedFeedId, setSelectedFeedId] = useState<number | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
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
  const [view, setView] = useState<AppView>("reader");
  const [rules, setRules] = useState<Rule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleFormDraft | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [expandedKeyboardTargetId, setExpandedKeyboardTargetId] = useState<number | null>(null);
  const [fullContentVisibleIds, setFullContentVisibleIds] = useState<Set<number>>(() => new Set());
  const [markReadPending, setMarkReadPending] = useState(false);
  const [toast, setToast] = useState<{ message: string; visible: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const toastExitTimer = useRef<number | null>(null);
  const sequence = useRef<{ startedAt: number } | null>(null);
  const ruleDraftId = useRef(0);
  const contextArticleReturn = useRef<ContextArticleReturn | null>(null);
  const fullContentVisibleIdsRef = useRef(new Set<number>());
  const fullContentLoadedIds = useRef(new Set<number>());
  const fullContentLoadingIds = useRef(new Set<number>());
  const manuallyUnreadArticleIds = useRef(new Set<number>());
  const bootstrapReady = bootstrap !== null;

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (toastExitTimer.current) window.clearTimeout(toastExitTimer.current);
    setToast({ message, visible: true });
    toastTimer.current = window.setTimeout(() => {
      setToast((current) => (current ? { ...current, visible: false } : current));
      toastExitTimer.current = window.setTimeout(() => setToast(null), TOAST_EXIT_MS);
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
    if (!bootstrapReady) return;
    const returnTarget = contextArticleReturn.current;
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
      const nextArticles = articlesWithContextReturn(page.articles, returnTarget);
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
      if (contextArticleReturn.current === returnTarget) contextArticleReturn.current = null;
    } catch (error) {
      setArticlesError(errorMessage(error));
    } finally {
      setArticlesLoading(false);
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
    if (!bootstrapReady || !nextCursor || articlesLoadingMore) return [];
    setArticlesLoadingMore(true);
    try {
      const page = await api.articles({
        state: articleStateFilter,
        ...(selectedFeedId !== null ? { feedId: selectedFeedId } : {}),
        ...(selectedFolderId !== null ? { folderId: selectedFolderId } : {}),
        ...(search ? { search } : {}),
        limit: readingMode === "expanded" ? 20 : 100,
        includeContent: readingMode === "expanded",
        cursor: nextCursor,
      });
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
      showToast(`Could not load older articles: ${errorMessage(error)}`);
      return [];
    } finally {
      setArticlesLoadingMore(false);
    }
  }, [
    articleStateFilter,
    articles,
    articlesLoadingMore,
    bootstrapReady,
    nextCursor,
    readingMode,
    search,
    selectedFeedId,
    selectedFolderId,
    showToast,
  ]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (view === "reader") void loadArticles();
  }, [loadArticles, view]);

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
        await Promise.all([loadBootstrap(), loadArticles()]);
      }
    },
    [loadArticles, loadBootstrap, showToast],
  );

  const openArticle = useCallback(
    (article: Article, openReader = true) => {
      setActiveArticleId(article.id);
      if (openReader) setReaderOpen(true);
      if (!article.isRead) void changeArticleState(article, { isRead: true });
      void loadFullArticle(article);
    },
    [changeArticleState, loadFullArticle],
  );

  const moveArticle = useCallback(
    (direction: 1 | -1) => {
      if (articles.length === 0) return;
      const openReader = readingMode === "magazine";
      if (openReader && !readerOpen && activeArticle) {
        openArticle(activeArticle, true);
        return;
      }
      const currentIndex = articles.findIndex((article) => article.id === activeArticleId);
      if (
        direction === 1 &&
        currentIndex === articles.length - 1 &&
        nextCursor &&
        !articlesLoadingMore
      ) {
        void loadOlderArticles().then((appended) => {
          const next = appended[0];
          if (!next) return;
          if (!openReader) setExpandedKeyboardTargetId(next.id);
          openArticle(next, openReader);
        });
        return;
      }
      const nextIndex = Math.min(
        articles.length - 1,
        Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + direction),
      );
      const next = articles[nextIndex];
      if (next) {
        if (!openReader && next.id !== activeArticleId) setExpandedKeyboardTargetId(next.id);
        openArticle(next, openReader);
      }
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

  const selectScope = useCallback((feedId: number | null, folderId: number | null) => {
    setSelectedFeedId(feedId);
    setSelectedFolderId(folderId);
    setView("reader");
    setNavOpen(false);
    setReaderOpen(false);
  }, []);

  const navigateTo = useCallback((nextView: AppView) => {
    setView(nextView);
    setNavOpen(false);
  }, []);

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
      navigateTo("rules");
    },
    [articles, navigateTo],
  );

  const clearRuleDraft = useCallback(() => setRuleDraft(null), []);

  const returnToContextArticle = useCallback(
    (draft: RuleFormDraft) => {
      contextArticleReturn.current = { article: draft.article, index: draft.articleIndex };
      setActiveArticleId(draft.article.id);
      setReaderOpen(readingMode === "magazine");
      setExpandedKeyboardTargetId(readingMode === "expanded" ? draft.article.id : null);
      navigateTo("reader");
    },
    [navigateTo, readingMode],
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
        await loadArticles();
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
    setReaderOpen(false);
    setSearch(searchInput.trim());
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShortcutHelpOpen(false);
        setNavOpen(false);
        if (readerOpen) setReaderOpen(false);
        return;
      }
      if (isEditable(event.target) || !bootstrap?.settings.singleKeyShortcuts) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (sequence.current && Date.now() - sequence.current.startedAt < 1200) {
        sequence.current = null;
        const destinations: Record<string, () => void> = {
          u: () => {
            setArticleStateFilter("unread");
            selectScope(null, null);
          },
          s: () => {
            setArticleStateFilter("starred");
            selectScope(null, null);
          },
          a: () => {
            setArticleStateFilter("all");
            selectScope(null, null);
          },
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
          if (activeArticle?.isRead) {
            void changeArticleState(activeArticle, { isRead: false });
            showToast("Marked unread");
          } else if (activeArticle) {
            showToast("Article is already unread");
          }
        },
        s: () => {
          if (activeArticle) {
            void changeArticleState(activeArticle, { isStarred: !activeArticle.isStarred });
            showToast(activeArticle.isStarred ? "Star removed" : "Article starred");
          }
        },
        c: () => void copyArticleUrl(activeArticle),
        w: () => {
          const articleVisible = view === "reader" && (readingMode === "expanded" || readerOpen);
          if (articleVisible && activeArticle) void toggleFullContent(activeArticle);
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
          setReaderOpen(false);
          setExpandedKeyboardTargetId(null);
          setReadingMode("magazine");
        },
        "2": () => {
          setReaderOpen(false);
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
    toggleFullContent,
    readerOpen,
    readingMode,
    moveArticle,
    navigateTo,
    refresh,
    selectScope,
    showToast,
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
        onSelectState={(state) => {
          setArticleStateFilter(state);
          selectScope(null, null);
        }}
        onSelectScope={selectScope}
        onNavigate={navigateTo}
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
                setReaderOpen(false);
                setArticleStateFilter(state);
              }}
              onSearchInput={setSearchInput}
              onSearch={submitSearch}
              onClearSearch={() => {
                setReaderOpen(false);
                setSearchInput("");
                setSearch("");
              }}
              onModeChange={(mode) => {
                setReaderOpen(false);
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
                  title="Articles could not be loaded"
                  detail={articlesError}
                  retry={() => void loadArticles()}
                />
              ) : articles.length === 0 ? (
                <EmptyArticles
                  hasFeeds={bootstrap.feeds.length > 0}
                  search={search}
                  state={articleStateFilter}
                  onAddFeed={() => navigateTo("feeds")}
                  onShowAll={() => setArticleStateFilter("all")}
                  onClearSearch={() => {
                    setReaderOpen(false);
                    setSearchInput("");
                    setSearch("");
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
                    onBack={() => setReaderOpen(false)}
                    onPrevious={() => moveArticle(-1)}
                    onNext={() => moveArticle(1)}
                    onMarkUnread={(article) =>
                      article.isRead && void changeArticleState(article, { isRead: false })
                    }
                    onToggleStar={(article) =>
                      void changeArticleState(article, { isStarred: !article.isStarred })
                    }
                    onCopy={(article) => void copyArticleUrl(article)}
                    onToggleFullContent={(article) => void toggleFullContent(article)}
                    onFilterSelection={filterSelectedText}
                  />
                </>
              ) : (
                <ExpandedStream
                  articles={articles}
                  activeId={activeArticleId}
                  topAlignedId={expandedKeyboardTargetId}
                  fullContentVisibleIds={fullContentVisibleIds}
                  markReadOnScroll={bootstrap.settings.markReadOnScroll}
                  hasMore={nextCursor !== null}
                  loadingMore={articlesLoadingMore}
                  onLoadMore={() => void loadOlderArticles()}
                  onActivate={(article) => {
                    setExpandedKeyboardTargetId(null);
                    setActiveArticleId(article.id);
                  }}
                  onMarkPassedRead={markPassedArticlesRead}
                  onMarkUnread={(article) =>
                    article.isRead && void changeArticleState(article, { isRead: false })
                  }
                  onToggleStar={(article) =>
                    void changeArticleState(article, { isStarred: !article.isStarred })
                  }
                  onCopy={(article) => void copyArticleUrl(article)}
                  onToggleFullContent={(article) => void toggleFullContent(article)}
                  onFilterSelection={filterSelectedText}
                />
              )}
            </div>
          </>
        ) : view === "feeds" ? (
          <FeedsPage
            bootstrap={bootstrap}
            onMenu={() => setNavOpen(true)}
            onReload={loadBootstrap}
            onRefresh={(feedId) => void refresh(feedId)}
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
            theme={theme}
            fontSize={articleFontSize}
            onMenu={() => setNavOpen(true)}
            onTheme={setTheme}
            onFontSize={setArticleFontSize}
            onSettings={(settings) =>
              setBootstrap((current) => (current ? { ...current, settings } : current))
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
