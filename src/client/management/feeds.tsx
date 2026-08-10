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
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SVGProps,
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
import { DropdownSelect } from "../dropdown";
import { FeedEntriesPreview } from "../feed-entries-preview";
import {
  type FeedStatusFilter,
  type FeedTypeFilter,
  filterFeeds,
  visibleFeedStatus,
} from "../feed-filters";
import {
  type AddFeedSourceType,
  feedSourceUrl,
  TELEGRAM_HANDLE_PATTERN,
  X_HANDLE_PATTERN,
} from "../feed-source";
import { type MotionState, useMotionPresence } from "../motion";
import { WebFeedSetup } from "../web-feed-setup";
import { ExportOpmlLink, formatDate, ImportOpmlButton, PageHeader } from "./shared";
import "./feeds.css";

type FeedsPageTab = "subscriptions" | "folders";

function XLogo({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <title>X</title>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const ADD_FEED_SOURCE_OPTIONS = [
  {
    value: "rss",
    label: "RSS feed",
    description: "A website or RSS, Atom, or JSON Feed URL.",
    icon: Rss,
  },
  {
    value: "web",
    label: "Web page",
    description: "A public page with repeated entries but no published feed.",
    icon: Globe2,
  },
  {
    value: "telegram",
    label: "Telegram",
    description: "A public Telegram channel handle.",
    icon: Send,
  },
  {
    value: "x",
    label: "x.com",
    description: "An X profile handle, followed through Nitter RSS.",
    icon: XLogo,
  },
] as const;

const ADD_FEED_INPUTS: Record<
  AddFeedSourceType,
  {
    label: string;
    placeholder: string;
    help: string;
    prefix: string | null;
    pattern?: string;
    action: string;
    loading: string;
    add: string;
  }
> = {
  rss: {
    label: "Website or feed URL",
    placeholder: "https://example.com",
    help: "echovale checks the address for RSS, Atom, and JSON Feed.",
    prefix: null,
    action: "Check feed",
    loading: "Checking feed",
    add: "Add feed",
  },
  web: {
    label: "Public page URL",
    placeholder: "https://example.com/articles",
    help: "echovale looks for repeated links on this page. Sign-ins and paywalls are not supported.",
    prefix: null,
    action: "Find entries",
    loading: "Finding entries",
    add: "Add web feed",
  },
  telegram: {
    label: "Telegram channel handle",
    placeholder: "durov",
    help: "Enter the public channel handle, with or without @. Links aren't supported.",
    prefix: "t.me/",
    pattern: TELEGRAM_HANDLE_PATTERN,
    action: "Preview channel",
    loading: "Loading channel",
    add: "Add Telegram feed",
  },
  x: {
    label: "X profile handle",
    placeholder: "egornomic",
    help: "Enter the handle, with or without @. Links aren't supported. Updates come from Nitter RSS.",
    prefix: "x.com/",
    pattern: X_HANDLE_PATTERN,
    action: "Preview profile",
    loading: "Loading profile",
    add: "Add X feed",
  },
};

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
  const [addFolderSession, setAddFolderSession] = useState(0);
  const [activeTab, setActiveTab] = useState<FeedsPageTab>("subscriptions");
  const [feedTypeFilter, setFeedTypeFilter] = useState<FeedTypeFilter>("all");
  const [feedStatusFilter, setFeedStatusFilter] = useState<FeedStatusFilter>("all");
  const addFeedPresence = useMotionPresence(addFeedOpen);
  const addFolderPresence = useMotionPresence(addFolderOpen);
  const addFeedTriggerRef = useRef<HTMLButtonElement>(null);
  const addFolderTriggerRef = useRef<HTMLButtonElement>(null);
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

  const closeAddFolder = () => {
    addFolderTriggerRef.current?.focus();
    setAddFolderOpen(false);
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
              ref={addFolderTriggerRef}
              className="primary-button"
              type="button"
              onClick={() => {
                if (addFolderOpen) {
                  closeAddFolder();
                  return;
                }
                setAddFolderSession((current) => current + 1);
                setAddFolderOpen(true);
              }}
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
                  <div className="feed-filter-field">
                    <span>Type</span>
                    <DropdownSelect
                      ariaLabel="Feed type"
                      value={feedTypeFilter}
                      options={[
                        { value: "all", label: `All types (${bootstrap.feeds.length})` },
                        { value: "published", label: `Published feeds (${publishedFeedCount})` },
                        { value: "web", label: `Web feeds (${webFeedCount})` },
                      ]}
                      onChange={(value) => setFeedTypeFilter(value as FeedTypeFilter)}
                    />
                  </div>
                  <div className="feed-filter-field">
                    <span>Status</span>
                    <DropdownSelect
                      ariaLabel="Feed status"
                      value={feedStatusFilter}
                      options={[
                        { value: "all", label: `All statuses (${bootstrap.feeds.length})` },
                        { value: "healthy", label: `Healthy (${statusCounts.healthy})` },
                        {
                          value: "needs_attention",
                          label: `Needs attention (${statusCounts.needs_attention})`,
                        },
                        { value: "paused", label: `Paused (${statusCounts.paused})` },
                        { value: "refreshing", label: `Refreshing (${statusCounts.refreshing})` },
                      ]}
                      onChange={(value) => setFeedStatusFilter(value as FeedStatusFilter)}
                    />
                  </div>
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
          {addFolderPresence.present ? (
            <FolderForm
              key={addFolderSession}
              folders={bootstrap.folders}
              motionState={addFolderPresence.state}
              mutations={mutations}
              onCancel={closeAddFolder}
              onSaved={(folder) => {
                showToast(`Created ${folder.name}`);
                closeAddFolder();
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
      </label>
      <div className="field">
        <span>Folder</span>
        <DropdownSelect
          ariaLabel="Folder"
          value={folderId === null ? "" : String(folderId)}
          disabled={disabled}
          options={[
            { value: "", label: "No folder" },
            ...folders.map((folder) => ({ value: String(folder.id), label: folder.name })),
          ]}
          onChange={(value) => onFolderChange(value ? Number(value) : null)}
        />
      </div>
    </div>
  );
}

function FeedConfirmationBar({
  sourceType,
  title,
  folderId,
  folders,
  disabled,
  existingFeed,
  canSave,
  onCancel,
  onTitleChange,
  onFolderChange,
}: {
  sourceType: AddFeedSourceType;
  title: string;
  folderId: number | null;
  folders: Folder[];
  disabled: boolean;
  existingFeed?: Feed;
  canSave: boolean;
  onCancel: () => void;
  onTitleChange: (title: string) => void;
  onFolderChange: (folderId: number | null) => void;
}) {
  const inputConfig = ADD_FEED_INPUTS[sourceType];
  const statusTitle = existingFeed ? "Already in your feeds" : "Choose an entry group";
  const statusDescription = existingFeed
    ? `You follow this as ${existingFeed.title}.`
    : "Select an entry group to review its recent entries.";
  const actionLabel = disabled
    ? `${inputConfig.add.replace(/^Add /, "Adding ")}…`
    : existingFeed
      ? "Already added"
      : inputConfig.add;

  return (
    <section
      className="feed-confirmation-bar"
      aria-label="Confirm subscription"
      data-blocked={!canSave || !!existingFeed || undefined}
    >
      {existingFeed || !canSave ? (
        <div className="feed-confirmation-status" aria-live="polite">
          {existingFeed ? (
            <CheckCircle2 aria-hidden="true" size={18} />
          ) : (
            <MousePointer2 aria-hidden="true" size={18} />
          )}
          <span>
            <strong>{statusTitle}</strong>
            <small>{statusDescription}</small>
          </span>
        </div>
      ) : null}

      <FeedConfirmationSettings
        title={title}
        folderId={folderId}
        folders={folders}
        disabled={disabled || !!existingFeed}
        onTitleChange={onTitleChange}
        onFolderChange={onFolderChange}
      />

      <div className="feed-confirmation-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={disabled || !canSave || !!existingFeed}
        >
          {disabled ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : existingFeed ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <Plus aria-hidden="true" size={16} />
          )}
          {actionLabel}
        </button>
      </div>
    </section>
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
  const [sourceType, setSourceType] = useState<AddFeedSourceType>("rss");
  const [sourceInputs, setSourceInputs] = useState<Record<AddFeedSourceType, string>>({
    rss: initialSourceUrl,
    web: initialSourceUrl,
    telegram: "",
    x: "",
  });
  const [previewSourceType, setPreviewSourceType] = useState<AddFeedSourceType>("rss");
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
  const sourceInput = sourceInputs[sourceType];
  const inputConfig = ADD_FEED_INPUTS[sourceType];
  const SourcePreviewIcon =
    ADD_FEED_SOURCE_OPTIONS.find((option) => option.value === previewSourceType)?.icon ?? Rss;
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

  const clearDiscoveryResult = () => {
    setPreview(null);
    setWebPage(null);
    setWebAnalysis(null);
    setSelectedCandidateId(null);
    setTitle("");
    setError(null);
  };

  const selectSourceType = (nextSourceType: AddFeedSourceType) => {
    if (nextSourceType === sourceType) return;
    if (
      (nextSourceType === "rss" || nextSourceType === "web") &&
      (sourceType === "rss" || sourceType === "web") &&
      !sourceInputs[nextSourceType]
    ) {
      setSourceInputs((current) => ({
        ...current,
        [nextSourceType]: current[sourceType],
      }));
    }
    setSourceType(nextSourceType);
    clearDiscoveryResult();
  };

  const discover = useCallback(async (url: string, requestedSourceType: AddFeedSourceType) => {
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
        setPreviewSourceType(requestedSourceType);
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
    void discover(feedSourceUrl("rss", initialSourceUrl), "rss");
  }, [discover, initialSourceUrl]);

  const analyzeWebPage = async (url: string) => {
    setAnalyzingWebPage(true);
    setError(null);
    setPreview(null);
    setWebPage(null);
    setWebAnalysis(null);
    setSelectedCandidateId(null);
    try {
      const result = await api.analyzeWebPage(url);
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
          <p>Choose a source, preview its latest entries, then subscribe.</p>
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

      <fieldset className="feed-source-selector">
        <legend>Source type</legend>
        <div className="feed-source-options">
          {ADD_FEED_SOURCE_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            return (
              <label className="feed-source-option" key={option.value}>
                <input
                  className="sr-only"
                  type="radio"
                  name="feed-source-type"
                  value={option.value}
                  checked={sourceType === option.value}
                  disabled={discovering || analyzingWebPage || saving}
                  onChange={() => selectSourceType(option.value)}
                />
                <span>
                  <OptionIcon aria-hidden="true" size={16} />
                  {option.label}
                </span>
              </label>
            );
          })}
        </div>
        <p aria-live="polite">
          {ADD_FEED_SOURCE_OPTIONS.find((option) => option.value === sourceType)?.description}
        </p>
      </fieldset>

      <form
        className="feed-discovery-form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const url = feedSourceUrl(sourceType, sourceInput);
            if (sourceType === "web") {
              void analyzeWebPage(url);
            } else {
              void discover(url, sourceType);
            }
          } catch (caught) {
            setError(errorMessage(caught));
          }
        }}
      >
        <label className="field feed-url-field">
          <span>{inputConfig.label}</span>
          <span
            className={inputConfig.prefix ? "feed-source-input has-prefix" : "feed-source-input"}
          >
            {inputConfig.prefix ? <span aria-hidden="true">{inputConfig.prefix}</span> : null}
            <input
              type={sourceType === "rss" || sourceType === "web" ? "url" : "text"}
              required
              value={sourceInput}
              pattern={inputConfig.pattern}
              title={inputConfig.help}
              placeholder={inputConfig.placeholder}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={discovering || analyzingWebPage || saving}
              aria-describedby="feed-url-help"
              onChange={(event) => {
                setSourceInputs((current) => ({
                  ...current,
                  [sourceType]: event.target.value,
                }));
                clearDiscoveryResult();
              }}
            />
          </span>
          <small id="feed-url-help">{inputConfig.help}</small>
        </label>
        <button
          className={preview || webPage || webAnalysis ? "secondary-button" : "primary-button"}
          type="submit"
          disabled={discovering || analyzingWebPage || saving || !sourceInput.trim()}
        >
          {discovering || analyzingWebPage ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Search aria-hidden="true" size={16} />
          )}
          {discovering || analyzingWebPage
            ? inputConfig.loading
            : preview || webPage || webAnalysis
              ? `${inputConfig.action} again`
              : inputConfig.action}
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
            onClick={() => {
              const pageUrl = webPage.pageUrl;
              setSourceInputs((current) => ({ ...current, web: pageUrl }));
              setSourceType("web");
              void analyzeWebPage(pageUrl);
            }}
          >
            <Globe2 aria-hidden="true" size={16} />
            Use web feed
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
                  : sourceType === "telegram"
                    ? "Loading the public channel and its latest posts…"
                    : sourceType === "x"
                      ? "Loading the profile through Nitter RSS…"
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
                    <SourcePreviewIcon size={20} />
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
                </div>

                <FeedConfirmationBar
                  sourceType={previewSourceType}
                  title={title}
                  folderId={folderId}
                  folders={folders}
                  disabled={saving}
                  existingFeed={existingFeed}
                  canSave
                  onCancel={onCancel}
                  onTitleChange={setTitle}
                  onFolderChange={setFolderId}
                />

                <FeedEntriesPreview
                  articles={displayedPreview.articles}
                  totalEntries={displayedPreview.totalArticles}
                />
              </section>
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
            confirmation={
              <>
                <FeedConfirmationBar
                  sourceType="web"
                  title={title}
                  folderId={folderId}
                  folders={folders}
                  disabled={saving}
                  existingFeed={existingFeed}
                  canSave={selectedCandidate !== null}
                  onCancel={onCancel}
                  onTitleChange={setTitle}
                  onFolderChange={setFolderId}
                />
                {selectedCandidate && !selectedCandidate.availableFields.includes("date") ? (
                  <p className="web-feed-date-fallback">
                    These entries have no publication date. echovale will use the time it first
                    discovers each one.
                  </p>
                ) : null}
              </>
            }
          />
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
            <div className="field">
              <span>Folder</span>
              <DropdownSelect
                ariaLabel="Folder"
                value={folderId === null ? "" : String(folderId)}
                options={[
                  { value: "", label: "No folder" },
                  ...folders.map((item) => ({ value: String(item.id), label: item.name })),
                ]}
                onChange={(value) => setFolderId(value ? Number(value) : null)}
              />
            </div>
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
  motionState,
  mutations,
  onCancel,
  onSaved,
  showToast,
}: {
  folders: Folder[];
  initial?: Folder;
  defaultParentId?: number | null;
  motionState?: MotionState;
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
    <form
      className={`compact-form${motionState ? " add-folder-form" : ""}`}
      data-motion-state={motionState}
      inert={motionState === "closed" ? true : undefined}
      onSubmit={(event) => void submit(event)}
    >
      <label className="field">
        <span>Folder name</span>
        <input
          data-dialog-initial-focus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="field">
        <span>Parent folder</span>
        <DropdownSelect
          ariaLabel="Parent folder"
          value={parentId === null ? "" : String(parentId)}
          options={[
            { value: "", label: "No parent" },
            ...availableParents.map((folder) => ({
              value: String(folder.id),
              label: folder.name,
            })),
          ]}
          onChange={(value) => setParentId(value ? Number(value) : null)}
        />
      </div>
      <div className="field">
        <span>Article order</span>
        <DropdownSelect
          ariaLabel="Article order"
          value={sortDirection}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
          onChange={(value) => setSortDirection(value as FolderSortDirection)}
        />
      </div>
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
