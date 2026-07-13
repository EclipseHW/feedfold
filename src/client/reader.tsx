import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Copy,
  FileText,
  Inbox,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Rss,
  Star,
  Type,
} from "lucide-react";
import type { Article, ArticleState, ReadingMode } from "../shared/types";

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

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
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
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  onToggleStar,
}: {
  articles: Article[];
  activeId: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (article: Article, openMobile?: boolean) => void;
  onToggleStar: (article: Article) => void;
}) {
  return (
    <section className="article-list" aria-label="Articles">
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
            className={`article-list-item${article.id === activeId ? " is-active" : ""}${article.isRead ? " is-read" : ""}`}
          >
            <button
              className="article-open-button"
              type="button"
              aria-current={article.id === activeId ? "true" : undefined}
              onClick={() => onOpen(article)}
            >
              <span className="article-list-meta">
                <span className="feed-name truncate">{article.feedTitle}</span>
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
                <span className="article-list-summary-text">{article.summary}</span>
              ) : null}
            </button>
            <button
              className={`list-star-button${article.isStarred ? " is-starred" : ""}`}
              type="button"
              aria-label={
                article.isStarred ? `Remove star from ${article.title}` : `Star ${article.title}`
              }
              aria-pressed={article.isStarred}
              onClick={() => onToggleStar(article)}
            >
              <Star
                aria-hidden="true"
                size={15}
                fill={article.isStarred ? "currentColor" : "none"}
              />
            </button>
          </li>
        ))}
      </ol>
      {hasMore ? (
        <div className="form-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            {loadingMore ? "Loading older articles" : "Load older articles"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface ArticleActionsProps {
  article: Article;
  fontSize: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onFontDecrease: () => void;
  onFontIncrease: () => void;
}

function ArticleActions({
  article,
  fontSize,
  onPrevious,
  onNext,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onFontDecrease,
  onFontIncrease,
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
      <span className="action-divider" />
      <button
        type="button"
        onClick={onFontDecrease}
        disabled={fontSize <= 15}
        aria-label="Decrease article font size ([)"
        title="Decrease font size ([)"
      >
        <Minus aria-hidden="true" size={15} />
        <Kbd>[</Kbd>
      </button>
      <span className="font-size-value" title={`Article font size ${fontSize} pixels`}>
        <Type aria-hidden="true" size={15} />
        {fontSize}
      </span>
      <button
        type="button"
        onClick={onFontIncrease}
        disabled={fontSize >= 23}
        aria-label="Increase article font size (])"
        title="Increase font size (])"
      >
        <Plus aria-hidden="true" size={15} />
        <Kbd>]</Kbd>
      </button>
    </div>
  );
}

export function ReaderPane({
  article,
  fontSize,
  onBack,
  onPrevious,
  onNext,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onRetryExtraction,
  onFontDecrease,
  onFontIncrease,
}: {
  article: Article | null;
  fontSize: number;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onRetryExtraction: (article: Article) => void;
  onFontDecrease: () => void;
  onFontIncrease: () => void;
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
          fontSize={fontSize}
          onPrevious={onPrevious}
          onNext={onNext}
          onMarkUnread={onMarkUnread}
          onToggleStar={onToggleStar}
          onCopy={onCopy}
          onFontDecrease={onFontDecrease}
          onFontIncrease={onFontIncrease}
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
        {article.author ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{article.author}</span>
          </>
        ) : null}
      </div>
      <h2 id={id}>{article.title}</h2>
      <div className="article-source-status">
        {article.contentSource === "article" ? (
          <span>
            <CheckCircle2 aria-hidden="true" size={14} /> Full text extracted
          </span>
        ) : article.contentSource === "feed" ? (
          <span>
            <Rss aria-hidden="true" size={14} /> Feed content
          </span>
        ) : null}
        {article.url ? (
          <a href={article.url} target="_blank" rel="noreferrer">
            View source
            <span className="sr-only"> in a new tab</span>
          </a>
        ) : null}
      </div>
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
  if (article.extractionStatus === "pending" || article.extractionStatus === "processing") {
    return (
      <div className="article-extraction-state" role="status">
        <LoaderCircle className="spin" aria-hidden="true" size={18} />
        <div>
          <strong>Extracting full text</strong>
          <p>The feed summary is shown while the complete article is prepared.</p>
        </div>
        {article.summary ? <p className="article-summary-fallback">{article.summary}</p> : null}
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
        {article.summary ? <p className="article-summary-fallback">{article.summary}</p> : null}
      </div>
    );
  }
  return article.summary ? (
    <div className="article-content">
      <p>{article.summary}</p>
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
  hasMore,
  loadingMore,
  onLoadMore,
  fontSize,
  onActivate,
  onMarkUnread,
  onToggleStar,
  onCopy,
  onRetryExtraction,
  onFontDecrease,
  onFontIncrease,
}: {
  articles: Article[];
  activeId: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  fontSize: number;
  onActivate: (article: Article, openMobile?: boolean) => void;
  onMarkUnread: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onRetryExtraction: (article: Article) => void;
  onFontDecrease: () => void;
  onFontIncrease: () => void;
}) {
  return (
    <section className="expanded-stream" aria-label="Expanded articles">
      {articles.map((article) => (
        <article
          className={`expanded-article${article.id === activeId ? " is-active" : ""}${article.isRead ? " is-read" : ""}`}
          key={article.id}
          aria-labelledby={`expanded-${article.id}-title`}
          onFocus={() => onActivate(article, false)}
        >
          <div className="expanded-actions">
            <ArticleActions
              article={article}
              fontSize={fontSize}
              onMarkUnread={onMarkUnread}
              onToggleStar={onToggleStar}
              onCopy={onCopy}
              onFontDecrease={onFontDecrease}
              onFontIncrease={onFontIncrease}
            />
          </div>
          <div className="article-document">
            <ArticleHeader article={article} id={`expanded-${article.id}-title`} />
            <ArticleBody article={article} onRetryExtraction={onRetryExtraction} />
          </div>
        </article>
      ))}
      {hasMore ? (
        <div className="form-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            {loadingMore ? "Loading older articles" : "Load older articles"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
