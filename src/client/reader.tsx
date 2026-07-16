import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  FileText,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Rss,
  Star,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { Article, ArticleState, ReadingMode } from "../shared/types";
import { extractHttpLinks, supplementalHttpLinks } from "./article-links";

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

function ArticleFeedLinks({ article }: { article: Article }) {
  const links = supplementalHttpLinks(article.summary, article.url);
  if (links.length === 0) return null;

  return (
    <div className="article-feed-links">
      <span>Feed links</span>
      {links.map((link) => (
        <a key={link.href} href={link.href} target="_blank" rel="noreferrer" title={link.href}>
          <ExternalLink aria-hidden="true" size={13} />
          {link.label}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ))}
    </div>
  );
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
  onPrevious?: () => void;
  onNext?: () => void;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
}

function ArticleActions({
  article,
  onPrevious,
  onNext,
  onMarkUnread,
  onToggleStar,
  onCopy,
}: ArticleActionsProps) {
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

export function ReaderPane({
  article,
  onBack,
  onPrevious,
  onNext,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onRetryExtraction,
}: {
  article: Article | null;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onRetryExtraction: (article: Article) => void;
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
      <button className="mobile-reader-back" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={16} />
        Back to articles
      </button>
      <div className="reader-action-bar">
        <ArticleActions
          article={article}
          onPrevious={onPrevious}
          onNext={onNext}
          onMarkUnread={onMarkUnread}
          onToggleStar={onToggleStar}
          onCopy={onCopy}
        />
      </div>
      <div className="article-document">
        <ArticleHeader article={article} id={`article-${article.id}-title`} />
        <ArticleBody article={article} onRetryExtraction={onRetryExtraction} />
      </div>
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
      <ArticleFeedLinks article={article} />
      {article.contentSource === "feed" ? (
        <div className="article-source-status">
          <span>
            <Rss aria-hidden="true" size={14} /> Feed content
          </span>
        </div>
      ) : null}
    </header>
  );
}

function ArticleBody({
  article,
  onRetryExtraction,
}: {
  article: Article;
  onRetryExtraction: (article: Article) => void;
}) {
  return (
    <>
      {article.media ? <ArticleMediaPlayer article={article} /> : null}
      <ArticleText article={article} onRetryExtraction={onRetryExtraction} />
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
  onRetryExtraction,
}: {
  article: Article;
  onRetryExtraction: (article: Article) => void;
}) {
  if (article.extractionStatus === "pending" || article.extractionStatus === "processing") {
    return (
      <div className="article-extraction-state" role="status">
        <LoaderCircle className="spin" aria-hidden="true" size={18} />
        <div>
          <strong>Extracting full text</strong>
          <p>The feed summary is shown while the complete article is prepared.</p>
        </div>
        {article.summary ? (
          <p className="article-summary-fallback">
            <LinkifiedText text={article.summary} />
          </p>
        ) : null}
      </div>
    );
  }
  if (article.contentHtml) {
    return (
      // biome-ignore lint/security/noDangerouslySetInnerHtml: The server sanitizes extracted article HTML before returning it.
      <div className="article-content" dangerouslySetInnerHTML={{ __html: article.contentHtml }} />
    );
  }
  if (article.extractionStatus === "failed") {
    return (
      <div className="article-extraction-state extraction-failed" role="note">
        <AlertTriangle aria-hidden="true" size={18} />
        <div>
          <strong>Full text could not be extracted</strong>
          <p>
            {article.extractionError ?? "The source page did not return readable article content."}
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onRetryExtraction(article)}
          >
            <RefreshCw aria-hidden="true" size={15} />
            Retry full text
          </button>
        </div>
        {article.summary ? (
          <p className="article-summary-fallback">
            <LinkifiedText text={article.summary} />
          </p>
        ) : null}
      </div>
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
  markReadOnScroll,
  hasMore,
  loadingMore,
  onLoadMore,
  onActivate,
  onMarkPassedRead,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onRetryExtraction,
}: {
  articles: Article[];
  activeId: number | null;
  topAlignedId: number | null;
  markReadOnScroll: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onActivate: (article: Article) => void;
  onMarkPassedRead: (articles: Article[]) => Promise<unknown>;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onRetryExtraction: (article: Article) => void;
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
              onMarkUnread={onMarkUnread}
              onToggleStar={onToggleStar}
              onCopy={onCopy}
            />
          </div>
          <div className="article-document">
            <ArticleHeader article={article} id={`expanded-${article.id}-title`} />
            <ArticleBody article={article} onRetryExtraction={onRetryExtraction} />
          </div>
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
