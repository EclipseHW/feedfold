import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  Folder,
  Inbox,
  LayoutList,
  ListFilter,
  LoaderCircle,
  LogOut,
  Menu,
  Pause,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Settings,
  Star,
  UserRound,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import type {
  ArticleState,
  BootstrapData,
  Feed,
  Folder as FolderType,
  ReadingMode,
  SessionUser,
} from "../shared/types";

export type AppView = "reader" | "feeds" | "rules" | "settings";

function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

function IconButton({
  label,
  children,
  pressed,
  disabled,
  onClick,
  className = "",
}: {
  label: string;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface SidebarProps {
  bootstrap: BootstrapData;
  user: SessionUser;
  currentState: ArticleState;
  selectedFeedId: number | null;
  selectedFolderId: number | null;
  currentView: AppView;
  open: boolean;
  onClose: () => void;
  onSelectState: (state: ArticleState) => void;
  onSelectScope: (feedId: number | null, folderId: number | null) => void;
  onNavigate: (view: AppView) => void;
  onRefresh: () => void;
  onLogout: () => Promise<void>;
}

export function Sidebar({
  bootstrap,
  user,
  currentState,
  selectedFeedId,
  selectedFolderId,
  currentView,
  open,
  onClose,
  onSelectState,
  onSelectScope,
  onNavigate,
  onRefresh,
  onLogout,
}: SidebarProps) {
  const rootFolders = bootstrap.folders
    .filter((folder) => folder.parentId === null)
    .sort((a, b) => a.position - b.position);
  const uncategorized = bootstrap.feeds.filter((feed) => feed.folderId === null);
  const hasFeedErrors = bootstrap.feeds.some((feed) => feed.lastError);
  const refreshing = bootstrap.feeds.some((feed) => feed.refreshing);

  return (
    <aside className={`sidebar${open ? " is-open" : ""}`} aria-label="Primary navigation">
      <div className="brand-row">
        <button className="brand" type="button" onClick={() => onSelectScope(null, null)}>
          <span className="brand-mark" aria-hidden="true">
            <Rss size={17} />
          </span>
          <span>Echovale</span>
        </button>
        <IconButton label="Close navigation" onClick={onClose} className="close-nav">
          <X aria-hidden="true" size={18} />
        </IconButton>
      </div>

      <div className="sidebar-refresh-row">
        <button
          className="quiet-button refresh-button"
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" size={15} />
          {refreshing ? "Refreshing" : "Refresh feeds"}
          <Kbd>R</Kbd>
        </button>
      </div>

      <nav className="sidebar-scroll">
        <ul className="nav-list quick-links">
          <li>
            <button
              className="nav-item"
              aria-current={
                currentView === "reader" &&
                currentState === "unread" &&
                selectedFeedId === null &&
                selectedFolderId === null
                  ? "page"
                  : undefined
              }
              type="button"
              onClick={() => onSelectState("unread")}
            >
              <Inbox aria-hidden="true" size={16} />
              <span>Unread</span>
              <span className="nav-count">{bootstrap.counts.unread}</span>
              <Kbd>g u</Kbd>
            </button>
          </li>
          <li>
            <button
              className="nav-item"
              aria-current={
                currentView === "reader" &&
                currentState === "starred" &&
                selectedFeedId === null &&
                selectedFolderId === null
                  ? "page"
                  : undefined
              }
              type="button"
              onClick={() => onSelectState("starred")}
            >
              <Star aria-hidden="true" size={16} />
              <span>Starred</span>
              <span className="nav-count">{bootstrap.counts.starred}</span>
              <Kbd>g s</Kbd>
            </button>
          </li>
          <li>
            <button
              className="nav-item"
              aria-current={
                currentView === "reader" &&
                currentState === "all" &&
                selectedFeedId === null &&
                selectedFolderId === null
                  ? "page"
                  : undefined
              }
              type="button"
              onClick={() => onSelectState("all")}
            >
              <BookOpen aria-hidden="true" size={16} />
              <span>All articles</span>
              <span className="nav-count">{bootstrap.counts.all}</span>
              <Kbd>g a</Kbd>
            </button>
          </li>
        </ul>

        <div className="sidebar-section-heading">
          <span>Folders</span>
          <button
            type="button"
            onClick={() => onNavigate("feeds")}
            aria-label="Manage folders"
            title="Manage folders"
          >
            <Plus aria-hidden="true" size={15} />
          </button>
        </div>

        {bootstrap.feeds.length === 0 ? (
          <button className="sidebar-empty" type="button" onClick={() => onNavigate("feeds")}>
            <Plus aria-hidden="true" size={15} />
            Add your first feed
          </button>
        ) : (
          <ul className="folder-tree">
            {rootFolders.map((folder) => (
              <SidebarFolder
                key={folder.id}
                folder={folder}
                folders={bootstrap.folders}
                feeds={bootstrap.feeds}
                selectedFeedId={selectedFeedId}
                selectedFolderId={selectedFolderId}
                currentView={currentView}
                onSelectScope={onSelectScope}
              />
            ))}
            {uncategorized.map((feed) => (
              <SidebarFeed
                key={feed.id}
                feed={feed}
                selected={currentView === "reader" && selectedFeedId === feed.id}
                onSelect={() => onSelectScope(feed.id, null)}
              />
            ))}
          </ul>
        )}
      </nav>

      <div className="sidebar-footer">
        <button
          className="nav-item"
          aria-current={currentView === "feeds" ? "page" : undefined}
          type="button"
          onClick={() => onNavigate("feeds")}
        >
          {hasFeedErrors ? (
            <AlertTriangle className="status-warning" aria-hidden="true" size={16} />
          ) : (
            <Rss aria-hidden="true" size={16} />
          )}
          <span>Feeds &amp; status</span>
          <Kbd>g f</Kbd>
        </button>
        <button
          className="nav-item"
          aria-current={currentView === "rules" ? "page" : undefined}
          type="button"
          onClick={() => onNavigate("rules")}
        >
          <ListFilter aria-hidden="true" size={16} />
          <span>Rules</span>
          <Kbd>g r</Kbd>
        </button>
        <button
          className="nav-item"
          aria-current={currentView === "settings" ? "page" : undefined}
          type="button"
          onClick={() => onNavigate("settings")}
        >
          <Settings aria-hidden="true" size={16} />
          <span>Settings</span>
          <Kbd>g ,</Kbd>
        </button>
        <div className="sidebar-account">
          <span className="account-name" title={user.username}>
            <UserRound aria-hidden="true" size={16} />
            <span className="truncate">{user.username}</span>
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label={`Log out ${user.username}`}
            title="Log out"
            onClick={() => void onLogout()}
          >
            <LogOut aria-hidden="true" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function SidebarFolder({
  folder,
  folders,
  feeds,
  selectedFeedId,
  selectedFolderId,
  currentView,
  onSelectScope,
}: {
  folder: FolderType;
  folders: FolderType[];
  feeds: Feed[];
  selectedFeedId: number | null;
  selectedFolderId: number | null;
  currentView: AppView;
  onSelectScope: (feedId: number | null, folderId: number | null) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const childFolders = folders
    .filter((candidate) => candidate.parentId === folder.id)
    .sort((a, b) => a.position - b.position);
  const childFeeds = feeds.filter((feed) => feed.folderId === folder.id);
  const hasChildren = childFolders.length > 0 || childFeeds.length > 0;

  return (
    <li>
      <div className="tree-row">
        <button
          className="tree-toggle"
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          disabled={!hasChildren}
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
        </button>
        <button
          className="nav-item tree-nav-item"
          aria-current={
            currentView === "reader" && selectedFolderId === folder.id && selectedFeedId === null
              ? "page"
              : undefined
          }
          type="button"
          onClick={() => onSelectScope(null, folder.id)}
        >
          <Folder aria-hidden="true" size={15} />
          <span>{folder.name}</span>
          {folder.unreadCount > 0 ? <span className="nav-count">{folder.unreadCount}</span> : null}
        </button>
      </div>
      {expanded && hasChildren ? (
        <ul className="folder-tree nested-tree">
          {childFolders.map((child) => (
            <SidebarFolder
              key={child.id}
              folder={child}
              folders={folders}
              feeds={feeds}
              selectedFeedId={selectedFeedId}
              selectedFolderId={selectedFolderId}
              currentView={currentView}
              onSelectScope={onSelectScope}
            />
          ))}
          {childFeeds.map((feed) => (
            <SidebarFeed
              key={feed.id}
              feed={feed}
              selected={currentView === "reader" && selectedFeedId === feed.id}
              onSelect={() => onSelectScope(feed.id, null)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SidebarFeed({
  feed,
  selected,
  onSelect,
}: {
  feed: Feed;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        className="nav-item feed-nav-item"
        aria-current={selected ? "page" : undefined}
        type="button"
        onClick={onSelect}
      >
        <span className={`feed-dot${feed.lastError ? " has-error" : ""}`} aria-hidden="true" />
        <span className="truncate">{feed.title}</span>
        {feed.refreshing ? (
          <LoaderCircle className="spin" aria-label="Refreshing" size={13} />
        ) : null}
        {feed.paused ? <Pause aria-label="Paused" size={12} /> : null}
        {feed.lastError ? (
          <AlertTriangle className="status-warning" aria-label="Feed error" size={13} />
        ) : null}
        {feed.unreadCount > 0 ? <span className="nav-count">{feed.unreadCount}</span> : null}
      </button>
    </li>
  );
}

interface ReaderToolbarProps {
  title: string;
  count: number;
  state: ArticleState;
  searchInput: string;
  searchActive: boolean;
  mode: ReadingMode;
  refreshing: boolean;
  navOpen: boolean;
  onToggleNav: () => void;
  onStateChange: (state: ArticleState) => void;
  onSearchInput: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onClearSearch: () => void;
  onModeChange: (mode: ReadingMode) => void;
  onRefresh: () => void;
  onRefreshAll: () => void;
  onMarkRead: () => void;
  onPreviousScope: () => void;
  onNextScope: () => void;
  onHelp: () => void;
}

export function ReaderToolbar({
  title,
  count,
  state,
  searchInput,
  searchActive,
  mode,
  refreshing,
  navOpen,
  onToggleNav,
  onStateChange,
  onSearchInput,
  onSearch,
  onClearSearch,
  onModeChange,
  onRefresh,
  onRefreshAll,
  onMarkRead,
  onPreviousScope,
  onNextScope,
  onHelp,
}: ReaderToolbarProps) {
  return (
    <header className="reader-toolbar">
      <div className="reader-title-row">
        <IconButton
          label={navOpen ? "Close navigation" : "Open navigation"}
          onClick={onToggleNav}
          className="menu-button"
        >
          <Menu aria-hidden="true" size={19} />
        </IconButton>
        <div className="scope-title">
          <h1>{title}</h1>
          <span>{count} loaded</span>
        </div>
        <fieldset className="source-stepper" style={{ margin: 0, padding: 0, border: 0 }}>
          <legend className="sr-only">Change source</legend>
          <IconButton label="Previous source" onClick={onPreviousScope}>
            <ArrowLeft aria-hidden="true" size={16} />
          </IconButton>
          <IconButton label="Next source" onClick={onNextScope}>
            <ArrowRight aria-hidden="true" size={16} />
          </IconButton>
        </fieldset>
        <form className="search-form" aria-label="Article search" onSubmit={onSearch}>
          <Search aria-hidden="true" size={16} />
          <label className="sr-only" htmlFor="article-search">
            Search articles
          </label>
          <input
            id="article-search"
            type="search"
            value={searchInput}
            placeholder="Search articles"
            onChange={(event) => onSearchInput(event.target.value)}
          />
          {searchInput || searchActive ? (
            <button type="button" onClick={onClearSearch} aria-label="Clear search">
              <X aria-hidden="true" size={15} />
            </button>
          ) : null}
          <button className="search-submit" type="submit">
            Search
          </button>
        </form>
        <div className="toolbar-actions">
          <IconButton label="Refresh feeds (R)" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" size={17} />
            <Kbd>R</Kbd>
          </IconButton>
          <IconButton
            label="Refresh every feed (Shift+R)"
            onClick={onRefreshAll}
            disabled={refreshing}
          >
            <Rss aria-hidden="true" size={17} />
            <Kbd>⇧R</Kbd>
          </IconButton>
          <IconButton label="Mark loaded articles read" onClick={onMarkRead}>
            <CheckCheckIcon />
          </IconButton>
          <IconButton label="Show keyboard shortcuts (?)" onClick={onHelp}>
            <CircleHelp aria-hidden="true" size={18} />
          </IconButton>
        </div>
      </div>
      <div className="filter-row">
        <fieldset className="segmented-control">
          <legend className="sr-only">Article state filter</legend>
          {(["unread", "all", "read", "starred"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={state === filter}
              onClick={() => onStateChange(filter)}
            >
              {filter === "all" ? "All" : `${filter[0]?.toUpperCase()}${filter.slice(1)}`}
            </button>
          ))}
        </fieldset>
        <fieldset className="view-switcher">
          <legend className="sr-only">Reading view</legend>
          <button
            type="button"
            aria-pressed={mode === "magazine"}
            onClick={() => onModeChange("magazine")}
          >
            <LayoutList aria-hidden="true" size={16} />
            Magazine<Kbd>1</Kbd>
          </button>
          <button
            type="button"
            aria-pressed={mode === "expanded"}
            onClick={() => onModeChange("expanded")}
          >
            <FileText aria-hidden="true" size={16} />
            Expanded<Kbd>2</Kbd>
          </button>
        </fieldset>
      </div>
    </header>
  );
}

function CheckCheckIcon() {
  return (
    <span className="check-check" aria-hidden="true">
      <Check size={15} />
      <Check size={15} />
    </span>
  );
}
