import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AiSettings,
  AppSettings,
  Article,
  BootstrapData,
  MarkReadAgeDays,
  ReadingMode,
} from "../shared/types";
import { ApiError, api, errorMessage } from "./api";
import type { AppRouteController } from "./app-route";
import { articleTranslationSourceKind, fullContentToggleAction } from "./article-content";
import type { ArticleQueueController } from "./article-queue";
import type { ReaderDataResource } from "./data-resource";
import {
  type ArticleSummaryViewState,
  type ArticleTranslationViewState,
  EMPTY_ARTICLE_SUMMARY_STATE,
  EMPTY_ARTICLE_TRANSLATION_STATE,
} from "./reader";
import {
  articleSettingsInvalidation,
  invalidateArticleSummaries,
  shouldAutoMarkRoutedArticleRead,
  updateBootstrapCounts,
} from "./reader-state";

interface ArticleActionsOptions {
  bootstrap: BootstrapData | null;
  setBootstrap: Dispatch<SetStateAction<BootstrapData | null>>;
  queue: ArticleQueueController;
  route: AppRouteController;
  dataResource: ReaderDataResource;
  readingMode: ReadingMode;
  showToast: (message: string) => void;
}

export function useArticleActions({
  bootstrap,
  setBootstrap,
  queue,
  route,
  dataResource,
  readingMode,
  showToast,
}: ArticleActionsOptions) {
  const [fullContentVisibleIds, setFullContentVisibleIds] = useState<Set<number>>(() => new Set());
  const [articleSummaryStates, setArticleSummaryStates] = useState<
    Map<number, ArticleSummaryViewState>
  >(() => new Map());
  const [articleTranslationStates, setArticleTranslationStates] = useState<
    Map<number, ArticleTranslationViewState>
  >(() => new Map());
  const [markReadPending, setMarkReadPending] = useState(false);
  const fullContentVisibleIdsRef = useRef(new Set<number>());
  const fullContentLoadingIds = useRef(new Set<number>());
  const summaryLoadingIds = useRef(new Set<number>());
  const translationLoadingIds = useRef(new Set<number>());
  const manuallyUnreadArticleIds = useRef(new Set<number>());
  const previousQueryRevision = useRef(queue.queryRevision);

  useEffect(() => {
    if (previousQueryRevision.current === queue.queryRevision) return;
    previousQueryRevision.current = queue.queryRevision;
    fullContentVisibleIdsRef.current = new Set();
    fullContentLoadingIds.current.clear();
    setFullContentVisibleIds(new Set());
    setArticleTranslationStates(new Map());
  }, [queue.queryRevision]);

  const loadBootstrap = dataResource.loadBootstrap;
  const loadArticles = queue.loadArticles;

  const loadFullArticle = useCallback(
    async (article: Article) => {
      if (queue.fullContentLoadedIds.current.has(article.id)) return;
      if (fullContentLoadingIds.current.has(article.id)) return;

      fullContentLoadingIds.current.add(article.id);
      try {
        const fullArticle = await api.article(article.id);
        if (!fullContentVisibleIdsRef.current.has(article.id)) queue.mergeArticle(fullArticle);
      } catch (caught) {
        showToast(`Could not load the full article: ${errorMessage(caught)}`);
      } finally {
        fullContentLoadingIds.current.delete(article.id);
      }
    },
    [queue, showToast],
  );

  useEffect(() => {
    if (
      (readingMode === "magazine" && route.routedArticleId === null) ||
      !queue.activeArticle ||
      !fullContentVisibleIds.has(queue.activeArticle.id) ||
      (queue.activeArticle.extractionStatus !== "pending" &&
        queue.activeArticle.extractionStatus !== "processing")
    ) {
      return;
    }
    const articleId = queue.activeArticle.id;
    const poll = window.setInterval(() => {
      void api
        .article(articleId)
        .then(queue.mergeArticle)
        .catch(() => {
          // A transient poll error should not replace readable feed content with an error screen.
        });
    }, 2000);
    return () => window.clearInterval(poll);
  }, [
    fullContentVisibleIds,
    queue.activeArticle,
    queue.mergeArticle,
    readingMode,
    route.routedArticleId,
  ]);

  const changeArticleState = useCallback(
    async (article: Article, change: { isRead?: boolean; isStarred?: boolean }) => {
      const nextRead = change.isRead ?? article.isRead;
      const nextStarred = change.isStarred ?? article.isStarred;
      const unreadDelta = nextRead === article.isRead ? 0 : nextRead ? -1 : 1;
      const starredDelta = nextStarred === article.isStarred ? 0 : nextStarred ? 1 : -1;
      const wasManuallyUnread = manuallyUnreadArticleIds.current.has(article.id);

      if (change.isRead === false) manuallyUnreadArticleIds.current.add(article.id);
      if (change.isRead === true) manuallyUnreadArticleIds.current.delete(article.id);

      queue.setArticles((current) =>
        current.map((item) =>
          item.id === article.id ? { ...item, isRead: nextRead, isStarred: nextStarred } : item,
        ),
      );
      setBootstrap((current) =>
        current ? updateBootstrapCounts(current, article, unreadDelta, starredDelta) : current,
      );

      try {
        await api.updateArticleState(article.id, change);
      } catch (caught) {
        if (wasManuallyUnread) manuallyUnreadArticleIds.current.add(article.id);
        else manuallyUnreadArticleIds.current.delete(article.id);
        queue.setArticles((current) =>
          current.map((item) =>
            item.id === article.id
              ? {
                  ...item,
                  isRead:
                    change.isRead !== undefined && item.isRead === nextRead
                      ? article.isRead
                      : item.isRead,
                  isStarred:
                    change.isStarred !== undefined && item.isStarred === nextStarred
                      ? article.isStarred
                      : item.isStarred,
                }
              : item,
          ),
        );
        setBootstrap((current) =>
          current ? updateBootstrapCounts(current, article, -unreadDelta, -starredDelta) : current,
        );
        showToast(`Could not update the article: ${errorMessage(caught)}`);
        await loadBootstrap();
        if (route.routedArticleId === null) await loadArticles();
      }
    },
    [loadArticles, loadBootstrap, queue, route.routedArticleId, setBootstrap, showToast],
  );

  const activateArticle = useCallback(
    (article: Article, keyboardTarget = false) => {
      queue.selectArticle(article.id, keyboardTarget);
      if (!article.isRead) void changeArticleState(article, { isRead: true });
      void loadFullArticle(article);
    },
    [changeArticleState, loadFullArticle, queue],
  );

  const openArticle = useCallback(
    (article: Article, openReader = true, historyMode: "push" | "replace" = "push") => {
      activateArticle(article, !openReader);
      if (openReader) {
        route.navigate(
          { kind: "article", articleId: article.id },
          historyMode,
          queue.articles.findIndex((item) => item.id === article.id),
        );
      }
    },
    [activateArticle, queue.articles, route],
  );

  useEffect(() => {
    if (route.routedArticleId !== null && queue.activeArticle?.id === route.routedArticleId) {
      if (
        shouldAutoMarkRoutedArticleRead(
          queue.activeArticle,
          route.routedArticleId,
          manuallyUnreadArticleIds.current,
        )
      ) {
        void changeArticleState(queue.activeArticle, { isRead: true });
      }
      void loadFullArticle(queue.activeArticle);
    }
  }, [changeArticleState, loadFullArticle, queue.activeArticle, route.routedArticleId]);

  const moveArticle = useCallback(
    async (direction: 1 | -1): Promise<boolean> => {
      if (queue.articles.length === 0) return false;
      const openReader = readingMode === "magazine" || route.routedArticleId !== null;
      if (openReader && route.routedArticleId === null && queue.activeArticle) {
        openArticle(queue.activeArticle, true);
        return true;
      }
      const currentIndex = queue.articles.findIndex(
        (article) => article.id === queue.activeArticleId,
      );
      if (
        direction === 1 &&
        currentIndex === queue.articles.length - 1 &&
        queue.nextCursor &&
        !queue.loadingMore
      ) {
        const appended = await queue.loadOlderArticles();
        const next = appended[0];
        if (!next) return false;
        openArticle(next, openReader, route.routedArticleId !== null ? "replace" : "push");
        return true;
      }
      const nextIndex = Math.min(
        queue.articles.length - 1,
        Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + direction),
      );
      const next = queue.articles[nextIndex];
      if (next && next.id !== queue.activeArticleId) {
        openArticle(next, openReader, route.routedArticleId !== null ? "replace" : "push");
        return true;
      }
      return false;
    },
    [openArticle, queue, readingMode, route.routedArticleId],
  );

  const copyArticleUrl = useCallback(
    async (article: Article | null) => {
      if (!article?.url) {
        showToast("This article has no source link.");
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
        showToast("Article link copied");
      } catch {
        showToast("Could not copy the article link. Copy it from the source page instead.");
      }
    },
    [showToast],
  );

  const openArticleSource = useCallback(
    (article: Article | null) => {
      if (!article?.url) {
        showToast("This article has no source link.");
        return;
      }
      window.open(article.url, "_blank", "noopener,noreferrer");
    },
    [showToast],
  );

  const patchArticleTranslationState = useCallback(
    (articleId: number, change: Partial<ArticleTranslationViewState>) => {
      setArticleTranslationStates((current) => {
        const next = new Map(current);
        next.set(articleId, {
          ...(current.get(articleId) ?? EMPTY_ARTICLE_TRANSLATION_STATE),
          ...change,
        });
        return next;
      });
    },
    [],
  );

  const toggleFullContent = useCallback(
    async (article: Article) => {
      if (!article.url || article.media) return;
      const action = fullContentToggleAction(
        article,
        fullContentVisibleIdsRef.current.has(article.id),
      );
      if (action === "wait") return;
      patchArticleTranslationState(article.id, { visible: false });
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
        queue.mergeArticle(await api.loadFullContent(article.id));
      } catch (caught) {
        fullContentVisibleIdsRef.current.delete(article.id);
        setFullContentVisibleIds((current) => {
          const next = new Set(current);
          next.delete(article.id);
          return next;
        });
        showToast(`Could not load the full article: ${errorMessage(caught)}`);
        void loadFullArticle(article);
      }
    },
    [loadFullArticle, patchArticleTranslationState, queue, showToast],
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
    async (article: Article, promptId: string | null, regenerate: boolean) => {
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
          promptId,
        });
        return;
      }

      summaryLoadingIds.current.add(article.id);
      patchArticleSummaryState(article.id, {
        visible: true,
        loading: true,
        error: null,
        configurationMissing: false,
        promptId,
      });
      try {
        const summary = await api.summarizeArticle(article.id, promptId, regenerate);
        queue.setArticles((current) =>
          current.map((item) => (item.id === article.id ? { ...item, aiSummary: summary } : item)),
        );
        patchArticleSummaryState(article.id, { loading: false });
      } catch (caught) {
        patchArticleSummaryState(article.id, { loading: false, error: errorMessage(caught) });
      } finally {
        summaryLoadingIds.current.delete(article.id);
      }
    },
    [bootstrap?.aiSettings, patchArticleSummaryState, queue],
  );

  const toggleArticleSummary = useCallback(
    (article: Article) => {
      const state = articleSummaryStates.get(article.id) ?? EMPTY_ARTICLE_SUMMARY_STATE;
      if (state.loading) return;
      if (state.visible && article.aiSummary?.promptId === null) {
        patchArticleSummaryState(article.id, { visible: false });
        return;
      }
      if (article.aiSummary?.promptId === null) {
        patchArticleSummaryState(article.id, {
          visible: true,
          error: null,
          configurationMissing: false,
          promptId: null,
        });
        return;
      }
      void generateArticleSummary(article, null, false);
    },
    [articleSummaryStates, generateArticleSummary, patchArticleSummaryState],
  );

  const runArticleSummaryPrompt = useCallback(
    (article: Article, promptId: string | null) => {
      const state = articleSummaryStates.get(article.id) ?? EMPTY_ARTICLE_SUMMARY_STATE;
      if (state.loading) return;
      if (article.aiSummary?.promptId === promptId) {
        patchArticleSummaryState(article.id, {
          visible: true,
          error: null,
          configurationMissing: false,
          promptId,
        });
        return;
      }
      void generateArticleSummary(article, promptId, false);
    },
    [articleSummaryStates, generateArticleSummary, patchArticleSummaryState],
  );

  const regenerateArticleSummary = useCallback(
    (article: Article) => {
      const state = articleSummaryStates.get(article.id);
      const promptId = state ? state.promptId : (article.aiSummary?.promptId ?? null);
      void generateArticleSummary(article, promptId, true);
    },
    [articleSummaryStates, generateArticleSummary],
  );

  const generateArticleTranslation = useCallback(
    async (article: Article) => {
      if (translationLoadingIds.current.has(article.id)) return;
      const sourceKind = articleTranslationSourceKind(
        article,
        fullContentVisibleIdsRef.current.has(article.id),
      );
      translationLoadingIds.current.add(article.id);
      patchArticleTranslationState(article.id, {
        visible: false,
        loading: true,
        error: null,
        configurationMissing: false,
      });
      try {
        const translation = await api.translateArticle(article.id, sourceKind);
        const currentArticle = queue.articlesRef.current.find((item) => item.id === article.id);
        const currentSourceKind = currentArticle
          ? articleTranslationSourceKind(
              currentArticle,
              fullContentVisibleIdsRef.current.has(article.id),
            )
          : sourceKind;
        patchArticleTranslationState(article.id, {
          visible:
            currentSourceKind === translation.sourceKind &&
            translation.language === bootstrap?.settings.translationLanguage,
          loading: false,
          translation,
        });
      } catch (caught) {
        const configurationMissing =
          caught instanceof ApiError &&
          ["AI_NOT_CONFIGURED", "AI_KEY_MISSING", "AI_CREDENTIAL_STORAGE_UNAVAILABLE"].includes(
            caught.code ?? "",
          );
        patchArticleTranslationState(article.id, {
          visible: false,
          loading: false,
          error: configurationMissing ? null : errorMessage(caught),
          configurationMissing,
        });
      } finally {
        translationLoadingIds.current.delete(article.id);
      }
    },
    [bootstrap?.settings.translationLanguage, patchArticleTranslationState, queue.articlesRef],
  );

  const toggleArticleTranslation = useCallback(
    (article: Article) => {
      const state = articleTranslationStates.get(article.id) ?? EMPTY_ARTICLE_TRANSLATION_STATE;
      if (state.loading) return;
      if (state.visible) {
        patchArticleTranslationState(article.id, { visible: false });
        return;
      }
      const sourceKind = articleTranslationSourceKind(
        article,
        fullContentVisibleIdsRef.current.has(article.id),
      );
      const { translation } = state;
      if (
        translation !== null &&
        translation.language === bootstrap?.settings.translationLanguage &&
        translation.sourceKind === sourceKind
      ) {
        patchArticleTranslationState(article.id, {
          visible: true,
          error: null,
          configurationMissing: false,
        });
        return;
      }
      void generateArticleTranslation(article);
    },
    [
      articleTranslationStates,
      bootstrap?.settings.translationLanguage,
      generateArticleTranslation,
      patchArticleTranslationState,
    ],
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
      queue.setArticles((current) =>
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
      } catch (caught) {
        for (const id of protectedIds) manuallyUnreadArticleIds.current.add(id);
        showToast(`Could not mark articles as read: ${errorMessage(caught)}`);
        await Promise.all([loadBootstrap(), loadArticles()]);
        return false;
      }
    },
    [loadArticles, loadBootstrap, queue, setBootstrap, showToast],
  );

  const markPassedArticlesRead = useCallback(
    (candidates: Article[]) =>
      markArticleBatchRead(
        candidates.filter((article) => !manuallyUnreadArticleIds.current.has(article.id)),
      ),
    [markArticleBatchRead],
  );

  const markVisibleRead = useCallback(async () => {
    const unreadArticles = queue.articles.filter((article) => !article.isRead);
    if (unreadArticles.length === 0) {
      showToast("This view has no unread articles.");
      return;
    }
    if (await markArticleBatchRead(unreadArticles)) {
      showToast(
        `Marked ${unreadArticles.length} ${unreadArticles.length === 1 ? "article" : "articles"} as read`,
      );
    }
  }, [markArticleBatchRead, queue.articles, showToast]);

  const markOlderArticlesRead = useCallback(
    async (days: MarkReadAgeDays) => {
      setMarkReadPending(true);
      try {
        const readerRoute = route.readerRoute;
        const result = await api.markRead({
          olderThanDays: days,
          ...(readerRoute.scope === "feed" ? { feedId: readerRoute.scopeId ?? undefined } : {}),
          ...(readerRoute.scope === "folder" ? { folderId: readerRoute.scopeId ?? undefined } : {}),
        });
        await Promise.all([loadBootstrap(), loadArticles()]);
        showToast(
          result.updated === 0
            ? "No unread articles are older than that."
            : `Marked ${result.updated} ${result.updated === 1 ? "article" : "articles"} as read`,
        );
      } catch (caught) {
        showToast(`Could not mark older articles as read: ${errorMessage(caught)}`);
      } finally {
        setMarkReadPending(false);
      }
    },
    [loadArticles, loadBootstrap, route.readerRoute, showToast],
  );

  const applySettings = useCallback(
    (settings: AppSettings) => {
      if (!bootstrap) return;
      const invalidation = articleSettingsInvalidation(bootstrap.settings, settings);
      if (invalidation.resetTranslationState) setArticleTranslationStates(new Map());
      if (invalidation.invalidatedSummaryPromptIds.size > 0) {
        setArticleSummaryStates(new Map());
        queue.setArticles((current) =>
          invalidateArticleSummaries(current, invalidation.invalidatedSummaryPromptIds),
        );
      }
      setBootstrap((current) => (current ? { ...current, settings } : current));
    },
    [bootstrap, queue, setBootstrap],
  );

  const applyAiSettings = useCallback(
    (aiSettings: AiSettings) => {
      setBootstrap((current) => (current ? { ...current, aiSettings } : current));
    },
    [setBootstrap],
  );

  return {
    fullContentVisibleIds,
    articleSummaryStates,
    articleTranslationStates,
    markReadPending,
    changeArticleState,
    activateArticle,
    openArticle,
    moveArticle,
    copyArticleUrl,
    openArticleSource,
    toggleFullContent,
    toggleArticleSummary,
    runArticleSummaryPrompt,
    regenerateArticleSummary,
    toggleArticleTranslation,
    markPassedArticlesRead,
    markVisibleRead,
    markOlderArticlesRead,
    applySettings,
    applyAiSettings,
  };
}
