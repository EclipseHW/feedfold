import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Article, ReadingMode } from "../shared/types";
import { api, errorMessage } from "./api";
import type { AppRouteController } from "./app-route";
import { articlesWithContextReturn, type ContextArticleReturn } from "./contextual-filter";
import type { ReaderDataResource } from "./data-resource";
import { articleQueryForReaderRoute, fullContentIdsAfterReload } from "./reader-state";
import { appRoutePath, type ReaderRoute } from "./routes";

export interface ArticleQueueController {
  articles: Article[];
  setArticles: Dispatch<SetStateAction<Article[]>>;
  articlesRef: React.RefObject<Article[]>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  activeArticleId: number | null;
  activeArticle: Article | null;
  activeArticleIndex: number;
  expandedKeyboardTargetId: number | null;
  queryRevision: number;
  fullContentLoadedIds: React.RefObject<Set<number>>;
  loadArticles: (mode?: "query" | "mutation") => Promise<void>;
  reloadQuery: (signal: AbortSignal) => Promise<void>;
  reloadAfterMutation: (signal: AbortSignal) => Promise<void>;
  loadOlderArticles: () => Promise<Article[]>;
  selectArticle: (articleId: number, keyboardTarget?: boolean) => void;
  clearKeyboardTarget: () => void;
  mergeArticle: (article: Article) => void;
  preserveContextArticle: (
    article: Article,
    articleIndex: number,
    returnRoute: ReaderRoute,
  ) => void;
  invalidate: () => void;
  retryRoutedArticle: () => void;
}

interface ArticleQueueOptions {
  route: AppRouteController;
  dataResource: ReaderDataResource;
  bootstrapReady: boolean;
  readingMode: ReadingMode;
  showToast: (message: string) => void;
}

