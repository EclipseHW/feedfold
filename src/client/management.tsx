import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  Folder as FolderIcon,
  FolderPlus,
  Globe2,
  Keyboard,
  ListFilter,
  LoaderCircle,
  Menu,
  MessageSquareText,
  Minus,
  Moon,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AI_PROMPT_MAX_LENGTH,
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
} from "../shared/ai-prompts";
import type {
  AiCustomPrompt,
  AiProvider,
  AiSettings,
  AppSettings,
  Article,
  BootstrapData,
  DuplicateArticleWindowDays,
  Feed,
  FeedPreview,
  Folder,
  FolderSortDirection,
  Rule,
  RuleAction,
  RuleCondition,
  RuleConditionOperator,
  RuleField,
  WebFeedAnalysis,
  WebPageFeedDiscovery,
} from "../shared/types";
import { DUPLICATE_ARTICLE_WINDOW_DAYS } from "../shared/types";
import { api, appUrl, errorMessage, type RuleInput } from "./api";
import {
  type FeedStatusFilter,
  type FeedTypeFilter,
  filterFeeds,
  visibleFeedStatus,
} from "./feed-filters";
import { type MotionState, useMotionPresence } from "./motion";
import { WebFeedSetup } from "./web-feed-setup";

type Theme = "dark" | "light";

const RULE_FIELD_LABELS: Record<RuleField, string> = {
  title: "Title",
  author: "Author",
  summary: "Summary",
  content: "Full content",
  media: "Media type",
  any: "Any text",
};

const RULE_ACTION_COPY: Record<
  RuleAction,
  { label: string; shortLabel: string; description: string }
> = {
  hide: {
    label: "Hide matching articles",
    shortLabel: "Hide matches",
    description: "Matching articles are hidden from article lists.",
  },
  keep: {
    label: "Keep only matching articles",
    shortLabel: "Keep only",
    description:
      "Articles stay visible when they match this or another enabled keep rule that applies here.",
  },
  mark_read: {
    label: "Mark matching articles as read",
    shortLabel: "Mark read",
    description: "Matching articles stay available without appearing as unread.",
  },
};

interface EditableRuleCondition extends RuleCondition {
  id: number;
}

export interface RuleFormDraft {
  id: number;
  name: string;
  article: Article;
  articleIndex: number;
  feedId: number;
  field: RuleField;
  pattern: string;
}

export interface RuleFormPreset {
  name?: string;
  feedId?: number;
  folderId?: number;
  field?: RuleField;
  pattern?: string;
}

export function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatRefreshInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function formatPreviewDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function feedHost(value: string): string {
  return new URL(value).hostname.replace(/^www\./, "");
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}

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

