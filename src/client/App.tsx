import { Check } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Article,
  ArticleState,
  BootstrapData,
  Folder as FolderType,
  ReadingMode,
  Rule,
} from "../shared/types";
import { api, errorMessage } from "./api";
import { FeedsPage, RulesPage, SettingsPage, ShortcutHelp } from "./management";
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
    storedValue<ReadingMode>("echovale-reading-mode", "magazine"),
  );
  const [theme, setTheme] = useState<Theme>(() => storedValue<Theme>("echovale-theme", "dark"));
  const [articleFontSize, setArticleFontSize] = useState(() =>
    Math.min(
      ARTICLE_FONT_MAX,
      Math.max(ARTICLE_FONT_MIN, storedNumber("echovale-article-font-size", ARTICLE_FONT_DEFAULT)),
    ),
  );
  const [view, setView] = useState<AppView>("reader");
  const [rules, setRules] = useState<Rule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const sequence = useRef<{ startedAt: number } | null>(null);
  const bootstrapReady = bootstrap !== null;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

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
    setArticlesLoading(true);
    setArticlesError(null);
    try {
      const page = await api.articles({
        state: articleStateFilter,
        ...(selectedFeedId !== null ? { feedId: selectedFeedId } : {}),
        ...(selectedFolderId !== null ? { folderId: selectedFolderId } : {}),
        ...(search ? { search } : {}),
        limit: 200,
      });
      setArticles(page.articles);
      setNextCursor(page.nextCursor);
      setActiveArticleId((current) => {
        if (current !== null && page.articles.some((article) => article.id === current))
          return current;
        return page.articles[0]?.id ?? null;
      });
    } catch (error) {
      setArticlesError(errorMessage(error));
    } finally {
      setArticlesLoading(false);
    }
  }, [articleStateFilter, bootstrapReady, search, selectedFeedId, selectedFolderId]);

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
        limit: 200,
        cursor: nextCursor,
      });
      const existingIds = new Set(articles.map((article) => article.id));
      const appended = page.articles.filter((article) => !existingIds.has(article.id));
      setArticles((current) => {
        const ids = new Set(current.map((article) => article.id));
        return [...current, ...page.articles.filter((article) => !ids.has(article.id))];
      });
      setNextCursor(page.nextCursor);
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
    window.localStorage.setItem("echovale-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--article-font-size", `${articleFontSize}px`);
    window.localStorage.setItem("echovale-article-font-size", String(articleFontSize));
  }, [articleFontSize]);

  useEffect(() => {
    window.localStorage.setItem("echovale-reading-mode", readingMode);
  }, [readingMode]);

  const activeArticle = useMemo(
    () => articles.find((article) => article.id === activeArticleId) ?? null,
    [activeArticleId, articles],
  );

  useEffect(() => {
    if (
      !activeArticle ||
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
          setArticles((current) =>
            current.map((article) => (article.id === updated.id ? updated : article)),
          );
        })
        .catch(() => {
          // A transient poll error should not replace readable feed content with an error screen.
        });
    }, 2000);
    return () => window.clearInterval(poll);
  }, [activeArticle]);

  const changeArticleState = useCallback(
    async (article: Article, change: { isRead?: boolean; isStarred?: boolean }) => {
      const nextRead = change.isRead ?? article.isRead;
      const nextStarred = change.isStarred ?? article.isStarred;
      const unreadDelta = nextRead === article.isRead ? 0 : nextRead ? -1 : 1;
      const starredDelta = nextStarred === article.isStarred ? 0 : nextStarred ? 1 : -1;

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
        showToast(`Could not update article: ${errorMessage(error)}`);
        await Promise.all([loadBootstrap(), loadArticles()]);
      }
    },
    [loadArticles, loadBootstrap, showToast],
  );

  const openArticle = useCallback(
    (article: Article, openMobile = true) => {
      setActiveArticleId(article.id);
      if (openMobile) setMobileReaderOpen(true);
      if (!article.isRead) void changeArticleState(article, { isRead: true });
    },
    [changeArticleState],
  );

  const moveArticle = useCallback(
    (direction: 1 | -1) => {
      if (articles.length === 0) return;
      const currentIndex = articles.findIndex((article) => article.id === activeArticleId);
      if (
        direction === 1 &&
        currentIndex === articles.length - 1 &&
        nextCursor &&
        !articlesLoadingMore
      ) {
        void loadOlderArticles().then((appended) => {
          if (appended[0]) openArticle(appended[0], true);
        });
        return;
      }
      const nextIndex = Math.min(
        articles.length - 1,
        Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + direction),
      );
      const next = articles[nextIndex];
      if (next) openArticle(next, true);
    },
    [activeArticleId, articles, articlesLoadingMore, loadOlderArticles, nextCursor, openArticle],
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

  const retryExtraction = useCallback(
    async (article: Article) => {
      try {
        const updated = await api.retryExtraction(article.id);
        setArticles((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        showToast("Full-text extraction restarted");
      } catch (error) {
        showToast(`Could not retry extraction: ${errorMessage(error)}`);
      }
    },
    [showToast],
  );

  const selectScope = useCallback((feedId: number | null, folderId: number | null) => {
    setSelectedFeedId(feedId);
    setSelectedFolderId(folderId);
    setView("reader");
    setNavOpen(false);
    setMobileReaderOpen(false);
  }, []);

  const navigateTo = useCallback((nextView: AppView) => {
    setView(nextView);
    setNavOpen(false);
  }, []);

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

  const markVisibleRead = useCallback(async () => {
    const unreadArticles = articles.filter((article) => !article.isRead);
    if (unreadArticles.length === 0) {
      showToast("No unread articles in this view");
      return;
    }

    setArticles((current) => current.map((article) => ({ ...article, isRead: true })));
    setBootstrap((current) => {
      if (!current) return current;
      return unreadArticles.reduce(
        (next, article) => updateBootstrapCounts(next, article, -1, 0),
        current,
      );
    });
    try {
      await api.markRead({ articleIds: unreadArticles.map((article) => article.id) });
      showToast(
        `Marked ${unreadArticles.length} ${unreadArticles.length === 1 ? "article" : "articles"} read`,
      );
    } catch (error) {
      showToast(`Could not mark articles read: ${errorMessage(error)}`);
      await Promise.all([loadBootstrap(), loadArticles()]);
    }
  }, [articles, loadArticles, loadBootstrap, showToast]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchInput.trim());
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShortcutHelpOpen(false);
        setNavOpen(false);
        if (mobileReaderOpen) setMobileReaderOpen(false);
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
        r: () => void refresh(),
        "[": () =>
          setArticleFontSize((current) => {
            const next = Math.max(ARTICLE_FONT_MIN, current - 1);
            showToast(`Article text ${next} pixels`);
            return next;
          }),
        "]": () =>
          setArticleFontSize((current) => {
            const next = Math.min(ARTICLE_FONT_MAX, current + 1);
            showToast(`Article text ${next} pixels`);
            return next;
          }),
        "1": () => setReadingMode("magazine"),
        "2": () => setReadingMode("expanded"),
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
    mobileReaderOpen,
    moveArticle,
    navigateTo,
    refresh,
    selectScope,
    showToast,
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
              navOpen={navOpen}
              onToggleNav={() => setNavOpen((current) => !current)}
              onStateChange={setArticleStateFilter}
              onSearchInput={setSearchInput}
              onSearch={submitSearch}
              onClearSearch={() => {
                setSearchInput("");
                setSearch("");
              }}
              onModeChange={setReadingMode}
              onRefresh={() => void refresh()}
              onRefreshAll={() => void refresh(undefined, true)}
              onMarkRead={() => void markVisibleRead()}
              onPreviousScope={() => moveScope(-1)}
              onNextScope={() => moveScope(1)}
              onHelp={() => setShortcutHelpOpen(true)}
            />

            <div
              className={`reading-workspace mode-${readingMode}${mobileReaderOpen ? " mobile-reading" : ""}`}
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
                    setSearchInput("");
                    setSearch("");
                  }}
                />
              ) : readingMode === "magazine" ? (
                <>
                  <ArticleList
                    articles={articles}
                    activeId={activeArticleId}
                    hasMore={nextCursor !== null}
                    loadingMore={articlesLoadingMore}
                    onLoadMore={() => void loadOlderArticles()}
                    onOpen={openArticle}
                    onToggleStar={(article) =>
                      void changeArticleState(article, { isStarred: !article.isStarred })
                    }
                  />
                  <ReaderPane
                    article={activeArticle}
                    fontSize={articleFontSize}
                    onBack={() => setMobileReaderOpen(false)}
                    onPrevious={() => moveArticle(-1)}
                    onNext={() => moveArticle(1)}
                    onMarkUnread={(article) =>
                      article.isRead && void changeArticleState(article, { isRead: false })
                    }
                    onToggleStar={(article) =>
                      void changeArticleState(article, { isStarred: !article.isStarred })
                    }
                    onCopy={(article) => void copyArticleUrl(article)}
                    onRetryExtraction={(article) => void retryExtraction(article)}
                    onFontDecrease={() =>
                      setArticleFontSize((current) => Math.max(ARTICLE_FONT_MIN, current - 1))
                    }
                    onFontIncrease={() =>
                      setArticleFontSize((current) => Math.min(ARTICLE_FONT_MAX, current + 1))
                    }
                  />
                </>
              ) : (
                <ExpandedStream
                  articles={articles}
                  activeId={activeArticleId}
                  hasMore={nextCursor !== null}
                  loadingMore={articlesLoadingMore}
                  onLoadMore={() => void loadOlderArticles()}
                  fontSize={articleFontSize}
                  onActivate={openArticle}
                  onMarkUnread={(article) =>
                    article.isRead && void changeArticleState(article, { isRead: false })
                  }
                  onToggleStar={(article) =>
                    void changeArticleState(article, { isStarred: !article.isStarred })
                  }
                  onCopy={(article) => void copyArticleUrl(article)}
                  onRetryExtraction={(article) => void retryExtraction(article)}
                  onFontDecrease={() =>
                    setArticleFontSize((current) => Math.max(ARTICLE_FONT_MIN, current - 1))
                  }
                  onFontIncrease={() =>
                    setArticleFontSize((current) => Math.min(ARTICLE_FONT_MAX, current + 1))
                  }
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
            onMenu={() => setNavOpen(true)}
            onReload={async () => {
              await Promise.all([loadRules(), loadBootstrap(), loadArticles()]);
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
          <span>
            <Check aria-hidden="true" size={16} />
            {toast}
          </span>
        ) : null}
      </div>
    </div>
  );
}