export function useArticleQueue({
  route,
  dataResource,
  bootstrapReady,
  readingMode,
  showToast,
}: ArticleQueueOptions): ArticleQueueController {
  const {
    articleContext,
    current: currentRoute,
    readerRoute,
    route: appRoute,
    routedArticleId,
    setArticleContext,
  } = route;
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeArticleId, setActiveArticleId] = useState<number | null>(routedArticleId);
  const [expandedKeyboardTargetId, setExpandedKeyboardTargetId] = useState<number | null>(
    routedArticleId,
  );
  const [routedArticleRetry, setRoutedArticleRetry] = useState(0);
  const [queryRevision, setQueryRevision] = useState(0);
  const articlesRef = useRef(articles);
  const requestId = useRef(0);
  const loadedReaderRequestKey = useRef<string | null>(null);
  const contextArticleReturn = useRef<ContextArticleReturn | null>(null);
  const contextArticleReturnRoute = useRef<ReaderRoute | null>(null);
  const fullContentLoadedIds = useRef(new Set<number>());
  articlesRef.current = articles;

  const activeArticleIndex = useMemo(
    () => articles.findIndex((article) => article.id === activeArticleId),
    [activeArticleId, articles],
  );
  const activeArticle = activeArticleIndex < 0 ? null : (articles[activeArticleIndex] ?? null);

  const reloadQuery = useCallback(
    async (signal: AbortSignal) => {
      const nextRoute = currentRoute();
      if (!bootstrapReady || nextRoute.kind !== "reader") return;
      const requestKey = `${appRoutePath(nextRoute)}:${readingMode}`;
      const currentRequestId = requestId.current + 1;
      requestId.current = currentRequestId;
      setLoadingMore(false);
      const returnTarget =
        contextArticleReturn.current &&
        contextArticleReturnRoute.current &&
        appRoutePath(contextArticleReturnRoute.current) === appRoutePath(nextRoute)
          ? contextArticleReturn.current
          : null;
      if (contextArticleReturn.current && !returnTarget) {
        contextArticleReturn.current = null;
        contextArticleReturnRoute.current = null;
      }
      if (!returnTarget) setLoading(true);
      setError(null);
      try {
        const page = await api.articles(
          articleQueryForReaderRoute(nextRoute, {
            limit: readingMode === "expanded" ? 20 : 100,
            includeContent: readingMode === "expanded",
          }),
          signal,
        );
        if (
          signal.aborted ||
          requestId.current !== currentRequestId ||
          currentRoute().kind !== "reader"
        ) {
          return;
        }

        const nextArticles = articlesWithContextReturn(page.articles, returnTarget);
        loadedReaderRequestKey.current = requestKey;
        setArticles(nextArticles);
        setNextCursor(page.nextCursor);
        fullContentLoadedIds.current = new Set(
          readingMode === "expanded" ? page.articles.map((article) => article.id) : [],
        );
        setExpandedKeyboardTargetId(
          returnTarget && readingMode === "expanded" ? returnTarget.article.id : null,
        );
        setActiveArticleId((current) => {
          if (returnTarget) return returnTarget.article.id;
          if (current !== null && nextArticles.some((article) => article.id === current)) {
            return current;
          }
          return nextArticles[0]?.id ?? null;
        });
        setQueryRevision((current) => current + 1);
        if (contextArticleReturn.current === returnTarget) {
          contextArticleReturn.current = null;
          contextArticleReturnRoute.current = null;
        }
      } catch (caught) {
        if (!signal.aborted && requestId.current === currentRequestId) {
          setError(errorMessage(caught));
        }
      } finally {
        if (!signal.aborted && requestId.current === currentRequestId) setLoading(false);
      }
    },
    [bootstrapReady, currentRoute, readingMode],
  );

  const reloadAfterMutation = useCallback(
    async (signal: AbortSignal) => {
      const nextRoute = currentRoute();
      const queryRoute =
        nextRoute.kind === "reader" ? nextRoute : nextRoute.kind === "article" ? readerRoute : null;
      if (!queryRoute) {
        loadedReaderRequestKey.current = null;
        return;
      }
      const routePath = appRoutePath(nextRoute);
      const activeIndex = articlesRef.current.findIndex(
        (article) => article.id === activeArticleId,
      );
      const preserveActive =
        activeIndex >= 0 && (nextRoute.kind === "article" || readingMode === "expanded")
          ? articlesRef.current[activeIndex]
          : null;
      const currentRequestId = requestId.current + 1;
      requestId.current = currentRequestId;
      setLoadingMore(false);

      try {
        const targetCount = Math.max(
          articlesRef.current.length,
          readingMode === "expanded" ? 20 : 100,
        );
        const reloaded: Article[] = [];
        let cursor: string | null = null;
        do {
          const page = await api.articles(
            articleQueryForReaderRoute(queryRoute, {
              limit: Math.min(500, targetCount - reloaded.length),
              includeContent: readingMode === "expanded",
              ...(cursor ? { cursor } : {}),
            }),
            signal,
          );
          reloaded.push(...page.articles);
          cursor = page.nextCursor;
        } while (cursor && reloaded.length < targetCount);

        const refreshedActiveArticle = preserveActive
          ? await api.article(preserveActive.id, signal)
          : null;
        if (
          signal.aborted ||
          requestId.current !== currentRequestId ||
          appRoutePath(currentRoute()) !== routePath
        ) {
          return;
        }
        const nextArticles = articlesWithContextReturn(
          reloaded,
          refreshedActiveArticle
            ? { article: refreshedActiveArticle, index: activeIndex }
            : preserveActive
              ? { article: preserveActive, index: activeIndex }
              : null,
        );
        setArticles(nextArticles);
        setNextCursor(cursor);
        setActiveArticleId((current) =>
          current !== null && nextArticles.some((article) => article.id === current)
            ? current
            : (nextArticles[0]?.id ?? null),
        );
        fullContentLoadedIds.current = fullContentIdsAfterReload(
          readingMode,
          nextArticles,
          refreshedActiveArticle?.id ?? null,
        );
        loadedReaderRequestKey.current = `${appRoutePath(queryRoute)}:${readingMode}`;
      } catch (caught) {
        if (!signal.aborted) setError(errorMessage(caught));
        loadedReaderRequestKey.current = null;
      } finally {
        if (!signal.aborted && requestId.current === currentRequestId) setLoading(false);
      }
    },
    [activeArticleId, currentRoute, readerRoute, readingMode],
  );

  const loadArticles = dataResource.loadArticles;

  const loadOlderArticles = useCallback(async (): Promise<Article[]> => {
    const nextRoute = currentRoute();
    const queryRoute =
      nextRoute.kind === "reader" ? nextRoute : nextRoute.kind === "article" ? readerRoute : null;
    if (!bootstrapReady || !nextCursor || loadingMore || !queryRoute) return [];

    const currentRequestId = requestId.current;
    setLoadingMore(true);
    try {
      const page = await dataResource.requestArticles((signal) =>
        api.articles(
          articleQueryForReaderRoute(queryRoute, {
            limit: readingMode === "expanded" ? 20 : 100,
            includeContent: readingMode === "expanded",
            cursor: nextCursor,
          }),
          signal,
        ),
      );
      if (!page) return [];
      if (
        requestId.current !== currentRequestId ||
        (currentRoute().kind !== "reader" && currentRoute().kind !== "article")
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
    } catch (caught) {
      if (requestId.current === currentRequestId) {
        showToast(`Could not load older articles: ${errorMessage(caught)}`);
      }
      return [];
    } finally {
      if (requestId.current === currentRequestId) setLoadingMore(false);
    }
  }, [
    articles,
    bootstrapReady,
    currentRoute,
    dataResource,
    loadingMore,
    nextCursor,
    readerRoute,
    readingMode,
    showToast,
  ]);

  useEffect(() => {
    const nextRoute = appRoute;
    dataResource.cancelArticles();
    requestId.current += 1;
    setLoadingMore(false);
    if (!bootstrapReady || nextRoute.kind !== "reader") return;
    const requestKey = `${appRoutePath(nextRoute)}:${readingMode}`;
    if (contextArticleReturn.current || loadedReaderRequestKey.current !== requestKey) {
      void loadArticles();
    }
  }, [appRoute, bootstrapReady, dataResource, loadArticles, readingMode]);

  useEffect(() => {
    const articleId = routedArticleId;
    if (!bootstrapReady || articleId === null) return;
    void routedArticleRetry;
    let active = true;
    const existing = articlesRef.current.find((article) => article.id === articleId);

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
      setError(null);
      setActiveArticleId(article.id);
    };

    if (existing) {
      showArticle(existing);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setError(null);
    void dataResource
      .requestArticles(async (signal) => {
        const article = await api.article(articleId, signal);
        const context = articleContext();
        const queueRoute = context?.route ?? {
          kind: "reader" as const,
          scope: "feed" as const,
          scopeId: article.feedId,
          state: "all" as const,
          search: "",
        };
        const page = await api.articles(
          articleQueryForReaderRoute(queueRoute, {
            limit: readingMode === "expanded" ? 20 : 100,
            includeContent: readingMode === "expanded",
            anchorId: article.id,
          }),
          signal,
        );
        return { article, page, queueRoute, articleIndex: context?.articleIndex };
      })
      .then((loaded) => {
        if (!active || !loaded) return;
        const { article, page, queueRoute, articleIndex } = loaded;
        const pageIndex = page.articles.findIndex((item) => item.id === article.id);
        const nextArticles = articlesWithContextReturn(page.articles, {
          article,
          index: page.anchorIndex ?? (pageIndex >= 0 ? pageIndex : (articleIndex ?? 0)),
        });
        const actualArticleIndex = nextArticles.findIndex((item) => item.id === article.id);
        setArticleContext(queueRoute, actualArticleIndex >= 0 ? actualArticleIndex : articleIndex);
        loadedReaderRequestKey.current = `${appRoutePath(queueRoute)}:${readingMode}`;
        fullContentLoadedIds.current.add(article.id);
        setArticles(nextArticles);
        setNextCursor(page.nextCursor);
        setError(null);
        setActiveArticleId(article.id);
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      dataResource.cancelArticles();
    };
  }, [
    articleContext,
    bootstrapReady,
    dataResource,
    readingMode,
    routedArticleId,
    routedArticleRetry,
    setArticleContext,
  ]);

  const selectArticle = useCallback((articleId: number, keyboardTarget = false) => {
    setActiveArticleId(articleId);
    setExpandedKeyboardTargetId(keyboardTarget ? articleId : null);
  }, []);

  const mergeArticle = useCallback((updated: Article) => {
    fullContentLoadedIds.current.add(updated.id);
    setArticles((current) =>
      current.map((article) =>
        article.id === updated.id
          ? { ...updated, isRead: article.isRead, isStarred: article.isStarred }
          : article,
      ),
    );
  }, []);

  const preserveContextArticle = useCallback(
    (article: Article, articleIndex: number, returnRoute: ReaderRoute) => {
      contextArticleReturn.current = { article, index: articleIndex };
      contextArticleReturnRoute.current = returnRoute;
      setActiveArticleId(article.id);
      setExpandedKeyboardTargetId(readingMode === "expanded" ? article.id : null);
    },
    [readingMode],
  );

  const invalidate = useCallback(() => {
    loadedReaderRequestKey.current = null;
  }, []);

  return {
    articles,
    setArticles,
    articlesRef,
    loading,
    loadingMore,
    error,
    nextCursor,
    activeArticleId,
    activeArticle,
    activeArticleIndex,
    expandedKeyboardTargetId,
    queryRevision,
    fullContentLoadedIds,
    loadArticles,
    reloadQuery,
    reloadAfterMutation,
    loadOlderArticles,
    selectArticle,
    clearKeyboardTarget: () => setExpandedKeyboardTargetId(null),
    mergeArticle,
    preserveContextArticle,
    invalidate,
    retryRoutedArticle: () => setRoutedArticleRetry((current) => current + 1),
  };
}