function PageHeader({
  title,
  description,
  onMenu,
  actions,
}: {
  title: string;
  description: string;
  onMenu: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <button
        className="icon-button menu-button"
        type="button"
        onClick={onMenu}
        aria-label="Open navigation"
      >
        <Menu aria-hidden="true" size={19} />
      </button>
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}

function ImportOpmlButton({
  onImported,
  showToast,
}: {
  onImported: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const result = await api.importOpml(file);
      const notes = [`${result.imported} imported`, `${result.duplicates} duplicates`];
      if (result.failed.length > 0) notes.push(`${result.failed.length} failed`);
      showToast(`OPML import complete: ${notes.join(", ")}`);
      await onImported();
    } catch (error) {
      showToast(`OPML import failed: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className="visually-hidden-input"
        type="file"
        accept=".opml,.xml,text/xml,application/xml"
        onChange={(event) => void importFile(event)}
      />
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <LoaderCircle className="spin" aria-hidden="true" size={16} />
        ) : (
          <Upload aria-hidden="true" size={16} />
        )}
        {busy ? "Importing" : "Import OPML"}
      </button>
    </>
  );
}

export function FeedsPage({
  bootstrap,
  addFeedSourceUrl,
  onMenu,
  onReload,
  onRefresh,
  onEditWebFeed,
  onCloseAddFeedRoute,
  showToast,
}: {
  bootstrap: BootstrapData;
  addFeedSourceUrl: string | null;
  onMenu: () => void;
  onReload: () => Promise<void> | void;
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
        title="Feeds & status"
        description="Review subscription health and organize sources."
        onMenu={onMenu}
        actions={
          activeTab === "subscriptions" ? (
            <>
              <ImportOpmlButton onImported={onReload} showToast={showToast} />
              <a
                className="secondary-button"
                href={appUrl("/api/opml/export")}
                download="echovale-subscriptions.opml"
              >
                <Download aria-hidden="true" size={16} />
                Export OPML
              </a>
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
          aria-label="Feeds and status"
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
              onCancel={closeAddFeed}
              onSaved={async (feed) => {
                showToast(`Added ${feed.title}`);
                closeAddFeed();
                await onReload();
              }}
            />
          ) : null}

          <section className="management-section" aria-labelledby="subscriptions-heading">
            <div className="section-title-row">
              <div>
                <h2 id="subscriptions-heading">Subscriptions</h2>
                <p>Monitor sources and act on feeds that need attention.</p>
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
                  <span className="feed-filter-hint">Combine filters to narrow the list.</span>
                )}
              </fieldset>
            ) : null}

            {bootstrap.feeds.length === 0 ? (
              <div className="section-empty">
                <Rss aria-hidden="true" size={22} />
                <h3>No subscriptions yet</h3>
                <p>Add a feed URL or import OPML from another reader.</p>
              </div>
            ) : filteredFeeds.length === 0 ? (
              <div className="section-empty filtered-empty">
                <ListFilter aria-hidden="true" size={22} />
                <h3>No feeds match these filters</h3>
                <p>Choose a different type or status to see more subscriptions.</p>
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
                        onReload={onReload}
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
              <h2 id="folders-heading">Folder configuration</h2>
              <p>Organize reading groups, nesting, and article order.</p>
            </div>
            <p className="feed-result-count">
              <strong>{bootstrap.folders.length}</strong>{" "}
              {bootstrap.folders.length === 1 ? "folder" : "folders"}
            </p>
          </div>
          {addFolderOpen ? (
            <FolderForm
              folders={bootstrap.folders}
              onCancel={() => setAddFolderOpen(false)}
              onSaved={async (folder) => {
                showToast(`Created ${folder.name}`);
                setAddFolderOpen(false);
                await onReload();
              }}
              showToast={showToast}
            />
          ) : null}
          {bootstrap.folders.length === 0 ? (
            <div className="section-empty">
              <FolderIcon aria-hidden="true" size={22} />
              <h3>No folders yet</h3>
              <p>Feeds stay at the top level until you create a reading group.</p>
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
                  onReload={onReload}
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
        <small>Keep the detected title or choose your own.</small>
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
  onCancel,
  onSaved,
}: {
  feeds: Feed[];
  folders: Folder[];
  initialSourceUrl: string;
  motionState: MotionState;
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
        ? await api.createFeed({
            title: title.trim() || preview.title,
            feedUrl: preview.feedUrl,
            siteUrl: preview.siteUrl,
            folderId,
            sourceKind: "published",
          })
        : selectedCandidate
          ? await api.createFeed({
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
      setError(`Could not add feed: ${errorMessage(error)}`);
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
          <p>Start with any page on the site. You can review the source before subscribing.</p>
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
            RSS, Atom, and JSON Feed links are detected automatically.
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
          {discovering ? "Finding feed" : preview || webPage ? "Check again" : "Find feed"}
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
              No published feed found
            </h3>
            <p>
              Echovale can look for repeated articles, releases, jobs, products, or announcements on
              this public page and turn them into a normal feed.
            </p>
            <small>
              The page will load with JavaScript. Sign-ins, paywalls, CAPTCHAs, pagination, and
              change tracking are not supported.
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
                  ? "Loading the webpage with JavaScript and finding repeated items…"
                  : "Looking for a published feed and loading recent entries…"}
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
                        Feed source
                        <ExternalLink aria-hidden="true" size={12} />
                      </a>
                    </div>
                  </div>
                  <span className="feed-found-badge">
                    <CheckCircle2 aria-hidden="true" size={14} />
                    Ready to add
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
                  <p className="feed-preview-empty">
                    This feed does not currently publish any entries.
                  </p>
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
                  Already subscribed as <strong>{existingFeed.title}</strong>.
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
            onSelect={setSelectedCandidateId}
            onBack={() => {
              setWebAnalysis(null);
              setSelectedCandidateId(null);
            }}
          />

          {selectedCandidate && !selectedCandidate.availableFields.includes("date") ? (
            <p className="web-feed-date-fallback">
              No publication date was found. New entries will use the time Echovale first discovers
              them.
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
              Already subscribed as <strong>{existingFeed.title}</strong>.
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
  onReload,
  onRefresh,
  onEditSelection,
  showToast,
}: {
  feed: Feed;
  folders: Folder[];
  onReload: () => Promise<void> | void;
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
      await api.updateFeed(
        feed.id,
        feed.sourceKind === "web"
          ? { title: title.trim(), folderId }
          : { title: title.trim(), feedUrl: feedUrl.trim(), folderId },
      );
      showToast(`Saved ${title.trim()}`);
      setEditing(false);
      await onReload();
    } catch (error) {
      showToast(`Could not save feed: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const togglePaused = async () => {
    setBusy(true);
    try {
      await api.updateFeed(feed.id, { paused: !feed.paused });
      showToast(feed.paused ? `Resumed ${feed.title}` : `Paused ${feed.title}`);
      await onReload();
    } catch (error) {
      showToast(`Could not update feed: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${feed.title}” and all of its articles?`)) return;
    setBusy(true);
    try {
      await api.deleteFeed(feed.id);
      showToast(`Deleted ${feed.title}`);
      await onReload();
    } catch (error) {
      showToast(`Could not delete feed: ${errorMessage(error)}`);
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
                  Change the page through Edit page selection so its saved match stays valid.
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
          aria-label={`Delete ${feed.title}`}
          title="Delete feed"
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
  onCancel,
  onSaved,
  showToast,
}: {
  folders: Folder[];
  initial?: Folder;
  defaultParentId?: number | null;
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
        ? await api.updateFolder(initial.id, { name: name.trim(), parentId, sortDirection })
        : await api.createFolder({ name: name.trim(), parentId, sortDirection });
      await onSaved(folder);
    } catch (error) {
      showToast(`Could not save folder: ${errorMessage(error)}`);
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
  onReload,
  showToast,
}: {
  folder: Folder;
  folders: Folder[];
  feedCount: number;
  onReload: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const parent = folders.find((candidate) => candidate.id === folder.parentId);

  const remove = async () => {
    if (
      !window.confirm(`Delete folder “${folder.name}”? Feeds inside it will move to the top level.`)
    )
      return;
    try {
      await api.deleteFolder(folder.id);
      showToast(`Deleted folder ${folder.name}`);
      await onReload();
    } catch (error) {
      showToast(`Could not delete folder: ${errorMessage(error)}`);
    }
  };

  return (
    <li>
      {editing ? (
        <FolderForm
          folders={folders}
          initial={folder}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            showToast(`Saved ${folder.name}`);
            setEditing(false);
            await onReload();
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

export function RulesPage({
  bootstrap,
  rules,
  loading,
  error,
  draft,
  onMenu,
  onClearDraft,
  onReturnToArticle,
  onReload,
  showToast,
}: {
  bootstrap: BootstrapData;
  rules: Rule[];
  loading: boolean;
  error: string | null;
  draft: RuleFormDraft | null;
  onMenu: () => void;
  onClearDraft: () => void;
  onReturnToArticle: (draft: RuleFormDraft) => void;
  onReload: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(draft !== null);
  const [formSession, setFormSession] = useState(0);
  const [editing, setEditing] = useState<Rule | null>(null);
  const formPresence = useMotionPresence(formOpen);
  const addRuleTriggerRef = useRef<HTMLButtonElement>(null);
  const ruleFormOpenerRef = useRef<HTMLButtonElement | null>(null);
  const retainedRuleForm = useRef<{ editing: Rule | null; draft: RuleFormDraft | null }>({
    editing,
    draft,
  });
  if (formOpen) retainedRuleForm.current = { editing, draft };
  const displayedEditing = formOpen ? editing : retainedRuleForm.current.editing;
  const displayedDraft = formOpen ? draft : retainedRuleForm.current.draft;

  return (
    <div className="management-page">
      <PageHeader
        title="Rules"
        description="Keep the articles you want, hide predictable noise, or mark matches read."
        onMenu={onMenu}
        actions={
          <button
            ref={addRuleTriggerRef}
            className="primary-button"
            type="button"
            onClick={(event) => {
              ruleFormOpenerRef.current = event.currentTarget;
              onClearDraft();
              setEditing(null);
              setFormSession((current) => current + 1);
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" size={16} />
            Add rule
          </button>
        }
      />

      {formPresence.present ? (
        <RuleForm
          key={`${
            displayedEditing
              ? `rule-${displayedEditing.id}`
              : displayedDraft
                ? `draft-${displayedDraft.id}`
                : "new-rule"
          }-${formSession}`}
          bootstrap={bootstrap}
          initial={displayedEditing ?? undefined}
          preset={displayedEditing ? undefined : (displayedDraft ?? undefined)}
          motionState={formPresence.state}
          onCancel={() => {
            const returnDraft = editing ? null : draft;
            onClearDraft();
            setFormOpen(false);
            if (returnDraft) {
              setEditing(null);
              onReturnToArticle(returnDraft);
              return;
            }
            ruleFormOpenerRef.current?.focus();
          }}
          onSaved={async (rule) => {
            const returnDraft = editing ? null : draft;
            showToast(editing ? `Saved ${rule.name}` : `Added ${rule.name}`);
            onClearDraft();
            setFormOpen(false);
            if (returnDraft) {
              setEditing(null);
              onReturnToArticle(returnDraft);
            } else {
              addRuleTriggerRef.current?.focus();
            }
            await onReload();
          }}
          showToast={showToast}
        />
      ) : null}

      <section className="management-section rules-section" aria-labelledby="active-rules-heading">
        <div className="section-title-row">
          <div>
            <h2 id="active-rules-heading">Your rules</h2>
            <p>Rules apply to existing articles immediately and new articles during refresh.</p>
          </div>
          <span className="rules-count">{rules.filter((rule) => rule.enabled).length} active</span>
        </div>

        {loading ? (
          <div className="rule-loading" aria-busy="true">
            {[0, 1, 2].map((key) => (
              <div className="skeleton-line" key={key} />
            ))}
          </div>
        ) : error ? (
          <div className="section-error" role="alert">
            <AlertTriangle aria-hidden="true" size={18} />
            <span>{error}</span>
            <button className="secondary-button" type="button" onClick={() => void onReload()}>
              Try again
            </button>
          </div>
        ) : rules.length === 0 ? (
          <div className="section-empty">
            <ListFilter aria-hidden="true" size={22} />
            <h3>No rules yet</h3>
            <p>Create a rule to keep, hide, or mark articles read.</p>
            <button
              className="secondary-button"
              type="button"
              onClick={(event) => {
                ruleFormOpenerRef.current = event.currentTarget;
                onClearDraft();
                setEditing(null);
                setFormSession((current) => current + 1);
                setFormOpen(true);
              }}
            >
              Create your first rule
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table rules-table">
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Conditions</th>
                  <th scope="col">Action</th>
                  <th scope="col">Matched</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    bootstrap={bootstrap}
                    onEdit={(trigger) => {
                      ruleFormOpenerRef.current = trigger;
                      onClearDraft();
                      setEditing(rule);
                      setFormSession((current) => current + 1);
                      setFormOpen(true);
                      window.scrollTo({ top: 0 });
                    }}
                    onReload={onReload}
                    showToast={showToast}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function RuleActionIcon({ action, size }: { action: RuleAction; size: number }) {
  if (action === "hide") return <EyeOff aria-hidden="true" size={size} />;
  if (action === "keep") return <ListFilter aria-hidden="true" size={size} />;
  return <CheckCircle2 aria-hidden="true" size={size} />;
}

export function RuleForm({
  bootstrap,
  initial,
  preset,
  motionState,
  onCancel,
  onSaved,
  showToast,
}: {
  bootstrap: BootstrapData;
  initial?: Rule;
  preset?: RuleFormPreset;
  motionState: MotionState;
  onCancel: () => void;
  onSaved: (rule: Rule) => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? preset?.name ?? "");
  const [scope, setScope] = useState(
    initial?.feedId
      ? `feed:${initial.feedId}`
      : initial?.folderId
        ? `folder:${initial.folderId}`
        : preset?.feedId
          ? `feed:${preset.feedId}`
          : preset?.folderId
            ? `folder:${preset.folderId}`
            : "all",
  );
  const nextConditionId = useRef(initial?.conditions.length ?? 1);
  const conditionInputRefs = useRef(new Map<number, HTMLInputElement>());
  const addConditionButtonRef = useRef<HTMLButtonElement>(null);
  const [conditions, setConditions] = useState<EditableRuleCondition[]>(() => {
    const values = initial?.conditions ?? [
      { field: preset?.field ?? "title", pattern: preset?.pattern ?? "" },
    ];
    return values.map((condition, id) => ({ ...condition, id }));
  });
  const [conditionOperator, setConditionOperator] = useState<RuleConditionOperator>(
    initial?.conditionOperator ?? "or",
  );
  const [action, setAction] = useState<RuleAction>(initial?.action ?? "hide");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const addCondition = () => {
    const id = nextConditionId.current;
    nextConditionId.current += 1;
    setConditions((current) => [
      ...current,
      {
        id,
        field: current[current.length - 1]?.field ?? "title",
        pattern: "",
      },
    ]);
    window.requestAnimationFrame(() => conditionInputRefs.current.get(id)?.focus());
  };

  const removeCondition = (id: number) => {
    const index = conditions.findIndex((condition) => condition.id === id);
    const focusId = conditions[index - 1]?.id ?? conditions[index + 1]?.id;
    setConditions((current) => current.filter((condition) => condition.id !== id));
    window.requestAnimationFrame(() => {
      if (focusId === undefined) addConditionButtonRef.current?.focus();
      else conditionInputRefs.current.get(focusId)?.focus();
      conditionInputRefs.current.delete(id);
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const [scopeType, rawId] = scope.split(":");
    const input: RuleInput = {
      name: name.trim(),
      feedId: scopeType === "feed" ? Number(rawId) : null,
      folderId: scopeType === "folder" ? Number(rawId) : null,
      conditions: conditions.map(({ field, pattern }) => ({ field, pattern: pattern.trim() })),
      conditionOperator,
      action,
      enabled,
    };
    setSaving(true);
    try {
      const rule = initial ? await api.updateRule(initial.id, input) : await api.createRule(input);
      await onSaved(rule);
    } catch (error) {
      showToast(`Could not save rule: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="inline-editor rule-form"
      data-motion-state={motionState}
      inert={motionState === "closed"}
      onSubmit={(event) => void submit(event)}
    >
      <div className="inline-editor-heading">
        <div>
          <h2>{initial ? "Edit rule" : preset?.pattern ? "Filter selected text" : "Add rule"}</h2>
          <p>Saving checks existing articles now and new articles during future refreshes.</p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onCancel}
          aria-label={preset?.pattern ? "Back to article" : "Close rule form"}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="rule-form-sections">
        <section className="rule-form-section" aria-labelledby="rule-basics-heading">
          <div className="rule-form-section-heading">
            <h3 id="rule-basics-heading">Basics</h3>
          </div>
          <div className="form-grid rule-basics-grid">
            <label className="field">
              <span>Rule name</span>
              <input
                data-dialog-initial-focus
                required
                value={name}
                placeholder="Skip weekly sponsor posts"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Apply to</span>
              <select value={scope} onChange={(event) => setScope(event.target.value)}>
                <option value="all">All feeds</option>
                <optgroup label="Folders">
                  {bootstrap.folders.map((folder) => (
                    <option key={folder.id} value={`folder:${folder.id}`}>
                      {folder.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Feeds">
                  {bootstrap.feeds.map((feed) => (
                    <option key={feed.id} value={`feed:${feed.id}`}>
                      {feed.title}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          </div>
        </section>

        <section className="rule-form-section" aria-labelledby="rule-conditions-heading">
          <div className="rule-form-section-heading">
            <h3 id="rule-conditions-heading">Conditions</h3>
            <p id="rule-conditions-description">
              Text matching ignores case. Choose whether every condition or any condition must
              match.
            </p>
          </div>
          <fieldset className="rule-condition-group" aria-describedby="rule-conditions-description">
            <legend className="sr-only">Article matching conditions</legend>
            <div className="rule-condition-columns" aria-hidden="true">
              <span>Logic</span>
              <span>Look in</span>
              <span>Match</span>
              <span>Value</span>
              <span />
            </div>
            <ol className="rule-condition-list">
              {conditions.map((condition, index) => {
                const fieldId = `rule-condition-field-${condition.id}`;
                const valueId = `rule-condition-value-${condition.id}`;
                const connector = conditionOperator === "and" ? "And" : "Or";
                return (
                  <li className="rule-condition-row" key={condition.id}>
                    {index === 0 ? (
                      <span className="rule-condition-connector">If</span>
                    ) : index === 1 ? (
                      <label className="rule-condition-operator">
                        <span className="sr-only">Join all conditions with</span>
                        <select
                          value={conditionOperator}
                          onChange={(event) =>
                            setConditionOperator(event.target.value as RuleConditionOperator)
                          }
                        >
                          <option value="and">And</option>
                          <option value="or">Or</option>
                        </select>
                      </label>
                    ) : (
                      <span className="rule-condition-connector">{connector}</span>
                    )}

                    <div className="rule-condition-control rule-condition-field-control">
                      <label className="sr-only" htmlFor={fieldId}>
                        Look in for condition {index + 1}
                      </label>
                      <select
                        id={fieldId}
                        value={condition.field}
                        onChange={(event) =>
                          setConditions((current) =>
                            current.map((item) =>
                              item.id === condition.id
                                ? { ...item, field: event.target.value as RuleField }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="title">Title</option>
                        <option value="author">Author</option>
                        <option value="summary">Summary</option>
                        <option value="content">Full content</option>
                        <option value="media">Media type</option>
                        <option value="any">Any text</option>
                      </select>
                    </div>

                    <span className="rule-condition-comparator">contains</span>

                    <div className="rule-condition-control rule-condition-value-control">
                      <label className="sr-only" htmlFor={valueId}>
                        {condition.field === "media" ? "Media value" : "Text to match"} for
                        condition {index + 1}
                      </label>
                      <input
                        id={valueId}
                        ref={(element) => {
                          if (element) conditionInputRefs.current.set(condition.id, element);
                          else conditionInputRefs.current.delete(condition.id);
                        }}
                        required
                        value={condition.pattern}
                        placeholder={condition.field === "media" ? "short" : "sponsored"}
                        onChange={(event) =>
                          setConditions((current) =>
                            current.map((item) =>
                              item.id === condition.id
                                ? { ...item, pattern: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>

                    {conditions.length > 1 ? (
                      <button
                        className="icon-button rule-condition-remove"
                        type="button"
                        onClick={() => removeCondition(condition.id)}
                        aria-label={`Remove condition ${index + 1}${
                          condition.pattern ? `: ${condition.pattern}` : ""
                        }`}
                      >
                        <X aria-hidden="true" size={16} />
                      </button>
                    ) : (
                      <span className="rule-condition-remove-spacer" aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ol>
          </fieldset>
          <div className="rule-condition-actions">
            <button
              ref={addConditionButtonRef}
              className="quiet-button"
              type="button"
              onClick={addCondition}
            >
              <Plus aria-hidden="true" size={15} />
              Add condition
            </button>
            {conditions.some((condition) => condition.field === "media") ? (
              <small>Media type accepts short, video, article, or youtube.</small>
            ) : null}
          </div>
        </section>

        <section className="rule-form-section" aria-labelledby="rule-action-heading">
          <div className="rule-form-section-heading">
            <h3 id="rule-action-heading">Action</h3>
            <p>Choose what happens after the conditions match.</p>
          </div>
          <fieldset className="rule-action-options">
            <legend className="sr-only">Rule action</legend>
            {(["hide", "keep", "mark_read"] as const).map((value) => (
              <label
                className={`rule-action-option${action === value ? " is-selected" : ""}`}
                key={value}
              >
                <input
                  type="radio"
                  name="rule-action"
                  value={value}
                  checked={action === value}
                  onChange={() => setAction(value)}
                />
                <span className="rule-action-icon">
                  <RuleActionIcon action={value} size={17} />
                </span>
                <span>
                  <strong>{RULE_ACTION_COPY[value].label}</strong>
                  <small>{RULE_ACTION_COPY[value].description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="checkbox-field rule-enabled-field">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>
              <strong>Enable rule</strong>
              <small>Disabled rules stay saved but do not run.</small>
            </span>
          </label>
        </section>
      </div>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          {preset?.pattern ? "Back to article" : "Cancel"}
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={
            saving || !name.trim() || conditions.some((condition) => !condition.pattern.trim())
          }
        >
          {saving ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Check aria-hidden="true" size={16} />
          )}
          {saving ? "Saving rule" : preset?.pattern ? "Save and return" : "Save rule"}
        </button>
      </div>
    </form>
  );
}

function RuleRow({
  rule,
  bootstrap,
  onEdit,
  onReload,
  showToast,
}: {
  rule: Rule;
  bootstrap: BootstrapData;
  onEdit: (trigger: HTMLButtonElement) => void;
  onReload: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const scope = rule.feedId
    ? (bootstrap.feeds.find((feed) => feed.id === rule.feedId)?.title ?? "Deleted feed")
    : rule.folderId
      ? (bootstrap.folders.find((folder) => folder.id === rule.folderId)?.name ?? "Deleted folder")
      : "All feeds";
  const [firstCondition] = rule.conditions as [RuleCondition, ...RuleCondition[]];
  const conditionJoin = rule.conditionOperator === "and" ? " AND " : " OR ";
  const conditionDescription = rule.conditions
    .map((condition) => `${RULE_FIELD_LABELS[condition.field]} contains “${condition.pattern}”`)
    .join(conditionJoin);

  const toggle = async () => {
    setBusy(true);
    try {
      await api.updateRule(rule.id, { enabled: !rule.enabled });
      showToast(rule.enabled ? `Disabled ${rule.name}` : `Enabled ${rule.name}`);
      await onReload();
    } catch (error) {
      showToast(`Could not update rule: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete rule “${rule.name}”?`)) return;
    setBusy(true);
    try {
      await api.deleteRule(rule.id);
      showToast(`Deleted ${rule.name}`);
      await onReload();
    } catch (error) {
      showToast(`Could not delete rule: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={rule.enabled ? "" : "is-disabled"}>
      <td data-label="Rule">
        <div className="rule-name-cell">
          <button
            className={`switch ${rule.enabled ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={rule.enabled}
            disabled={busy}
            onClick={() => void toggle()}
          >
            <span />
          </button>
          <strong>{rule.name}</strong>
        </div>
      </td>
      <td data-label="Scope">{scope}</td>
      <td data-label="Conditions">
        <span className="rule-condition" title={conditionDescription}>
          <span className="sr-only">{conditionDescription}</span>
          <small aria-hidden="true">
            {rule.conditionOperator === "and" ? "Match all" : "Match any"}
          </small>
          <span className="rule-condition-summary" aria-hidden="true">
            <code>
              {RULE_FIELD_LABELS[firstCondition.field]}: {firstCondition.pattern}
            </code>
            {rule.conditions.length > 1 ? (
              <span className="rule-condition-count">+{rule.conditions.length - 1}</span>
            ) : null}
          </span>
        </span>
      </td>
      <td data-label="Action">
        <span className={`action-badge ${rule.action}`}>
          <RuleActionIcon action={rule.action} size={13} />
          {RULE_ACTION_COPY[rule.action].shortLabel}
        </span>
      </td>
      <td data-label="Matched">
        <span className="numeric-cell">{rule.matchedCount}</span>
      </td>
      <td className="row-actions">
        <button
          type="button"
          onClick={(event) => onEdit(event.currentTarget)}
          aria-label={`Edit ${rule.name}`}
        >
          <Edit3 aria-hidden="true" size={15} />
        </button>
        <button
          className="danger-action"
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          aria-label={`Delete ${rule.name}`}
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </td>
    </tr>
  );
}

function AiSettingsSection({
  settings,
  aiSettings,
  onSettings,
  onAiSettings,
  showToast,
}: {
  settings: AppSettings;
  aiSettings: AiSettings;
  onSettings: (settings: AppSettings) => void;
  onAiSettings: (settings: AiSettings) => void;
  showToast: (message: string) => void;
}) {
  const initialFeature = aiSettings.features.articleSummary;
  const initialProvider = initialFeature?.provider ?? "gemini";
  const initialModel =
    initialFeature?.model ??
    aiSettings.providers.find((provider) => provider.id === initialProvider)?.defaultModel ??
    "";
  const [providerId, setProviderId] = useState<AiProvider>(initialProvider);
  const [modelId, setModelId] = useState(initialModel);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingFeature, setSavingFeature] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [removingKey, setRemovingKey] = useState(false);
  const [savingPrompts, setSavingPrompts] = useState(false);
  const [savingCustomPrompt, setSavingCustomPrompt] = useState(false);
  const [summaryPrompt, setSummaryPrompt] = useState(settings.summaryPrompt);
  const [translationPrompt, setTranslationPrompt] = useState(settings.translationPrompt);
  const [editingCustomPrompt, setEditingCustomPrompt] = useState<AiCustomPrompt | null>(null);
  const [customPromptName, setCustomPromptName] = useState("");
  const [customPromptText, setCustomPromptText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [customPromptError, setCustomPromptError] = useState<string | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const promptDialogRef = useRef<HTMLDialogElement>(null);
  const summaryPromptRef = useRef<HTMLTextAreaElement>(null);
  const customPromptDialogRef = useRef<HTMLDialogElement>(null);
  const customPromptNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const feature = aiSettings.features.articleSummary;
    const nextProviderId = feature?.provider ?? "gemini";
    const nextProvider = aiSettings.providers.find((provider) => provider.id === nextProviderId);
    setProviderId(nextProviderId);
    setModelId(feature?.model ?? nextProvider?.defaultModel ?? "");
  }, [aiSettings]);

  useEffect(() => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
  }, [settings.summaryPrompt, settings.translationPrompt]);

  const provider = aiSettings.providers.find((option) => option.id === providerId);
  if (!provider) return null;
  const activeFeature = aiSettings.features.articleSummary;
  const modelChanged =
    activeFeature?.provider !== providerId || activeFeature?.model !== modelId.trim();
  const promptsChanged =
    summaryPrompt.trim() !== settings.summaryPrompt ||
    translationPrompt.trim() !== settings.translationPrompt;
  const defaultPromptsSelected =
    summaryPrompt.trim() === DEFAULT_ARTICLE_SUMMARY_PROMPT &&
    translationPrompt.trim() === DEFAULT_ARTICLE_TRANSLATION_PROMPT;
  const busy = savingFeature || savingKey || removingKey || savingPrompts || savingCustomPrompt;

  const updateFeature = async (nextProvider: AiProvider, nextModel: string) => {
    setSavingFeature(true);
    setError(null);
    try {
      onAiSettings(
        await api.updateAiFeature("article_summary", {
          provider: nextProvider,
          model: nextModel.trim(),
        }),
      );
      showToast("AI model saved");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingFeature(false);
    }
  };

  const selectProvider = (nextProviderId: AiProvider) => {
    const nextProvider = aiSettings.providers.find((option) => option.id === nextProviderId);
    if (!nextProvider) return;
    setProviderId(nextProviderId);
    setModelId(
      activeFeature?.provider === nextProviderId ? activeFeature.model : nextProvider.defaultModel,
    );
    setApiKey("");
    setShowKey(false);
    setError(null);
    window.requestAnimationFrame(() => modelInputRef.current?.focus());
  };

  const saveModel = async (event: FormEvent) => {
    event.preventDefault();
    if (!modelId.trim()) return;
    await updateFeature(providerId, modelId);
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const nextKey = apiKey.trim();
    const nextModel = modelId.trim();
    if (!nextKey || !nextModel) return;
    setSavingKey(true);
    setError(null);
    try {
      const keySettings = await api.saveAiProviderKey(providerId, nextKey);
      try {
        const updated = await api.updateAiFeature("article_summary", {
          provider: providerId,
          model: nextModel,
        });
        onAiSettings(updated);
        setApiKey("");
        setShowKey(false);
        showToast(`${provider.label} API key saved for summaries and translations`);
      } catch (caught) {
        onAiSettings(keySettings);
        throw caught;
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = async () => {
    if (
      !window.confirm(
        `Remove the ${provider.label} API key? New summaries and translations will stop until another key is saved.`,
      )
    ) {
      return;
    }
    setRemovingKey(true);
    setError(null);
    try {
      onAiSettings(await api.deleteAiProviderKey(providerId));
      setApiKey("");
      setShowKey(false);
      showToast(`${provider.label} API key removed`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRemovingKey(false);
    }
  };

  const openPromptDialog = () => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
    setPromptError(null);
    promptDialogRef.current?.showModal();
    window.requestAnimationFrame(() => summaryPromptRef.current?.focus());
  };

  const closePromptDialog = () => {
    if (!savingPrompts) promptDialogRef.current?.close();
  };

  const resetPromptDraft = () => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
    setPromptError(null);
  };

  const savePrompts = async (event: FormEvent) => {
    event.preventDefault();
    const nextSummaryPrompt = summaryPrompt.trim();
    const nextTranslationPrompt = translationPrompt.trim();
    if (!nextSummaryPrompt || !nextTranslationPrompt || !promptsChanged) return;
    setSavingPrompts(true);
    setError(null);
    setPromptError(null);
    try {
      onSettings(
        await api.updateSettings({
          summaryPrompt: nextSummaryPrompt,
          translationPrompt: nextTranslationPrompt,
        }),
      );
      showToast("AI prompts saved");
      promptDialogRef.current?.close();
    } catch (caught) {
      setPromptError(errorMessage(caught));
    } finally {
      setSavingPrompts(false);
    }
  };

  const openCustomPromptDialog = (prompt?: AiCustomPrompt) => {
    setEditingCustomPrompt(prompt ?? null);
    setCustomPromptName(prompt?.name ?? "");
    setCustomPromptText(prompt?.prompt ?? "");
    setCustomPromptError(null);
    customPromptDialogRef.current?.showModal();
    window.requestAnimationFrame(() => customPromptNameRef.current?.focus());
  };

  const closeCustomPromptDialog = () => {
    if (!savingCustomPrompt) customPromptDialogRef.current?.close();
  };

  const saveCustomPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const name = customPromptName.trim();
    const prompt = customPromptText.trim();
    if (!name || !prompt) return;
    const nextPrompt: AiCustomPrompt = {
      id: editingCustomPrompt?.id ?? crypto.randomUUID(),
      name,
      prompt,
    };
    const customPrompts = editingCustomPrompt
      ? settings.customPrompts.map((item) =>
          item.id === editingCustomPrompt.id ? nextPrompt : item,
        )
      : [...settings.customPrompts, nextPrompt];
    setSavingCustomPrompt(true);
    setCustomPromptError(null);
    try {
      onSettings(await api.updateSettings({ customPrompts }));
      showToast(editingCustomPrompt ? "Custom prompt updated" : "Custom prompt added");
      customPromptDialogRef.current?.close();
    } catch (caught) {
      setCustomPromptError(errorMessage(caught));
    } finally {
      setSavingCustomPrompt(false);
    }
  };

  const deleteCustomPrompt = async (prompt: AiCustomPrompt) => {
    if (!window.confirm(`Delete the custom prompt “${prompt.name}”?`)) return;
    setSavingCustomPrompt(true);
    setError(null);
    try {
      onSettings(
        await api.updateSettings({
          customPrompts: settings.customPrompts.filter((item) => item.id !== prompt.id),
        }),
      );
      showToast("Custom prompt deleted");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingCustomPrompt(false);
    }
  };

  return (
    <section
      id="ai-settings"
      className="settings-section ai-settings-section"
      aria-labelledby="ai-heading"
    >
      <div className="settings-heading">
        <div>
          <h2 id="ai-heading">AI</h2>
          <p>One provider and model creates summaries and article translations.</p>
        </div>
        {busy ? (
          <span className="saving-label" role="status">
            <LoaderCircle className="spin" aria-hidden="true" size={15} />
            Saving
          </span>
        ) : null}
      </div>

      {!aiSettings.credentialStorageAvailable ? (
        <div className="ai-settings-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>
            Set <code>AI_CREDENTIALS_KEY</code>, then restart or recreate the server to store
            provider keys.
          </span>
        </div>
      ) : null}

      <div className="setting-row">
        <label htmlFor="ai-summary-provider">
          <strong>Provider</strong>
          <p>Used when a summary or translation is generated.</p>
        </label>
        <div className="ai-provider-control">
          <select
            id="ai-summary-provider"
            value={providerId}
            disabled={busy || !aiSettings.credentialStorageAvailable}
            onChange={(event) => selectProvider(event.target.value as AiProvider)}
          >
            {aiSettings.providers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.configured ? " (key saved)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="setting-row">
        <label htmlFor="ai-summary-model">
          <strong>Model</strong>
          <p id="ai-summary-model-help">
            Enter the exact {provider.label} model ID. Default: <code>{provider.defaultModel}</code>
            .
          </p>
        </label>
        <form className="ai-model-form" onSubmit={(event) => void saveModel(event)}>
          <input
            ref={modelInputRef}
            id="ai-summary-model"
            type="text"
            value={modelId}
            placeholder={provider.defaultModel}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            required
            aria-describedby="ai-summary-model-help"
            disabled={busy || !aiSettings.credentialStorageAvailable}
            onChange={(event) => {
              setModelId(event.target.value);
              setError(null);
            }}
          />
          <button
            className="secondary-button"
            type="submit"
            disabled={
              !modelId.trim() || !modelChanged || busy || !aiSettings.credentialStorageAvailable
            }
          >
            {savingFeature ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            Save model
          </button>
        </form>
      </div>

      <div className="setting-row ai-key-row">
        <div>
          <strong>{provider.label} API key</strong>
          <p id="ai-api-key-help">
            {provider.configured
              ? "A key is saved. Paste another key only to replace it."
              : "The key is encrypted on this server and never shown again."}
          </p>
        </div>
        <form className="ai-key-form" onSubmit={(event) => void saveKey(event)}>
          <div className="ai-key-input">
            <label className="sr-only" htmlFor="ai-api-key">
              {provider.label} API key
            </label>
            <input
              ref={keyInputRef}
              id="ai-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder={provider.configured ? "Paste a replacement key" : "Paste API key"}
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="ai-api-key-help"
              disabled={busy || !aiSettings.credentialStorageAvailable}
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
            <button
              className="icon-button"
              type="button"
              disabled={!apiKey || busy}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              aria-pressed={showKey}
              onClick={() => setShowKey((current) => !current)}
            >
              {showKey ? (
                <EyeOff aria-hidden="true" size={16} />
              ) : (
                <Eye aria-hidden="true" size={16} />
              )}
            </button>
          </div>
          <button
            className="primary-button"
            type="submit"
            disabled={
              !apiKey.trim() || !modelId.trim() || busy || !aiSettings.credentialStorageAvailable
            }
          >
            {savingKey ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            {provider.configured ? "Replace key" : "Save key"}
          </button>
          {provider.configured ? (
            <button
              className="secondary-button ai-key-remove"
              type="button"
              disabled={busy || !aiSettings.credentialStorageAvailable}
              onClick={() => void removeKey()}
            >
              Remove key
            </button>
          ) : null}
        </form>
      </div>

      {error ? (
        <div className="ai-settings-error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="setting-row">
        <div>
          <strong>Default prompts</strong>
          <p>Edit the built-in summary and translation instructions.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={openPromptDialog}
        >
          <Edit3 aria-hidden="true" size={15} />
          Edit defaults
        </button>
      </div>

      <div className="custom-prompts-setting">
        <div className="custom-prompts-heading">
          <div>
            <strong>Custom prompts</strong>
            <p>Run saved instructions on any article from the AI prompt menu.</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => openCustomPromptDialog()}
          >
            <Plus aria-hidden="true" size={15} />
            Add prompt
          </button>
        </div>
        {settings.customPrompts.length > 0 ? (
          <ul className="custom-prompt-list">
            {settings.customPrompts.map((prompt) => (
              <li className="custom-prompt-list-item" key={prompt.id}>
                <div>
                  <strong>{prompt.name}</strong>
                  <p>{prompt.prompt}</p>
                </div>
                <div className="custom-prompt-actions">
                  <button
                    className="icon-button"
                    type="button"
                    disabled={busy}
                    aria-label={`Edit ${prompt.name}`}
                    onClick={() => openCustomPromptDialog(prompt)}
                  >
                    <Edit3 aria-hidden="true" size={15} />
                  </button>
                  <button
                    className="icon-button danger-action"
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${prompt.name}`}
                    onClick={() => void deleteCustomPrompt(prompt)}
                  >
                    <Trash2 aria-hidden="true" size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="custom-prompts-empty">No custom prompts yet.</p>
        )}
      </div>

      <dialog
        ref={promptDialogRef}
        className="management-dialog is-wide ai-prompt-dialog"
        aria-labelledby="ai-prompt-dialog-title"
        onClose={resetPromptDraft}
        onCancel={(event) => {
          if (savingPrompts) event.preventDefault();
        }}
      >
        <form className="ai-prompt-dialog-form" onSubmit={(event) => void savePrompts(event)}>
          <header className="management-dialog-heading">
            <span className="dialog-icon" aria-hidden="true">
              <Edit3 size={16} />
            </span>
            <div>
              <h2 id="ai-prompt-dialog-title">Edit default prompts</h2>
              <p>These instructions are used by Summarize and Translate.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              disabled={savingPrompts}
              onClick={closePromptDialog}
              aria-label="Close prompt editor"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          <div className="management-dialog-body ai-prompt-dialog-body">
            <label className="ai-prompt-field" htmlFor="ai-summary-prompt">
              <span>Summary prompt</span>
              <p id="ai-summary-prompt-help">
                Controls the structure, detail, and tone of summaries.
              </p>
              <textarea
                ref={summaryPromptRef}
                id="ai-summary-prompt"
                value={summaryPrompt}
                rows={12}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingPrompts}
                aria-describedby="ai-summary-prompt-help"
                onChange={(event) => {
                  setSummaryPrompt(event.target.value);
                  setPromptError(null);
                }}
              />
            </label>
            <label className="ai-prompt-field" htmlFor="ai-translation-prompt">
              <span>Translation prompt</span>
              <p id="ai-translation-prompt-help">
                Keep the JSON and data-translation-id requirements so translated articles can be
                rebuilt.
              </p>
              <textarea
                id="ai-translation-prompt"
                value={translationPrompt}
                rows={12}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingPrompts}
                aria-describedby="ai-translation-prompt-help"
                onChange={(event) => {
                  setTranslationPrompt(event.target.value);
                  setPromptError(null);
                }}
              />
            </label>

            {promptError ? (
              <div className="management-dialog-error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{promptError}</span>
              </div>
            ) : null}
          </div>

          <footer className="management-dialog-footer">
            <button
              className="secondary-button"
              type="button"
              disabled={savingPrompts || defaultPromptsSelected}
              onClick={() => {
                setSummaryPrompt(DEFAULT_ARTICLE_SUMMARY_PROMPT);
                setTranslationPrompt(DEFAULT_ARTICLE_TRANSLATION_PROMPT);
                setPromptError(null);
              }}
            >
              Restore defaults
            </button>
            <div>
              <button
                className="secondary-button"
                type="button"
                disabled={savingPrompts}
                onClick={closePromptDialog}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  savingPrompts ||
                  !summaryPrompt.trim() ||
                  !translationPrompt.trim() ||
                  !promptsChanged
                }
              >
                {savingPrompts ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : null}
                Save prompts
              </button>
            </div>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={customPromptDialogRef}
        className="management-dialog custom-prompt-dialog"
        aria-labelledby="custom-prompt-dialog-title"
        onClose={() => setCustomPromptError(null)}
        onCancel={(event) => {
          if (savingCustomPrompt) event.preventDefault();
        }}
      >
        <form className="custom-prompt-form" onSubmit={(event) => void saveCustomPrompt(event)}>
          <header className="management-dialog-heading">
            <span className="dialog-icon" aria-hidden="true">
              <MessageSquareText size={16} />
            </span>
            <div>
              <h2 id="custom-prompt-dialog-title">
                {editingCustomPrompt ? "Edit custom prompt" : "Add custom prompt"}
              </h2>
              <p>The article title and text are included automatically.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              disabled={savingCustomPrompt}
              onClick={closeCustomPromptDialog}
              aria-label="Close custom prompt editor"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          <div className="management-dialog-body custom-prompt-dialog-body">
            <label htmlFor="custom-prompt-name">
              <span>Name</span>
              <p id="custom-prompt-name-help">Shown in the article prompt menu.</p>
              <input
                ref={customPromptNameRef}
                id="custom-prompt-name"
                type="text"
                value={customPromptName}
                maxLength={80}
                required
                disabled={savingCustomPrompt}
                aria-describedby="custom-prompt-name-help"
                onChange={(event) => {
                  setCustomPromptName(event.target.value);
                  setCustomPromptError(null);
                }}
              />
            </label>
            <label htmlFor="custom-prompt-text">
              <span>Prompt</span>
              <p id="custom-prompt-text-help">
                Tell the AI how to analyze or transform the article.
              </p>
              <textarea
                id="custom-prompt-text"
                value={customPromptText}
                rows={10}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingCustomPrompt}
                aria-describedby="custom-prompt-text-help"
                onChange={(event) => {
                  setCustomPromptText(event.target.value);
                  setCustomPromptError(null);
                }}
              />
            </label>
            {customPromptError ? (
              <div className="management-dialog-error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{customPromptError}</span>
              </div>
            ) : null}
          </div>

          <footer className="management-dialog-footer">
            <span />
            <div>
              <button
                className="secondary-button"
                type="button"
                disabled={savingCustomPrompt}
                onClick={closeCustomPromptDialog}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  savingCustomPrompt || !customPromptName.trim() || !customPromptText.trim()
                }
              >
                {savingCustomPrompt ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : null}
                {editingCustomPrompt ? "Save prompt" : "Add prompt"}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
    </section>
  );
}

export function SettingsPage({
  settings,
  aiSettings,
  theme,
  fontSize,
  onMenu,
  onTheme,
  onFontSize,
  onSettings,
  onAiSettings,
  onReload,
  showToast,
}: {
  settings: AppSettings;
  aiSettings: AiSettings;
  theme: Theme;
  fontSize: number;
  onMenu: () => void;
  onTheme: (theme: Theme) => void;
  onFontSize: (value: number | ((current: number) => number)) => void;
  onSettings: (settings: AppSettings) => void;
  onAiSettings: (settings: AiSettings) => void;
  onReload: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState(settings.translationLanguage);

  useEffect(() => {
    setTranslationLanguage(settings.translationLanguage);
  }, [settings.translationLanguage]);

  const saveSettings = async (change: Partial<AppSettings>) => {
    setSaving(true);
    try {
      onSettings(await api.updateSettings(change));
      showToast("Settings saved");
    } catch (error) {
      showToast(`Could not save settings: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="management-page settings-page">
      <PageHeader
        title="Settings"
        description="Reading preferences, AI, polling, shortcuts, and portable subscriptions for this account."
        onMenu={onMenu}
        actions={
          saving ? (
            <span className="saving-label">
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
              Saving
            </span>
          ) : undefined
        }
      />
      <section className="settings-section" aria-labelledby="appearance-heading">
        <div className="settings-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <p>Saved for this account in this browser.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Theme</strong>
            <p>Dark is the default for evening reading.</p>
          </div>
          <div className="theme-options">
            <button type="button" aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}>
              <Moon aria-hidden="true" size={17} />
              Dark
            </button>
            <button type="button" aria-pressed={theme === "light"} onClick={() => onTheme("light")}>
              <Sun aria-hidden="true" size={17} />
              Light
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Article text size</strong>
            <p>One saved size applies to every full article in reader and expanded views.</p>
          </div>
          <div className="font-stepper">
            <button
              type="button"
              disabled={fontSize <= 15}
              onClick={() => onFontSize((current) => Math.max(15, current - 1))}
              aria-label="Decrease article text size"
            >
              <Minus aria-hidden="true" size={16} />
              <Kbd>[</Kbd>
            </button>
            <output>{fontSize}px</output>
            <button
              type="button"
              disabled={fontSize >= 23}
              onClick={() => onFontSize((current) => Math.min(23, current + 1))}
              aria-label="Increase article text size"
            >
              <Plus aria-hidden="true" size={16} />
              <Kbd>]</Kbd>
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="reading-behavior-heading">
        <div className="settings-heading">
          <h2 id="reading-behavior-heading">Reading behavior</h2>
          <p>Applied consistently across feeds and folders.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Mark read on scroll</strong>
            <p>Mark an unread card or expanded article only after you scroll completely past it.</p>
          </div>
          <button
            className={`switch ${settings.markReadOnScroll ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={settings.markReadOnScroll}
            disabled={saving}
            onClick={() => void saveSettings({ markReadOnScroll: !settings.markReadOnScroll })}
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <label htmlFor="translation-language">
            <strong>Translation language</strong>
            <p>Article translations use this language and the AI model configured below.</p>
          </label>
          <form
            className="translation-language-form"
            onSubmit={(event) => {
              event.preventDefault();
              const language = translationLanguage.trim();
              if (language) void saveSettings({ translationLanguage: language });
            }}
          >
            <input
              id="translation-language"
              list="translation-language-suggestions"
              value={translationLanguage}
              maxLength={80}
              required
              disabled={saving}
              onChange={(event) => setTranslationLanguage(event.target.value)}
            />
            <datalist id="translation-language-suggestions">
              <option value="English" />
              <option value="Polish" />
              <option value="German" />
              <option value="Spanish" />
              <option value="French" />
              <option value="Italian" />
              <option value="Portuguese" />
              <option value="Ukrainian" />
            </datalist>
            <button
              className="secondary-button"
              type="submit"
              disabled={
                saving ||
                !translationLanguage.trim() ||
                translationLanguage.trim() === settings.translationLanguage
              }
            >
              Save language
            </button>
          </form>
        </div>
      </section>

      <AiSettingsSection
        settings={settings}
        aiSettings={aiSettings}
        onSettings={onSettings}
        onAiSettings={onAiSettings}
        showToast={showToast}
      />

      <section className="settings-section" aria-labelledby="refresh-heading">
        <div className="settings-heading">
          <h2 id="refresh-heading">Refresh</h2>
          <p>Background polling continues while the server is running.</p>
        </div>
        <div className="setting-row">
          <label htmlFor="poll-interval">
            <strong>Published feed interval</strong>
            <p>
              How often Echovale checks RSS, Atom, and JSON feeds. Web feeds refresh every 3 hours.
            </p>
          </label>
          <select
            id="poll-interval"
            value={settings.pollIntervalMinutes}
            disabled={saving}
            onChange={(event) =>
              void saveSettings({ pollIntervalMinutes: Number(event.target.value) })
            }
          >
            {[5, 10, 15, 30, 60, 120].map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatRefreshInterval(minutes)}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="duplicate-article-window">
            <strong>Duplicate article window</strong>
            <p>
              Skip a new article when its exact URL or exact title appeared in any feed during this
              period.
            </p>
          </label>
          <select
            id="duplicate-article-window"
            value={settings.duplicateArticleWindowDays}
            disabled={saving}
            onChange={(event) =>
              void saveSettings({
                duplicateArticleWindowDays: Number(
                  event.target.value,
                ) as DuplicateArticleWindowDays,
              })
            }
          >
            {DUPLICATE_ARTICLE_WINDOW_DAYS.map((days) => (
              <option key={days} value={days}>
                {days === 1 ? "Past day" : `Past ${days} days`}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="keyboard-heading">
        <div className="settings-heading">
          <h2 id="keyboard-heading">Keyboard</h2>
          <p>Shortcuts pause while typing in any field.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Single-key shortcuts</strong>
            <p>Turn off letter and number shortcuts without affecting normal tab navigation.</p>
          </div>
          <button
            className={`switch ${settings.singleKeyShortcuts ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={settings.singleKeyShortcuts}
            disabled={saving}
            onClick={() => void saveSettings({ singleKeyShortcuts: !settings.singleKeyShortcuts })}
          >
            <span />
          </button>
        </div>
        <ShortcutReference compact />
      </section>

      <section className="settings-section" aria-labelledby="portable-heading">
        <div className="settings-heading">
          <h2 id="portable-heading">Subscriptions</h2>
          <p>OPML keeps folder structure and feed URLs portable.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Import or export OPML</strong>
            <p>Imports skip subscriptions that already exist.</p>
          </div>
          <div className="settings-actions">
            <ImportOpmlButton onImported={onReload} showToast={showToast} />
            <a
              className="secondary-button"
              href={appUrl("/api/opml/export")}
              download="echovale-subscriptions.opml"
            >
              <Download aria-hidden="true" size={16} />
              Export OPML
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

const shortcuts = [
  ["J", "Next article"],
  ["K", "Previous article"],
  ["U", "Mark active article unread"],
  ["S", "Star or unstar article"],
  ["C", "Copy active article URL"],
  ["O", "Open active article source"],
  ["W", "Toggle feed or full content"],
  ["M", "Show, hide, or create article summary"],
  ["T", "Toggle article translation"],
  ["R", "Refresh current feed or folder"],
  ["Shift R", "Refresh every feed"],
  ["[", "Decrease article text size"],
  ["]", "Increase article text size"],
  ["1", "Magazine view"],
  ["2", "Expanded view"],
  ["?", "Show shortcut reference"],
] as const;

function ShortcutReference({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`shortcut-reference${compact ? " is-compact" : ""}`}>
      <dl>
        {shortcuts.map(([key, label]) => (
          <div key={key}>
            <dt>
              <Kbd>{key}</Kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
      <div className="shortcut-groups">
        <h3>Go to</h3>
        <dl>
          <div>
            <dt>
              <Kbd>g u</Kbd>
            </dt>
            <dd>Unread</dd>
          </div>
          <div>
            <dt>
              <Kbd>g s</Kbd>
            </dt>
            <dd>Starred</dd>
          </div>
          <div>
            <dt>
              <Kbd>g a</Kbd>
            </dt>
            <dd>All articles</dd>
          </div>
          <div>
            <dt>
              <Kbd>g f</Kbd>
            </dt>
            <dd>Feeds &amp; status</dd>
          </div>
          <div>
            <dt>
              <Kbd>g r</Kbd>
            </dt>
            <dd>Rules</dd>
          </div>
          <div>
            <dt>
              <Kbd>g ,</Kbd>
            </dt>
            <dd>Settings</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export function ShortcutHelp({
  open,
  enabled,
  onClose,
}: {
  open: boolean;
  enabled: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="shortcut-dialog"
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="shortcut-dialog-title"
    >
      <div className="dialog-heading">
        <div>
          <span className="dialog-icon" aria-hidden="true">
            <Keyboard size={18} />
          </span>
          <h2 id="shortcut-dialog-title">Keyboard shortcuts</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => ref.current?.close()}
          aria-label="Close shortcuts"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      {!enabled ? (
        <div className="shortcuts-disabled">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>Single-key shortcuts are disabled in Settings. Tab navigation still works.</span>
        </div>
      ) : null}
      <ShortcutReference />
      <div className="dialog-footer">
        <p>Shortcuts pause while focus is in a form field.</p>
        <button className="primary-button" type="button" onClick={() => ref.current?.close()}>
          Close reference
        </button>
      </div>
    </dialog>
  );
}
