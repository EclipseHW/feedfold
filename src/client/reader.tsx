import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  FileText,
  Inbox,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  Rss,
  Star,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Article, ArticleState, ReadingMode } from "../shared/types";
import { articleContentView } from "./article-content";
import { extractHttpLinks } from "./article-links";
import {
  captureTextSelection,
  restoreTextSelection,
  type TextSelectionSnapshot,
} from "./text-selection";

function formatRelativeDate(value: string | null): string {
  if (!value) return "Date unknown";
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "Just now";
}

function articleDate(article: Article): string {
  return formatRelativeDate(article.publishedAt ?? article.discoveredAt);
}

function formatViewCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function mediaTypeLabel(article: Article): string | null {
  if (!article.media) return null;
  return article.media.type === "short" ? "Short" : "Video";
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}

function LinkifiedText({ text }: { text: string }) {
  const links = extractHttpLinks(text);
  if (links.length === 0) return text;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const link of links) {
    if (link.start > cursor) nodes.push(text.slice(cursor, link.start));
    nodes.push(
      <a
        key={`${link.href}-${link.start}`}
        href={link.href}
        target="_blank"
        rel="noreferrer"
        title={link.href}
      >
        {link.text}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>,
    );
    cursor = link.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function useMarkReadOnScroll({
  articles,
  activeId,
  enabled,
  onMarkPassedRead,
  rootRef,
  useParent = false,
  topAlignedId = null,
}: {
  articles: Article[];
  activeId: number | null;
  enabled: boolean;
  onMarkPassedRead: (articles: Article[]) => Promise<unknown>;
  rootRef: React.RefObject<HTMLElement | null>;
  useParent?: boolean;
  topAlignedId?: number | null;
}) {
  const itemRefs = useRef(new Map<number, HTMLElement>());
  const articlesRef = useRef(articles);
  const enabledRef = useRef(enabled);
  const markPassedRef = useRef(onMarkPassedRead);
  const scrollIntentUntil = useRef(0);
  const lastScrollTop = useRef(0);
  const readRequests = useRef(new Set<number>());
  const queuedReads = useRef(new Map<number, Article>());
  const readTimer = useRef<number | null>(null);
  articlesRef.current = articles;
  enabledRef.current = enabled;
  markPassedRef.current = onMarkPassedRead;

  useEffect(() => {
    const activeItem = activeId === null ? null : itemRefs.current.get(activeId);
    if (!activeItem) return;
    if (!useParent) {
      activeItem.scrollIntoView({ behavior: "auto", block: "nearest" });
      return;
    }
    const root = rootRef.current;
    const container = root?.parentElement;
    if (!container) return;
    const itemRect = activeItem.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    if (activeId === topAlignedId) {
      container.scrollTop += itemRect.top - containerRect.top;
      return;
    }

    const isVisible = itemRect.bottom > containerRect.top && itemRect.top < containerRect.bottom;
    if (isVisible) return;
    if (itemRect.top >= containerRect.bottom && itemRect.height <= containerRect.height) {
      container.scrollTop += itemRect.bottom - containerRect.bottom;
      return;
    }
    container.scrollTop += itemRect.top - containerRect.top;
  }, [activeId, rootRef, topAlignedId, useParent]);

  useEffect(() => {
    const root = rootRef.current;
    const container = useParent ? root?.parentElement : root;
    if (!container) return;
    lastScrollTop.current = container.scrollTop;

    const noteScrollIntent = () => {
      scrollIntentUntil.current = performance.now() + 1500;
    };
    const noteScrollbarIntent = (event: PointerEvent) => {
      if (event.target === container) noteScrollIntent();
    };
    const noteKeyboardScrollIntent = (event: KeyboardEvent) => {
      if (["ArrowDown", "End", "PageDown", " "].includes(event.key)) noteScrollIntent();
    };
    const flushQueuedReads = () => {
      readTimer.current = null;
      if (!enabledRef.current) {
        queuedReads.current.clear();
        return;
      }
      const currentArticles = new Map(articlesRef.current.map((article) => [article.id, article]));
      const batch = [...queuedReads.current.keys()].flatMap((id) => {
        const article = currentArticles.get(id);
        return article && !article.isRead ? [article] : [];
      });
      queuedReads.current.clear();
      if (batch.length === 0) return;
      for (const article of batch) readRequests.current.add(article.id);
      void markPassedRef.current(batch).finally(() => {
        for (const article of batch) readRequests.current.delete(article.id);
      });
    };
    const markPassedItemsRead = () => {
      const scrollingDown = container.scrollTop > lastScrollTop.current + 1;
      lastScrollTop.current = container.scrollTop;
      if (
        !enabledRef.current ||
        !scrollingDown ||
        container.scrollTop <= 0 ||
        performance.now() > scrollIntentUntil.current
      ) {
        return;
      }

      const passedBoundary = container.getBoundingClientRect().top;
      for (const article of articlesRef.current) {
        if (
          article.isRead ||
          queuedReads.current.has(article.id) ||
          readRequests.current.has(article.id)
        ) {
          continue;
        }
        const item = itemRefs.current.get(article.id);
        if (!item || item.getBoundingClientRect().bottom > passedBoundary) continue;
        queuedReads.current.set(article.id, article);
      }

      if (queuedReads.current.size > 0) {
        if (readTimer.current) window.clearTimeout(readTimer.current);
        readTimer.current = window.setTimeout(flushQueuedReads, 250);
      }
    };

    container.addEventListener("wheel", noteScrollIntent, { passive: true });
    container.addEventListener("pointerdown", noteScrollbarIntent, { passive: true });
    container.addEventListener("touchmove", noteScrollIntent, { passive: true });
    container.addEventListener("keydown", noteKeyboardScrollIntent, true);
    container.addEventListener("scroll", markPassedItemsRead, { passive: true });
    return () => {
      container.removeEventListener("wheel", noteScrollIntent);
      container.removeEventListener("pointerdown", noteScrollbarIntent);
      container.removeEventListener("touchmove", noteScrollIntent);
      container.removeEventListener("keydown", noteKeyboardScrollIntent, true);
      container.removeEventListener("scroll", markPassedItemsRead);
      if (readTimer.current) window.clearTimeout(readTimer.current);
      flushQueuedReads();
    };
  }, [rootRef, useParent]);

  return (id: number, element: HTMLElement | null) => {
    if (element) itemRefs.current.set(id, element);
    else itemRefs.current.delete(id);
  };
}

function ArticleLoadSentinel({
  rootRef,
  useParent = false,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  useParent?: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = useParent ? rootRef.current?.parentElement : rootRef.current;
    if (!sentinel || !root || !hasMore || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
      },
      { root, rootMargin: "0px 0px 400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, rootRef, useParent]);

  if (!hasMore) return null;
  return (
    <div
      ref={sentinelRef}
      className={`article-load-sentinel${loadingMore ? " is-loading" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy={loadingMore}
    >
      {loadingMore ? (
        <>
          <LoaderCircle className="spin" aria-hidden="true" size={15} />
          <span>Loading older articles</span>
        </>
      ) : null}
    </div>
  );
}

export function AppSkeleton() {
  return (
    <div
      className="app-shell app-loading"
      role="status"
      aria-busy="true"
      aria-label="Loading Echovale"
    >
      <aside className="sidebar skeleton-sidebar">
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line short" />
      </aside>
      <main className="main-column">
        <div className="skeleton-toolbar" />
        <div className="reading-workspace mode-magazine">
          <ArticleListSkeleton mode="magazine" />
        </div>
      </main>
      <span className="sr-only">Loading feeds and articles</span>
    </div>
  );
}

export function StartupError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="startup-state">
      <div className="startup-mark" aria-hidden="true">
        <Rss size={24} />
      </div>
      <h1>Echovale is not reachable</h1>
      <p>{message}</p>
      <button className="primary-button" type="button" onClick={retry}>
        <RefreshCw aria-hidden="true" size={16} />
        Try again
      </button>
    </main>
  );
}

export function ArticleListSkeleton({ mode }: { mode: ReadingMode }) {
  if (mode === "expanded") {
    return (
      <div
        className="expanded-stream skeleton-stream"
        role="status"
        aria-busy="true"
        aria-label="Loading articles"
      >
        {[0, 1, 2].map((key) => (
          <div className="expanded-article skeleton-expanded" key={key}>
            <div className="skeleton-line short" />
            <div className="skeleton-line wide" />
            <div className="skeleton-line" />
            <div className="skeleton-block" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      <div
        className="article-list skeleton-list"
        role="status"
        aria-busy="true"
        aria-label="Loading articles"
      >
        {[0, 1, 2, 3, 4, 5].map((key) => (
          <div className="skeleton-list-row" key={key}>
            <div className="skeleton-line short" />
            <div className="skeleton-line wide" />
            <div className="skeleton-line" />
          </div>
        ))}
      </div>
      <div className="reader-pane skeleton-reader">
        <div className="skeleton-line short" />
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-block" />
      </div>
    </>
  );
}

export function InlineError({
  title,
  detail,
  retry,
}: {
  title: string;
  detail: string;
  retry: () => void;
}) {
  return (
    <section className="inline-state error-state" role="alert">
      <AlertTriangle aria-hidden="true" size={22} />
      <h2>{title}</h2>
      <p>{detail}</p>
      <button className="secondary-button" type="button" onClick={retry}>
        <RefreshCw aria-hidden="true" size={16} />
        Try again
      </button>
    </section>
  );
}

export function EmptyArticles({
  hasFeeds,
  search,
  state,
  onAddFeed,
  onShowAll,
  onClearSearch,
}: {
  hasFeeds: boolean;
  search: string;
  state: ArticleState;
  onAddFeed: () => void;
  onShowAll: () => void;
  onClearSearch: () => void;
}) {
  if (!hasFeeds) {
    return (
      <section className="inline-state empty-state">
        <Rss aria-hidden="true" size={24} />
        <h2>Your reading queue starts with a feed</h2>
        <p>Add one RSS or Atom URL, or import your existing OPML file.</p>
        <button className="primary-button" type="button" onClick={onAddFeed}>
          Add feeds
        </button>
      </section>
    );
  }
  if (search) {
    return (
      <section className="inline-state empty-state">
        <FileText aria-hidden="true" size={24} />
        <h2>No articles match “{search}”</h2>
        <p>Try a shorter phrase or clear the search to return to the queue.</p>
        <button className="secondary-button" type="button" onClick={onClearSearch}>
          Clear search
        </button>
      </section>
    );
  }
  if (state === "unread") {
    return (
      <section className="inline-state empty-state">
        <CheckCircle2 aria-hidden="true" size={24} />
        <h2>You are caught up</h2>
        <p>New articles will appear here after the next background or manual refresh.</p>
        <button className="secondary-button" type="button" onClick={onShowAll}>
          Browse read articles
        </button>
      </section>
    );
  }
  return (
    <section className="inline-state empty-state">
      <Inbox aria-hidden="true" size={24} />
      <h2>No articles in this view</h2>
      <p>Choose another filter or feed from the navigation.</p>
      <button className="secondary-button" type="button" onClick={onShowAll}>
        Show all articles
      </button>
    </section>
  );
}

export function ArticleList({
  articles,
  activeId,
  markReadOnScroll,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  onMarkPassedRead,
  onToggleRead,
  onToggleStar,
}: {
  articles: Article[];
  activeId: number | null;
  markReadOnScroll: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (article: Article, openReader?: boolean) => void;
  onMarkPassedRead: (articles: Article[]) => Promise<unknown>;
  onToggleRead: (article: Article) => void;
  onToggleStar: (article: Article) => void;
}) {
  const listRef = useRef<HTMLElement>(null);
  const registerItem = useMarkReadOnScroll({
    articles,
    activeId,
    enabled: markReadOnScroll,
    onMarkPassedRead,
    rootRef: listRef,
  });

  return (
    <section ref={listRef} className="article-list" aria-label="Articles">
      <div className="article-list-summary">
        <span>{articles.filter((article) => !article.isRead).length} unread loaded</span>
        <span>
          Use <Kbd>J</Kbd> <Kbd>K</Kbd> to move
        </span>
      </div>
      <ol>
        {articles.map((article) => (
          <li
            key={article.id}
            ref={(element) => registerItem(article.id, element)}
            className={`article-list-item${article.id === activeId ? " is-active" : ""}${article.isRead ? " is-read" : ""}`}
          >
            <button
              className="article-open-button"
              type="button"
              aria-current={article.id === activeId ? "true" : undefined}
              onClick={() => onOpen(article)}
            >
              <span className="sr-only">Open {article.title}</span>
            </button>
            <div className="article-card-content">
              {article.imageUrl ? (
                <img className="article-card-image" src={article.imageUrl} alt="" loading="lazy" />
              ) : (
                <span
                  className="article-card-image article-card-image-placeholder"
                  aria-hidden="true"
                >
                  <FileText size={18} />
                </span>
              )}
              <span className="article-list-copy">
                <span className="article-list-meta">
                  <span className="feed-name truncate">{article.feedTitle}</span>
                  {article.media ? (
                    <span className={`article-media-badge ${article.media.type}`}>
                      {mediaTypeLabel(article)}
                    </span>
                  ) : null}
                  <time dateTime={article.publishedAt ?? article.discoveredAt}>
                    {articleDate(article)}
                  </time>
                </span>
                <span className="article-list-title">
                  {!article.isRead ? (
                    <span className="unread-dot">
                      <span className="sr-only">Unread: </span>
                    </span>
                  ) : null}
                  {article.title}
                </span>
                {article.summary ? (
                  <span className="article-list-summary-text">
                    <LinkifiedText text={article.summary} />
                  </span>
                ) : null}
              </span>
            </div>
            <div className="article-card-state-actions">
              <button
                className="list-read-button"
                type="button"
                aria-label={
                  article.isRead ? `Mark ${article.title} unread` : `Mark ${article.title} read`
                }
                title={article.isRead ? "Mark unread" : "Mark read"}
                onClick={() => onToggleRead(article)}
              >
                {article.isRead ? (
                  <CheckCircle2 aria-hidden="true" size={15} />
                ) : (
                  <Circle aria-hidden="true" size={15} />
                )}
              </button>
              <button
                className={`list-star-button${article.isStarred ? " is-starred" : ""}`}
                type="button"
                aria-label={
                  article.isStarred ? `Remove star from ${article.title}` : `Star ${article.title}`
                }
                title={article.isStarred ? "Remove star" : "Star"}
                aria-pressed={article.isStarred}
                onClick={() => onToggleStar(article)}
              >
                <Star
                  aria-hidden="true"
                  size={15}
                  fill={article.isStarred ? "currentColor" : "none"}
                />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <ArticleLoadSentinel
        rootRef={listRef}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
      {!hasMore ? (
        <div className="article-list-end" role="status">
          No more articles here
        </div>
      ) : null}
    </section>
  );
}

interface ArticleActionsProps {
  article: Article;
  fullContentVisible: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onToggleFullContent: (article: Article) => void;
}

function ArticleActions({
  article,
  fullContentVisible,
  onPrevious,
  onNext,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onToggleFullContent,
}: ArticleActionsProps) {
  const fullContentAvailable = Boolean(article.url) && !article.media;
  const cachedFullContent = article.extractionStatus === "complete" && Boolean(article.contentHtml);
  const fullContentLoading =
    fullContentVisible &&
    (article.extractionStatus === "pending" || article.extractionStatus === "processing");
  const fullContentLoaded = fullContentVisible && cachedFullContent;
  const fullContentFailed = fullContentVisible && article.extractionStatus === "failed";
  const fullContentLabel = fullContentLoading
    ? "Loading full content"
    : fullContentLoaded
      ? "Show feed content"
      : fullContentFailed
        ? "Retry full content"
        : cachedFullContent
          ? "Show full content"
          : "Load full content";
  return (
    <div className="article-actions" role="toolbar" aria-label="Article actions">
      {onPrevious ? (
        <button
          type="button"
          onClick={onPrevious}
          aria-label="Previous article (K)"
          title="Previous article (K)"
        >
          <ArrowLeft aria-hidden="true" size={16} />
          <span className="action-label">Previous</span>
          <Kbd>K</Kbd>
        </button>
      ) : null}
      {onNext ? (
        <button
          type="button"
          onClick={onNext}
          aria-label="Next article (J)"
          title="Next article (J)"
        >
          <ArrowRight aria-hidden="true" size={16} />
          <span className="action-label">Next</span>
          <Kbd>J</Kbd>
        </button>
      ) : null}
      <span className="action-divider" />
      {fullContentAvailable ? (
        <button
          className="full-content-action"
          type="button"
          disabled={fullContentLoading}
          aria-pressed={fullContentLoaded}
          onClick={() => onToggleFullContent(article)}
          aria-label={`${fullContentLabel} (W)`}
          title={`${fullContentLabel} (W)`}
        >
          {fullContentLoading ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : fullContentLoaded ? (
            <Rss aria-hidden="true" size={16} />
          ) : fullContentFailed ? (
            <RefreshCw aria-hidden="true" size={16} />
          ) : cachedFullContent ? (
            <FileText aria-hidden="true" size={16} />
          ) : (
            <Download aria-hidden="true" size={16} />
          )}
          <span className="action-label">{fullContentLabel}</span>
          <Kbd>W</Kbd>
        </button>
      ) : null}
      <button
        type="button"
        disabled={!article.isRead}
        onClick={() => onMarkUnread(article)}
        aria-label="Mark article unread (U)"
        title="Mark article unread (U)"
      >
        <BookOpen aria-hidden="true" size={16} />
        <span className="action-label">Mark unread</span>
        <Kbd>U</Kbd>
      </button>
      <button
        className={article.isStarred ? "is-starred" : ""}
        type="button"
        aria-pressed={article.isStarred}
        onClick={() => onToggleStar(article)}
        aria-label={article.isStarred ? "Remove star (S)" : "Star article (S)"}
        title={article.isStarred ? "Remove star (S)" : "Star article (S)"}
      >
        <Star aria-hidden="true" size={16} fill={article.isStarred ? "currentColor" : "none"} />
        <span className="action-label">{article.isStarred ? "Starred" : "Star"}</span>
        <Kbd>S</Kbd>
      </button>
      <button
        type="button"
        onClick={() => onCopy(article)}
        aria-label="Copy article URL (C)"
        title="Copy article URL (C)"
      >
        <Copy aria-hidden="true" size={16} />
        <span className="action-label">Copy URL</span>
        <Kbd>C</Kbd>
      </button>
    </div>
  );
}

interface SelectionMenuState {
  text: string;
  selection: TextSelectionSnapshot;
  left: number;
  top: number;
  placement: "above" | "below";
}

function ArticleDocument({
  article,
  titleId,
  fullContentVisible,
  onToggleFullContent,
  onFilterSelection,
}: {
  article: Article;
  titleId: string;
  fullContentVisible: boolean;
  onToggleFullContent: (article: Article) => void;
  onFilterSelection: (article: Article, text: string) => void;
}) {
  const documentRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);

  const showSelectionMenu = useCallback(() => {
    const root = documentRef.current;
    const selection = window.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !root.contains(selection.anchorNode) ||
      !root.contains(selection.focusNode)
    ) {
      setSelectionMenu(null);
      return;
    }

    const selectionSnapshot = captureTextSelection(root, selection);
    const text = selectionSnapshot?.text.replace(/\s+/g, " ").trim() ?? "";
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    if (!selectionSnapshot || !text || (bounds.width === 0 && bounds.height === 0)) {
      setSelectionMenu(null);
      return;
    }

    const placement = bounds.top < 56 ? "below" : "above";
    setSelectionMenu({
      text,
      selection: selectionSnapshot,
      left: Math.min(window.innerWidth - 52, Math.max(52, bounds.left + bounds.width / 2)),
      top: placement === "above" ? bounds.top : bounds.bottom,
      placement,
    });
  }, []);

  useEffect(() => {
    const root = documentRef.current;
    if (!root) return;

    const dismiss = () => setSelectionMenu(null);
    root.addEventListener("pointerdown", dismiss);
    root.addEventListener("pointerup", showSelectionMenu);
    root.addEventListener("keyup", showSelectionMenu);
    return () => {
      root.removeEventListener("pointerdown", dismiss);
      root.removeEventListener("pointerup", showSelectionMenu);
      root.removeEventListener("keyup", showSelectionMenu);
    };
  }, [showSelectionMenu]);

  useLayoutEffect(() => {
    const root = documentRef.current;
    if (!root || !selectionMenu) return;
    restoreTextSelection(root, selectionMenu.selection);
  }, [selectionMenu]);

  useEffect(() => {
    if (!selectionMenu) return;

    const dismiss = () => setSelectionMenu(null);
    const dismissOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      dismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      dismiss();
    };

    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [selectionMenu]);

  return (
    <>
      <div ref={documentRef} className="article-document">
        <ArticleHeader article={article} id={titleId} />
        <ArticleBody
          article={article}
          fullContentVisible={fullContentVisible}
          onToggleFullContent={onToggleFullContent}
        />
      </div>
      {selectionMenu
        ? createPortal(
            <div
              ref={menuRef}
              className="article-selection-menu"
              role="menu"
              aria-label="Selected text actions"
              data-placement={selectionMenu.placement}
              style={{ left: selectionMenu.left, top: selectionMenu.top }}
            >
              <button
                type="button"
                role="menuitem"
                aria-label="Filter selected text"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  const { text } = selectionMenu;
                  setSelectionMenu(null);
                  onFilterSelection(article, text);
                }}
              >
                <ListFilter aria-hidden="true" size={15} />
                Filter
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function ReaderPane({
  article,
  fullContentVisible,
  onBack,
  onPrevious,
  onNext,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onToggleFullContent,
  onFilterSelection,
}: {
  article: Article | null;
  fullContentVisible: boolean;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onToggleFullContent: (article: Article) => void;
  onFilterSelection: (article: Article, text: string) => void;
}) {
  if (!article) {
    return (
      <section className="reader-pane reader-placeholder">
        <BookOpen aria-hidden="true" size={24} />
        <p>Choose an article to read it here.</p>
      </section>
    );
  }
  return (
    <article
      className="reader-pane"
      key={article.id}
      aria-labelledby={`article-${article.id}-title`}
    >
      <div className="reader-action-bar">
        <div className="reader-action-row">
          <button className="reader-back-button" type="button" onClick={onBack}>
            <ArrowLeft aria-hidden="true" size={16} />
            Back to articles
          </button>
          <span className="reader-action-divider" aria-hidden="true" />
          <ArticleActions
            article={article}
            fullContentVisible={fullContentVisible}
            onPrevious={onPrevious}
            onNext={onNext}
            onMarkUnread={onMarkUnread}
            onToggleStar={onToggleStar}
            onCopy={onCopy}
            onToggleFullContent={onToggleFullContent}
          />
        </div>
      </div>
      <ArticleDocument
        article={article}
        titleId={`article-${article.id}-title`}
        fullContentVisible={fullContentVisible}
        onToggleFullContent={onToggleFullContent}
        onFilterSelection={onFilterSelection}
      />
    </article>
  );
}

function ArticleHeader({ article, id }: { article: Article; id: string }) {
  return (
    <header className="article-header">
      <div className="article-source-row">
        <span>{article.feedTitle}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={article.publishedAt ?? article.discoveredAt}>{articleDate(article)}</time>
        {article.media ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={`article-media-badge ${article.media.type}`}>
              {mediaTypeLabel(article)}
            </span>
            {article.media.viewCount !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatViewCount(article.media.viewCount)} views</span>
              </>
            ) : null}
          </>
        ) : null}
        {article.author ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{article.author}</span>
          </>
        ) : null}
      </div>
      <h2 id={id}>
        {article.url ? (
          <a href={article.url} target="_blank" rel="noreferrer">
            {article.title}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          article.title
        )}
      </h2>
    </header>
  );
}

function ArticleBody({
  article,
  fullContentVisible,
  onToggleFullContent,
}: {
  article: Article;
  fullContentVisible: boolean;
  onToggleFullContent: (article: Article) => void;
}) {
  return (
    <>
      {article.media ? <ArticleMediaPlayer article={article} /> : null}
      <ArticleText
        article={article}
        fullContentVisible={fullContentVisible}
        onToggleFullContent={onToggleFullContent}
      />
    </>
  );
}

function ArticleMediaPlayer({ article }: { article: Article }) {
  const media = article.media;
  if (!media) return null;
  return (
    <div className={`article-media-player ${media.type}`}>
      <iframe
        src={media.embedUrl}
        title={`Play ${article.title}`}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
  );
}

function ArticleText({
  article,
  fullContentVisible,
  onToggleFullContent,
}: {
  article: Article;
  fullContentVisible: boolean;
  onToggleFullContent: (article: Article) => void;
}) {
  const contentView = articleContentView(article, fullContentVisible);
  if (contentView === "feed" || contentView === "summary" || contentView === "empty") {
    return <FeedArticleText article={article} />;
  }

  if (contentView === "loading") {
    return (
      <>
        <div className="article-extraction-state extraction-loading" role="status">
          <LoaderCircle className="spin" aria-hidden="true" size={18} />
          <div>
            <strong>Loading full content</strong>
            <p>The feed article remains available while the source page is processed.</p>
          </div>
        </div>
        <FeedArticleText article={article} />
      </>
    );
  }
  if (contentView === "full" && article.contentHtml) {
    return (
      // biome-ignore lint/security/noDangerouslySetInnerHtml: The server sanitizes extracted article HTML before returning it.
      <div className="article-content" dangerouslySetInnerHTML={{ __html: article.contentHtml }} />
    );
  }
  if (contentView === "failed") {
    return (
      <>
        <div className="article-extraction-state extraction-failed" role="note">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>Full content could not be loaded</strong>
            <p>
              {article.extractionError ??
                "The source page did not return readable article content."}
            </p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onToggleFullContent(article)}
            >
              <RefreshCw aria-hidden="true" size={15} />
              Retry full content
            </button>
          </div>
        </div>
        <FeedArticleText article={article} />
      </>
    );
  }

  return <FeedArticleText article={article} />;
}

function FeedArticleText({ article }: { article: Article }) {
  if (article.feedContentHtml) {
    const html = article.feedContentHtml;
    return (
      // biome-ignore lint/security/noDangerouslySetInnerHtml: The server sanitizes feed HTML before returning it.
      <div className="article-content" dangerouslySetInnerHTML={{ __html: html }} />
    );
  }
  return article.summary ? (
    <div className="article-content">
      <p>
        <LinkifiedText text={article.summary} />
      </p>
    </div>
  ) : (
    <div className="article-extraction-state">
      <FileText aria-hidden="true" size={18} />
      <p>This feed did not include article text.</p>
    </div>
  );
}

export function ExpandedStream({
  articles,
  activeId,
  topAlignedId,
  fullContentVisibleIds,
  markReadOnScroll,
  hasMore,
  loadingMore,
  onLoadMore,
  onActivate,
  onMarkPassedRead,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onToggleFullContent,
  onFilterSelection,
}: {
  articles: Article[];
  activeId: number | null;
  topAlignedId: number | null;
  fullContentVisibleIds: ReadonlySet<number>;
  markReadOnScroll: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onActivate: (article: Article) => void;
  onMarkPassedRead: (articles: Article[]) => Promise<unknown>;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onToggleFullContent: (article: Article) => void;
  onFilterSelection: (article: Article, text: string) => void;
}) {
  const streamRef = useRef<HTMLElement>(null);
  const registerItem = useMarkReadOnScroll({
    articles,
    activeId,
    enabled: markReadOnScroll,
    onMarkPassedRead,
    rootRef: streamRef,
    useParent: true,
    topAlignedId,
  });

  return (
    <section ref={streamRef} className="expanded-stream" aria-label="Expanded articles">
      {articles.map((article) => (
        <article
          ref={(element) => registerItem(article.id, element)}
          className={`expanded-article${article.id === activeId ? " is-active" : ""}${article.isRead ? " is-read" : ""}`}
          key={article.id}
          aria-labelledby={`expanded-${article.id}-title`}
          onFocus={() => onActivate(article)}
        >
          <div className="expanded-actions">
            <ArticleActions
              article={article}
              fullContentVisible={fullContentVisibleIds.has(article.id)}
              onMarkUnread={onMarkUnread}
              onToggleStar={onToggleStar}
              onCopy={onCopy}
              onToggleFullContent={onToggleFullContent}
            />
          </div>
          <ArticleDocument
            article={article}
            titleId={`expanded-${article.id}-title`}
            fullContentVisible={fullContentVisibleIds.has(article.id)}
            onToggleFullContent={onToggleFullContent}
            onFilterSelection={onFilterSelection}
          />
        </article>
      ))}
      <ArticleLoadSentinel
        rootRef={streamRef}
        useParent
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}
