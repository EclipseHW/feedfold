import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Folder as FolderIcon,
  FolderPlus,
  Globe2,
  ListFilter,
  LoaderCircle,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  BootstrapData,
  Feed,
  FeedPreview,
  Folder,
  FolderSortDirection,
  WebFeedAnalysis,
  WebPageFeedDiscovery,
} from "../../shared/types";
import { api, errorMessage } from "../api";
import type { ReaderDataMutations } from "../data-resource";
import {
  type FeedStatusFilter,
  type FeedTypeFilter,
  filterFeeds,
  visibleFeedStatus,
} from "../feed-filters";
import { type MotionState, useMotionPresence } from "../motion";
import { WebFeedSetup } from "../web-feed-setup";
import { ExportOpmlLink, formatDate, ImportOpmlButton, PageHeader } from "./shared";
import "./feeds.css";

type FeedsPageTab = "subscriptions" | "folders";

function handleFeedsTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : event.key === "ArrowRight"
          ? (Math.max(currentIndex, 0) + 1) % tabs.length
          : (currentIndex <= 0 ? tabs.length : currentIndex) - 1;

  event.preventDefault();
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

function formatPreviewDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function feedHost(value: string): string {
  return new URL(value).hostname.replace(/^www\./, "");
}

export function FeedsPage({
  bootstrap,
  addFeedSourceUrl,
  mutations,
  onMenu,
  onRefresh,
  onEditWebFeed,
  onCloseAddFeedRoute,
  showToast,
}: {
  bootstrap: BootstrapData;
  addFeedSourceUrl: string | null;
  mutations: ReaderDataMutations;
  onMenu: () => void;
  onRefresh: (feedId: number) => void;
  onEditWebFeed: (feed: Feed) => void;
  onCloseAddFeedRoute: () => void;
  showToast: (message: string) => void;
}) {
  const [addFeedOpen, setAddFeedOpen] = useState(
    addFeedSourceUrl !== null || bootstrap.feeds.length === 0,
  );
  const [addFeedSession, setAddFeedSession] = useState(0);
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<FeedsPageTab>("subscriptions");
  const [feedTypeFilter, setFeedTypeFilter] = useState<FeedTypeFilter>("all");
  const [feedStatusFilter, setFeedStatusFilter] = useState<FeedStatusFilter>("all");
  const addFeedPresence = useMotionPresence(addFeedOpen);
  const addFeedTriggerRef = useRef<HTMLButtonElement>(null);
  const previousAddFeedSourceUrl = useRef(addFeedSourceUrl);
  const filteredFeeds = filterFeeds(bootstrap.feeds, feedTypeFilter, feedStatusFilter);
  const filtersActive = feedTypeFilter !== "all" || feedStatusFilter !== "all";
  const publishedFeedCount = bootstrap.feeds.filter(
    (feed) => feed.sourceKind === "published",
  ).length;
  const webFeedCount = bootstrap.feeds.length - publishedFeedCount;
  const statusCounts: Record<Exclude<FeedStatusFilter, "all">, number> = {
    healthy: 0,
    needs_attention: 0,
    paused: 0,
    refreshing: 0,
  };
  for (const feed of bootstrap.feeds) statusCounts[visibleFeedStatus(feed)] += 1;

  useEffect(() => {
    const previousSourceUrl = previousAddFeedSourceUrl.current;
    previousAddFeedSourceUrl.current = addFeedSourceUrl;
    if (addFeedSourceUrl !== null) {
      setActiveTab("subscriptions");
      setAddFeedOpen(true);
    } else if (previousSourceUrl !== null) {
      setAddFeedOpen(false);
    }
  }, [addFeedSourceUrl]);

  const closeAddFeed = () => {
    addFeedTriggerRef.current?.focus();
    setAddFeedOpen(false);
    if (addFeedSourceUrl !== null) onCloseAddFeedRoute();
  };

  const selectTab = (tab: FeedsPageTab) => {
    if (tab === activeTab) return;
    if (tab === "folders" && addFeedOpen) {
      setAddFeedOpen(false);
      if (addFeedSourceUrl !== null) onCloseAddFeedRoute();
    }
    if (tab === "subscriptions" && addFolderOpen) setAddFolderOpen(false);
    setActiveTab(tab);
  };

  const clearFeedFilters = () => {
    setFeedTypeFilter("all");
    setFeedStatusFilter("all");
  };

  return (
    <div className="management-page">
      <PageHeader
        title="Manage feeds"
        description="Add feeds, organize folders, and resolve refresh problems."
        onMenu={onMenu}
        actions={
          activeTab === "subscriptions" ? (
            <>
              <ImportOpmlButton mutations={mutations} showToast={showToast} />
              <ExportOpmlLink />
              <button
                ref={addFeedTriggerRef}
                className="primary-button"
                type="button"
                onClick={() => {
                  if (addFeedOpen) {
                    closeAddFeed();
                    return;
                  }
                  setAddFeedSession((current) => current + 1);
                  setAddFeedOpen(true);
                }}
              >
                <Plus aria-hidden="true" size={16} />
                Add feed
              </button>
            </>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={() => setAddFolderOpen((current) => !current)}
            >
              <FolderPlus aria-hidden="true" size={16} />
              Add folder
            </button>
          )
        }
      />

      <div className="management-tabs-shell">
        <div
          className="management-tabs"
          role="tablist"
          aria-label="Feed management"
          onKeyDown={handleFeedsTabKeyDown}
        >
          <button
            id="subscriptions-tab"
            type="button"
            role="tab"
            aria-controls="subscriptions-panel"
            aria-selected={activeTab === "subscriptions"}
            tabIndex={activeTab === "subscriptions" ? 0 : -1}
            onClick={() => selectTab("subscriptions")}
          >
            <Rss aria-hidden="true" size={15} />
            Subscriptions
            <span className="management-tab-count">{bootstrap.feeds.length}</span>
          </button>
          <button
            id="folders-tab"
            type="button"
            role="tab"
            aria-controls="folders-panel"
            aria-selected={activeTab === "folders"}
            tabIndex={activeTab === "folders" ? 0 : -1}
            onClick={() => selectTab("folders")}
          >
            <FolderIcon aria-hidden="true" size={15} />
            Folders
            <span className="management-tab-count">{bootstrap.folders.length}</span>
          </button>
        </div>
      </div>

      {activeTab === "subscriptions" ? (
        <div
          id="subscriptions-panel"
          role="tabpanel"
          aria-labelledby="subscriptions-tab"
          className="management-tab-panel"
        >
          {addFeedPresence.present ? (
            <AddFeedForm
              key={`${addFeedSession}:${addFeedSourceUrl ?? ""}`}
              feeds={bootstrap.feeds}
              folders={bootstrap.folders}
              initialSourceUrl={addFeedSourceUrl ?? ""}
              motionState={addFeedPresence.state}
              mutations={mutations}
              onCancel={closeAddFeed}
              onSaved={(feed) => {
                showToast(`Subscribed to ${feed.title}`);
                closeAddFeed();
              }}
            />
          ) : null}

          <section className="management-section" aria-labelledby="subscriptions-heading">
            <div className="section-title-row">
              <div>
                <h2 id="subscriptions-heading">Feeds</h2>
                <p>Check refresh status and repair feeds that need attention.</p>
              </div>
              <p className="feed-result-count" aria-live="polite">
                {filtersActive ? (
                  <>
                    Showing <strong>{filteredFeeds.length}</strong> of {bootstrap.feeds.length}
                  </>
                ) : (
                  <>
                    <strong>{bootstrap.feeds.length}</strong>{" "}
                    {bootstrap.feeds.length === 1 ? "feed" : "feeds"}
                  </>
                )}
              </p>
            </div>

            {bootstrap.feeds.length > 0 ? (
              <fieldset className="feed-filter-bar">
                <legend className="sr-only">Filter subscriptions</legend>
                <div className="feed-filter-controls">
                  <label className="feed-filter-field">
                    <span>Type</span>
                    <select
                      value={feedTypeFilter}
                      onChange={(event) => setFeedTypeFilter(event.target.value as FeedTypeFilter)}
                    >
                      <option value="all">All types ({bootstrap.feeds.length})</option>
                      <option value="published">Published feeds ({publishedFeedCount})</option>
                      <option value="web">Web feeds ({webFeedCount})</option>
                    </select>
                  </label>
                  <label className="feed-filter-field">
                    <span>Status</span>
                    <select
                      value={feedStatusFilter}
                      onChange={(event) =>
                        setFeedStatusFilter(event.target.value as FeedStatusFilter)
                      }
                    >
                      <option value="all">All statuses ({bootstrap.feeds.length})</option>
                      <option value="healthy">Healthy ({statusCounts.healthy})</option>
                      <option value="needs_attention">
                        Needs attention ({statusCounts.needs_attention})
                      </option>
                      <option value="paused">Paused ({statusCounts.paused})</option>
                      <option value="refreshing">Refreshing ({statusCounts.refreshing})</option>
                    </select>
                  </label>
                </div>
                {filtersActive ? (
                  <button
                    className="quiet-button feed-filter-clear"
                    type="button"
                    onClick={clearFeedFilters}
                  >
                    <X aria-hidden="true" size={14} />
                    Clear filters
                  </button>
                ) : (
                  <span className="feed-filter-hint">Filter by type and status.</span>
                )}
              </fieldset>
            ) : null}

            {bootstrap.feeds.length === 0 ? (
              <div className="section-empty">
                <Rss aria-hidden="true" size={22} />
                <h3>No feeds yet</h3>
                <p>Add a website or feed URL, or import subscriptions from an OPML file.</p>
              </div>
            ) : filteredFeeds.length === 0 ? (
              <div className="section-empty filtered-empty">
                <ListFilter aria-hidden="true" size={22} />
                <h3>No feeds match these filters</h3>
                <p>Change a filter, or clear both filters to show every feed.</p>
                <button className="secondary-button" type="button" onClick={clearFeedFilters}>
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="data-table feed-table">
                  <thead>
                    <tr>
                      <th scope="col">Feed</th>
                      <th scope="col">Folder</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last success</th>
                      <th scope="col">Unread</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFeeds.map((feed) => (
                      <FeedRow
                        key={feed.id}
                        feed={feed}
                        folders={bootstrap.folders}
                        mutations={mutations}
                        onRefresh={() => onRefresh(feed.id)}
                        onEditSelection={() => onEditWebFeed(feed)}
                        showToast={showToast}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : (
        <section
          id="folders-panel"
          role="tabpanel"
          aria-labelledby="folders-tab"
          className="management-section management-tab-panel"
        >
          <div className="section-title-row">
            <div>
              <h2 id="folders-heading">Folders</h2>
              <p>Group feeds, nest folders, and choose the article order.</p>
            </div>
            <p className="feed-result-count">
              <strong>{bootstrap.folders.length}</strong>{" "}
              {bootstrap.folders.length === 1 ? "folder" : "folders"}
            </p>
          </div>
          {addFolderOpen ? (
            <FolderForm
              folders={bootstrap.folders}
              mutations={mutations}
              onCancel={() => setAddFolderOpen(false)}
              onSaved={(folder) => {
                showToast(`Created ${folder.name}`);
                setAddFolderOpen(false);
              }}
              showToast={showToast}
            />
          ) : null}
          {bootstrap.folders.length === 0 ? (
            <div className="section-empty">
              <FolderIcon aria-hidden="true" size={22} />
              <h3>No folders yet</h3>
              <p>Create a folder to group feeds. Until then, feeds remain at the top level.</p>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setAddFolderOpen(true)}
              >
                <FolderPlus aria-hidden="true" size={16} />
                Add folder
              </button>
            </div>
          ) : (
            <ul className="folder-management-list">
              {bootstrap.folders.map((folder) => (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  folders={bootstrap.folders}
                  feedCount={bootstrap.feeds.filter((feed) => feed.folderId === folder.id).length}
                  mutations={mutations}
                  showToast={showToast}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function FeedConfirmationSettings({
  title,
  folderId,
  folders,
  disabled,
  onTitleChange,
  onFolderChange,
}: {
  title: string;
  folderId: number | null;
  folders: Folder[];
  disabled: boolean;
  onTitleChange: (title: string) => void;
  onFolderChange: (folderId: number | null) => void;
}) {
  return (
    <div className="feed-confirmation-settings">
      <label className="field">
        <span>Name</span>
        <input
          value={title}
          disabled={disabled}
          onChange={(event) => onTitleChange(event.target.value)}
        />
        <small>Use the detected name, or enter a name of your own.</small>
      </label>
      <label className="field">
        <span>Folder</span>
        <select
          value={folderId ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onFolderChange(event.target.value ? Number(event.target.value) : null)
          }
        >
          <option value="">No folder</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function AddFeedForm({
  feeds,
  folders,
  initialSourceUrl,
  motionState,
  mutations,
  onCancel,
  onSaved,
}: {
  feeds: Feed[];
  folders: Folder[];
  initialSourceUrl: string;
  motionState: MotionState;
  mutations: ReaderDataMutations;
  onCancel: () => void;
  onSaved: (feed: Feed) => Promise<void> | void;
}) {
  const [sourceUrl, setSourceUrl] = useState(initialSourceUrl);
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [webPage, setWebPage] = useState<WebPageFeedDiscovery | null>(null);
  const [webAnalysis, setWebAnalysis] = useState<WebFeedAnalysis | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState<number | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [analyzingWebPage, setAnalyzingWebPage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const previewFocusFrame = useRef<number | null>(null);
  const autoDiscoveryStarted = useRef(false);
  const motionStateRef = useRef(motionState);
  const loadingPresence = useMotionPresence(discovering || analyzingWebPage);
  const previewPresence = useMotionPresence(preview !== null);
  const retainedPreview = useRef<FeedPreview | null>(preview);
  motionStateRef.current = motionState;
  if (preview) retainedPreview.current = preview;
  const displayedPreview = preview ?? retainedPreview.current;
  const showLoadingSurface = loadingPresence.present && error === null;
  const showPreviewSurface = previewPresence.present && displayedPreview !== null && error === null;
  const selectedCandidate =
    webAnalysis?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const currentSourceUrl = preview?.feedUrl ?? webAnalysis?.pageUrl ?? webPage?.pageUrl;
  const existingFeed = currentSourceUrl
    ? feeds.find((feed) => feed.feedUrl === currentSourceUrl)
    : undefined;

  useEffect(
    () => () => {
      if (previewFocusFrame.current !== null) {
        window.cancelAnimationFrame(previewFocusFrame.current);
      }
    },
    [],
  );

  const discover = useCallback(async (url: string) => {
    if (previewFocusFrame.current !== null) {
      window.cancelAnimationFrame(previewFocusFrame.current);
      previewFocusFrame.current = null;
    }
    setDiscovering(true);
    setError(null);
    setPreview(null);
    setWebPage(null);
    setWebAnalysis(null);
    setSelectedCandidateId(null);
    try {
      const result = await api.discoverFeed(url);
      if (result.kind === "published") {
        setPreview(result.preview);
        setTitle(result.preview.title);
      } else {
        setWebPage(result);
        setTitle(result.title);
      }
      previewFocusFrame.current = window.requestAnimationFrame(() => {
        previewFocusFrame.current = null;
        if (motionStateRef.current === "open") previewHeadingRef.current?.focus();
      });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    if (!initialSourceUrl || autoDiscoveryStarted.current) return;
    autoDiscoveryStarted.current = true;
    void discover(initialSourceUrl.trim());
  }, [discover, initialSourceUrl]);

  const analyzeWebPage = async () => {
    if (!webPage) return;
    setAnalyzingWebPage(true);
    setError(null);
    try {
      const result = await api.analyzeWebPage(webPage.pageUrl);
      setWebAnalysis(result);
      setSelectedCandidateId(result.selectedCandidateId ?? result.suggestedCandidateIds[0] ?? null);
      setTitle(result.title);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setAnalyzingWebPage(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if ((!preview && !selectedCandidate) || existingFeed) return;
    setSaving(true);
    setError(null);
    try {
      const feed = preview
        ? await mutations.createFeed({
            title: title.trim() || preview.title,
            feedUrl: preview.feedUrl,
            siteUrl: preview.siteUrl,
            folderId,
            sourceKind: "published",
          })
        : selectedCandidate
          ? await mutations.createFeed({
              title: title.trim() || webAnalysis?.title,
              feedUrl: selectedCandidate.config.pageUrl,
              siteUrl: selectedCandidate.config.pageUrl,
              folderId,
              sourceKind: "web",
              webConfig: selectedCandidate.config,
            })
          : null;
      if (!feed) return;
      await onSaved(feed);
    } catch (error) {
      setError(`Could not add this feed. ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="inline-editor add-feed-panel"
      data-motion-state={motionState}
      aria-busy={discovering || analyzingWebPage || saving}
      inert={motionState === "closed"}
    >
      <div className="inline-editor-heading">
        <div>
          <h2>Add a feed</h2>
          <p>Enter a website or feed URL. Review the entries before you subscribe.</p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onCancel}
          disabled={saving}
          aria-label="Close add feed form"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>

      <form
        className="feed-discovery-form"
        onSubmit={(event) => {
          event.preventDefault();
          void discover(sourceUrl.trim());
        }}
      >
        <label className="field feed-url-field">
          <span>Website or feed URL</span>
          <input
            type="url"
            required
            value={sourceUrl}
            placeholder="https://example.com/articles"
            disabled={discovering || analyzingWebPage || saving}
            aria-describedby="feed-url-help"
            onChange={(event) => {
              setSourceUrl(event.target.value);
              setPreview(null);
              setWebPage(null);
              setWebAnalysis(null);
              setSelectedCandidateId(null);
              setTitle("");
              setError(null);
            }}
          />
          <small id="feed-url-help">
            echovale checks the page for RSS, Atom, and JSON Feed links.
          </small>
        </label>
        <button
          className={preview || webPage ? "secondary-button" : "primary-button"}
          type="submit"
          disabled={discovering || analyzingWebPage || saving || !sourceUrl.trim()}
        >
          {discovering ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Search aria-hidden="true" size={16} />
          )}
          {discovering ? "Checking URL" : preview || webPage ? "Check again" : "Check URL"}
        </button>
      </form>

      {error ? (
        <div className="feed-discovery-error" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>{error}</span>
        </div>
      ) : null}

      {webPage && !webAnalysis && !analyzingWebPage ? (
        <section className="web-feed-offer" aria-labelledby="web-feed-offer-heading">
          <div className="web-feed-offer-mark" aria-hidden="true">
            <Globe2 size={20} />
          </div>
          <div>
            <h3 id="web-feed-offer-heading" ref={previewHeadingRef} tabIndex={-1}>
              This page has no published feed
            </h3>
            <p>echovale can turn repeated entries on this public page into a web feed.</p>
            <small>
              Web feeds support one public page. They do not support sign-ins, paywalls, CAPTCHAs,
              pagination, or arbitrary change tracking.
            </small>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={saving}
            onClick={() => void analyzeWebPage()}
          >
            <Globe2 aria-hidden="true" size={16} />
            Create web feed
          </button>
        </section>
      ) : null}

      {showLoadingSurface || showPreviewSurface ? (
        <div className="feed-discovery-result">
          {showLoadingSurface ? (
            <div
              className="feed-preview-loading"
              data-motion-state={loadingPresence.state}
              role="status"
              inert={loadingPresence.state === "closed"}
            >
              <span>
                {analyzingWebPage
                  ? "Loading the page and finding repeated entries…"
                  : "Looking for a published feed and loading its latest entries…"}
              </span>
              <div className="feed-preview-loading-lines" aria-hidden="true">
                <div className="skeleton-line wide" />
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
              </div>
            </div>
          ) : null}

          {showPreviewSurface ? (
            <form
              className="feed-confirmation-form"
              data-motion-state={previewPresence.state}
              inert={previewPresence.state === "closed"}
              onSubmit={(event) => void save(event)}
            >
              <section className="feed-preview" aria-labelledby="feed-preview-heading">
                <div className="feed-preview-header">
                  <div className="feed-preview-mark" aria-hidden="true">
                    <Rss size={20} />
                  </div>
                  <div className="feed-preview-title-copy">
                    <h3 id="feed-preview-heading" ref={previewHeadingRef} tabIndex={-1}>
                      {displayedPreview.title}
                    </h3>
                    <div className="feed-preview-links">
                      {displayedPreview.siteUrl ? (
                        <a href={displayedPreview.siteUrl} target="_blank" rel="noreferrer">
                          {feedHost(displayedPreview.siteUrl)}
                          <ExternalLink aria-hidden="true" size={12} />
                        </a>
                      ) : (
                        <span>{feedHost(displayedPreview.feedUrl)}</span>
                      )}
                      <span aria-hidden="true">·</span>
                      <a href={displayedPreview.feedUrl} target="_blank" rel="noreferrer">
                        Open feed source
                        <ExternalLink aria-hidden="true" size={12} />
                      </a>
                    </div>
                  </div>
                  <span className="feed-found-badge">
                    <CheckCircle2 aria-hidden="true" size={14} />
                    Published feed found
                  </span>
                </div>

                <div className="feed-preview-list-heading">
                  <h4>Recent entries</h4>
                  <span>
                    {displayedPreview.totalArticles}{" "}
                    {displayedPreview.totalArticles === 1 ? "entry" : "entries"} in this feed
                  </span>
                </div>
                {displayedPreview.articles.length > 0 ? (
                  <ol className="feed-preview-articles">
                    {displayedPreview.articles.map((article) => (
                      <li
                        className={
                          article.imageUrl
                            ? "feed-preview-article has-image"
                            : "feed-preview-article"
                        }
                        key={`${article.url ?? ""}\u0000${article.publishedAt ?? ""}\u0000${article.title}`}
                      >
                        {article.imageUrl ? (
                          <img src={article.imageUrl} alt="" loading="lazy" />
                        ) : null}
                        <div>
                          {article.url ? (
                            <a
                              className="feed-preview-article-title"
                              href={article.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {article.title || article.summary || "Untitled article"}
                              <ExternalLink aria-hidden="true" size={12} />
                            </a>
                          ) : (
                            <strong className="feed-preview-article-title">
                              {article.title || article.summary || "Untitled article"}
                            </strong>
                          )}
                          {article.author || article.publishedAt ? (
                            <div className="feed-preview-article-meta">
                              {article.author ? <span>{article.author}</span> : null}
                              {article.author && article.publishedAt ? (
                                <span aria-hidden="true">·</span>
                              ) : null}
                              {article.publishedAt ? (
                                <time dateTime={article.publishedAt}>
                                  {formatPreviewDate(article.publishedAt)}
                                </time>
                              ) : null}
                            </div>
                          ) : null}
                          {article.summary ? <p>{article.summary}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="feed-preview-empty">This feed has no entries to preview.</p>
                )}
              </section>

              <FeedConfirmationSettings
                title={title}
                folderId={folderId}
                folders={folders}
                disabled={saving}
                onTitleChange={setTitle}
                onFolderChange={setFolderId}
              />

              {existingFeed ? (
                <p className="feed-existing-notice" role="status">
                  <CheckCircle2 aria-hidden="true" size={16} />
                  You already follow this feed as <strong>{existingFeed.title}</strong>.
                </p>
              ) : null}

              <div className="form-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onCancel}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={saving || !!existingFeed}
                >
                  {saving ? (
                    <LoaderCircle className="spin" aria-hidden="true" size={16} />
                  ) : existingFeed ? (
                    <Check aria-hidden="true" size={16} />
                  ) : (
                    <Plus aria-hidden="true" size={16} />
                  )}
                  {saving ? "Adding feed" : existingFeed ? "Already added" : "Add feed"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {webAnalysis ? (
        <form className="web-feed-confirmation-form" onSubmit={(event) => void save(event)}>
          <WebFeedSetup
            analysis={webAnalysis}
            selectedCandidateId={selectedCandidateId}
            disabled={saving}
            busyLabel="Adding web feed…"
            onSelect={setSelectedCandidateId}
            onBack={() => {
              setWebAnalysis(null);
              setSelectedCandidateId(null);
            }}
          />

          {selectedCandidate && !selectedCandidate.availableFields.includes("date") ? (
            <p className="web-feed-date-fallback">
              These entries have no publication date. echovale will use the time it first discovers
              each one.
            </p>
          ) : null}

          <FeedConfirmationSettings
            title={title}
            folderId={folderId}
            folders={folders}
            disabled={saving}
            onTitleChange={setTitle}
            onFolderChange={setFolderId}
          />

          {existingFeed ? (
            <p className="feed-existing-notice" role="status">
              <CheckCircle2 aria-hidden="true" size={16} />
              You already follow this feed as <strong>{existingFeed.title}</strong>.
            </p>
          ) : null}

          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={saving || !selectedCandidate || !!existingFeed}
            >
              {saving ? (
                <LoaderCircle className="spin" aria-hidden="true" size={16} />
              ) : existingFeed ? (
                <Check aria-hidden="true" size={16} />
              ) : (
                <Plus aria-hidden="true" size={16} />
              )}
              {saving ? "Adding web feed" : existingFeed ? "Already added" : "Add web feed"}
            </button>
          </div>
        </form>
      ) : null}

      {!previewPresence.present && !webAnalysis ? (
        <div className="form-actions add-feed-initial-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

function feedFailureLabel(feed: Feed): string {
  if (feed.lastErrorKind === "selection_broken") return "Page changed";
  if (feed.lastErrorKind === "javascript_timeout") return "JavaScript timed out";
  if (feed.lastErrorKind === "inaccessible") return "Page inaccessible";
  if (feed.lastErrorKind === "access_blocked") return "Access blocked";
  if (feed.lastErrorKind === "unsupported_content") return "Unsupported page";
  if (feed.lastErrorKind === "timeout") return "Loading timed out";
  if (feed.lastHttpStatus) return `HTTP ${feed.lastHttpStatus}`;
  return "Refresh failed";
}

function FeedRow({
  feed,
  folders,
  mutations,
  onRefresh,
  onEditSelection,
  showToast,
}: {
  feed: Feed;
  folders: Folder[];
  mutations: ReaderDataMutations;
  onRefresh: () => void;
  onEditSelection: () => void;
  showToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(feed.title);
  const [feedUrl, setFeedUrl] = useState(feed.feedUrl);
  const [folderId, setFolderId] = useState<number | null>(feed.folderId);
  const [busy, setBusy] = useState(false);
  const folder = folders.find((candidate) => candidate.id === feed.folderId);

  const save = async () => {
    setBusy(true);
    try {
      await mutations.updateFeed(
        feed.id,
        feed.sourceKind === "web"
          ? { title: title.trim(), folderId }
          : { title: title.trim(), feedUrl: feedUrl.trim(), folderId },
      );
      showToast(`Saved ${title.trim()}`);
      setEditing(false);
    } catch (error) {
      showToast(`Could not save ${feed.title}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const togglePaused = async () => {
    setBusy(true);
    try {
      await mutations.updateFeed(feed.id, { paused: !feed.paused });
      showToast(feed.paused ? `Resumed ${feed.title}` : `Paused ${feed.title}`);
    } catch (error) {
      showToast(`Could not update ${feed.title}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Unsubscribe from “${feed.title}” and delete its stored articles?`)) return;
    setBusy(true);
    try {
      await mutations.deleteFeed(feed.id);
      showToast(`Unsubscribed from ${feed.title}`);
    } catch (error) {
      showToast(`Could not unsubscribe from ${feed.title}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <tr className="editing-row">
        <td colSpan={6}>
          <div className="table-inline-form">
            <label className="field">
              <span>Name</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="field wide-field">
              <span>{feed.sourceKind === "web" ? "Page URL" : "Feed URL"}</span>
              <input
                type="url"
                value={feedUrl}
                readOnly={feed.sourceKind === "web"}
                onChange={(event) => setFeedUrl(event.target.value)}
              />
              {feed.sourceKind === "web" ? (
                <small>
                  To change this URL, use Edit page selection so the saved entry group stays valid.
                </small>
              ) : null}
            </label>
            <label className="field">
              <span>Folder</span>
              <select
                value={folderId ?? ""}
                onChange={(event) =>
                  setFolderId(event.target.value ? Number(event.target.value) : null)
                }
              >
                <option value="">No folder</option>
                {folders.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button className="secondary-button" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy || !title.trim() || !feedUrl.trim()}
                onClick={() => void save()}
              >
                {busy ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : (
                  <Check aria-hidden="true" size={15} />
                )}
                Save feed
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td data-label="Feed">
        <div className="feed-cell">
          <span
            className={`status-dot ${
              feed.healthStatus !== "healthy" ? "failed" : feed.paused ? "paused" : "healthy"
            }`}
          />
          <div>
            <div className="feed-title-row">
              <strong>{feed.title}</strong>
              <span className="feed-type-badge">
                {feed.sourceKind === "web" ? "Web" : "Published"}
              </span>
            </div>
            <a href={feed.siteUrl ?? feed.feedUrl} target="_blank" rel="noreferrer">
              {feed.feedUrl}
            </a>
          </div>
        </div>
      </td>
      <td data-label="Folder">{folder?.name ?? <span className="muted">Top level</span>}</td>
      <td data-label="Status">
        {feed.healthStatus !== "healthy" ? (
          <div className="feed-status-actions">
            <span className="feed-status failed-status" title={feed.lastError ?? undefined}>
              <AlertTriangle aria-hidden="true" size={14} />
              {feedFailureLabel(feed)}
              {feed.lastError ? <small>{feed.lastError}</small> : null}
            </span>
            {feed.lastErrorKind === "selection_broken" ? (
              <button className="feed-repair-button" type="button" onClick={onEditSelection}>
                Repair selection
              </button>
            ) : null}
          </div>
        ) : feed.paused ? (
          <span className="feed-status">
            <Pause aria-hidden="true" size={14} />
            Paused
          </span>
        ) : feed.refreshing ? (
          <span className="feed-status">
            <LoaderCircle className="spin" aria-hidden="true" size={14} />
            Refreshing
          </span>
        ) : (
          <span className="feed-status">
            <CheckCircle2 aria-hidden="true" size={14} />
            Healthy
          </span>
        )}
      </td>
      <td data-label="Last success">
        <span className="date-cell">
          {formatDate(feed.lastSuccessAt)}
          {feed.lastAttemptAt ? <small>Attempt: {formatDate(feed.lastAttemptAt)}</small> : null}
        </span>
      </td>
      <td data-label="Unread">
        <span className="numeric-cell">{feed.unreadCount}</span>
      </td>
      <td className="row-actions">
        <button
          type="button"
          disabled={busy || feed.refreshing || feed.paused}
          onClick={onRefresh}
          aria-label={`Refresh ${feed.title}`}
          title="Refresh feed"
        >
          <RefreshCw className={feed.refreshing ? "spin" : ""} aria-hidden="true" size={15} />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing(true)}
          aria-label={`Edit ${feed.title}`}
          title="Edit feed"
        >
          <Edit3 aria-hidden="true" size={15} />
        </button>
        {feed.sourceKind === "web" ? (
          <button
            type="button"
            disabled={busy}
            onClick={onEditSelection}
            aria-label={`Edit page selection for ${feed.title}`}
            title="Edit page selection"
          >
            <MousePointer2 aria-hidden="true" size={15} />
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void togglePaused()}
          aria-label={feed.paused ? `Resume ${feed.title}` : `Pause ${feed.title}`}
          title={feed.paused ? "Resume feed" : "Pause feed"}
        >
          {feed.paused ? (
            <Play aria-hidden="true" size={15} />
          ) : (
            <Pause aria-hidden="true" size={15} />
          )}
        </button>
        <button
          className="danger-action"
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          aria-label={`Unsubscribe from ${feed.title}`}
          title="Unsubscribe from feed"
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </td>
    </tr>
  );
}

export function FolderForm({
  folders,
  initial,
  defaultParentId = null,
  mutations,
  onCancel,
  onSaved,
  showToast,
}: {
  folders: Folder[];
  initial?: Folder;
  defaultParentId?: number | null;
  mutations: ReaderDataMutations;
  onCancel: () => void;
  onSaved: (folder: Folder) => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parentId, setParentId] = useState<number | null>(initial?.parentId ?? defaultParentId);
  const [sortDirection, setSortDirection] = useState<FolderSortDirection>(
    initial?.sortDirection ?? "newest",
  );
  const [saving, setSaving] = useState(false);
  const unavailableParentIds = new Set(initial ? [initial.id] : []);
  if (initial) {
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const folder of folders) {
        if (
          folder.parentId !== null &&
          unavailableParentIds.has(folder.parentId) &&
          !unavailableParentIds.has(folder.id)
        ) {
          unavailableParentIds.add(folder.id);
          foundDescendant = true;
        }
      }
    }
  }
  const availableParents = folders.filter((folder) => !unavailableParentIds.has(folder.id));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const folder = initial
        ? await mutations.updateFolder(initial.id, { name: name.trim(), parentId, sortDirection })
        : await mutations.createFolder({ name: name.trim(), parentId, sortDirection });
      await onSaved(folder);
    } catch (error) {
      showToast(`Could not save the folder: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="compact-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        <span>Folder name</span>
        <input
          data-dialog-initial-focus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Parent folder</span>
        <select
          value={parentId ?? ""}
          onChange={(event) => setParentId(event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">No parent</option>
          {availableParents.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Article order</span>
        <select
          value={sortDirection}
          onChange={(event) => setSortDirection(event.target.value as FolderSortDirection)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-button" type="submit" disabled={saving || !name.trim()}>
          {saving ? (
            <LoaderCircle className="spin" aria-hidden="true" size={15} />
          ) : (
            <Check aria-hidden="true" size={15} />
          )}
          {initial ? "Save folder" : "Create folder"}
        </button>
      </div>
    </form>
  );
}

function FolderRow({
  folder,
  folders,
  feedCount,
  mutations,
  showToast,
}: {
  folder: Folder;
  folders: Folder[];
  feedCount: number;
  mutations: ReaderDataMutations;
  showToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const parent = folders.find((candidate) => candidate.id === folder.parentId);

  const remove = async () => {
    if (!window.confirm(`Delete folder “${folder.name}”? Its feeds will move to the top level.`))
      return;
    try {
      await mutations.deleteFolder(folder.id);
      showToast(`Deleted folder ${folder.name}`);
    } catch (error) {
      showToast(`Could not delete ${folder.name}: ${errorMessage(error)}`);
    }
  };

  return (
    <li>
      {editing ? (
        <FolderForm
          folders={folders}
          initial={folder}
          mutations={mutations}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            showToast(`Saved ${folder.name}`);
            setEditing(false);
          }}
          showToast={showToast}
        />
      ) : (
        <div className="folder-management-row">
          <div>
            <FolderPlus aria-hidden="true" size={16} />
            <span>
              <strong>{folder.name}</strong>
              <small>
                {feedCount} {feedCount === 1 ? "feed" : "feeds"}
                {parent ? ` · inside ${parent.name}` : ""}
                {` · ${folder.sortDirection === "oldest" ? "oldest" : "newest"} first`}
              </small>
            </span>
          </div>
          <span className="folder-unread">{folder.unreadCount} unread</span>
          <div className="row-actions">
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${folder.name}`}
            >
              <Edit3 aria-hidden="true" size={15} />
            </button>
            <button
              className="danger-action"
              type="button"
              onClick={() => void remove()}
              aria-label={`Delete ${folder.name}`}
            >
              <Trash2 aria-hidden="true" size={15} />
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export default FeedsPage;
