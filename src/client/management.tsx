import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FolderPlus,
  Keyboard,
  ListFilter,
  LoaderCircle,
  Menu,
  Minus,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  BootstrapData,
  Feed,
  Folder,
  Rule,
  RuleAction,
  RuleField,
} from "../shared/types";
import { api, errorMessage, type RuleInput } from "./api";

type Theme = "dark" | "light";

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
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
  onMenu,
  onReload,
  onRefresh,
  showToast,
}: {
  bootstrap: BootstrapData;
  onMenu: () => void;
  onReload: () => Promise<void> | void;
  onRefresh: (feedId: number) => void;
  showToast: (message: string) => void;
}) {
  const [addFeedOpen, setAddFeedOpen] = useState(bootstrap.feeds.length === 0);
  const [addFolderOpen, setAddFolderOpen] = useState(false);

  return (
    <div className="management-page">
      <PageHeader
        title="Feeds & status"
        description="Subscriptions, folders, and the last result from every source."
        onMenu={onMenu}
        actions={
          <>
            <ImportOpmlButton onImported={onReload} showToast={showToast} />
            <a
              className="secondary-button"
              href="/api/opml/export"
              download="echovale-subscriptions.opml"
            >
              <Download aria-hidden="true" size={16} />
              Export OPML
            </a>
            <button
              className="primary-button"
              type="button"
              onClick={() => setAddFeedOpen((current) => !current)}
            >
              <Plus aria-hidden="true" size={16} />
              Add feed
            </button>
          </>
        }
      />

      {addFeedOpen ? (
        <AddFeedForm
          folders={bootstrap.folders}
          onCancel={() => setAddFeedOpen(false)}
          onSaved={async (feed) => {
            showToast(`Added ${feed.title}`);
            setAddFeedOpen(false);
            await onReload();
          }}
          showToast={showToast}
        />
      ) : null}

      <section className="management-section" aria-labelledby="subscriptions-heading">
        <div className="section-title-row">
          <div>
            <h2 id="subscriptions-heading">Subscriptions</h2>
            <p>
              {bootstrap.feeds.length} {bootstrap.feeds.length === 1 ? "feed" : "feeds"}
            </p>
          </div>
          <ul
            className="status-legend"
            aria-label="Feed status legend"
            style={{ margin: 0, padding: 0, listStyle: "none" }}
          >
            <li>
              <span className="status-dot healthy" /> Healthy
            </li>
            <li>
              <span className="status-dot failed" /> Needs attention
            </li>
            <li>
              <Pause aria-hidden="true" size={13} /> Paused
            </li>
          </ul>
        </div>

        {bootstrap.feeds.length === 0 ? (
          <div className="section-empty">
            <Rss aria-hidden="true" size={22} />
            <h3>No subscriptions yet</h3>
            <p>Add a feed URL above or import OPML from another reader.</p>
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
                {bootstrap.feeds.map((feed) => (
                  <FeedRow
                    key={feed.id}
                    feed={feed}
                    folders={bootstrap.folders}
                    onReload={onReload}
                    onRefresh={() => onRefresh(feed.id)}
                    showToast={showToast}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="management-section" aria-labelledby="folders-heading">
        <div className="section-title-row">
          <div>
            <h2 id="folders-heading">Folders</h2>
            <p>Group feeds for focused reading and folder-level refresh.</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setAddFolderOpen((current) => !current)}
          >
            <FolderPlus aria-hidden="true" size={16} />
            Add folder
          </button>
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
          <div className="section-empty compact-empty">
            <p>No folders. Feeds remain in the top level until you organize them.</p>
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
    </div>
  );
}

function AddFeedForm({
  folders,
  onCancel,
  onSaved,
  showToast,
}: {
  folders: Folder[];
  onCancel: () => void;
  onSaved: (feed: Feed) => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [folderId, setFolderId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const feed = await api.createFeed({
        ...(title.trim() ? { title: title.trim() } : {}),
        feedUrl: feedUrl.trim(),
        folderId,
      });
      await onSaved(feed);
    } catch (error) {
      showToast(`Could not add feed: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="inline-editor add-feed-form" onSubmit={(event) => void submit(event)}>
      <div className="inline-editor-heading">
        <div>
          <h2>Add a feed</h2>
          <p>Paste an RSS, Atom, or site URL. Echovale will inspect it immediately.</p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onCancel}
          aria-label="Close add feed form"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="form-grid three-columns">
        <label className="field wide-field">
          <span>Feed or site URL</span>
          <input
            type="url"
            required
            value={feedUrl}
            placeholder="https://example.com/feed.xml"
            onChange={(event) => setFeedUrl(event.target.value)}
          />
        </label>
        <label className="field">
          <span>
            Name <small>optional</small>
          </span>
          <input
            value={title}
            placeholder="Use feed title"
            onChange={(event) => setTitle(event.target.value)}
          />
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
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-button" type="submit" disabled={saving || !feedUrl.trim()}>
          {saving ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Plus aria-hidden="true" size={16} />
          )}
          {saving ? "Adding feed" : "Add feed"}
        </button>
      </div>
    </form>
  );
}

function FeedRow({
  feed,
  folders,
  onReload,
  onRefresh,
  showToast,
}: {
  feed: Feed;
  folders: Folder[];
  onReload: () => Promise<void> | void;
  onRefresh: () => void;
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
      await api.updateFeed(feed.id, { title: title.trim(), feedUrl: feedUrl.trim(), folderId });
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
              <span>Feed URL</span>
              <input
                type="url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
              />
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
            className={`status-dot ${feed.lastError ? "failed" : feed.paused ? "paused" : "healthy"}`}
          />
          <div>
            <strong>{feed.title}</strong>
            <a href={feed.siteUrl ?? feed.feedUrl} target="_blank" rel="noreferrer">
              {feed.feedUrl}
            </a>
          </div>
        </div>
      </td>
      <td data-label="Folder">{folder?.name ?? <span className="muted">Top level</span>}</td>
      <td data-label="Status">
        {feed.lastError ? (
          <span className="feed-status failed-status" title={feed.lastError}>
            <AlertTriangle aria-hidden="true" size={14} />
            {feed.lastHttpStatus ? `HTTP ${feed.lastHttpStatus}` : "Failed"}
            <small>{feed.lastError}</small>
          </span>
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

function FolderForm({
  folders,
  initial,
  onCancel,
  onSaved,
  showToast,
}: {
  folders: Folder[];
  initial?: Folder;
  onCancel: () => void;
  onSaved: (folder: Folder) => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parentId, setParentId] = useState<number | null>(initial?.parentId ?? null);
  const [saving, setSaving] = useState(false);
  const availableParents = folders.filter((folder) => folder.id !== initial?.id);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const folder = initial
        ? await api.updateFolder(initial.id, { name: name.trim(), parentId })
        : await api.createFolder({ name: name.trim(), parentId });
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
        <input required value={name} onChange={(event) => setName(event.target.value)} />
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
  onMenu,
  onReload,
  showToast,
}: {
  bootstrap: BootstrapData;
  rules: Rule[];
  loading: boolean;
  error: string | null;
  onMenu: () => void;
  onReload: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);

  return (
    <div className="management-page">
      <PageHeader
        title="Noise rules"
        description="Hide predictable noise or mark it read before it reaches your queue."
        onMenu={onMenu}
        actions={
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" size={16} />
            Add rule
          </button>
        }
      />

      {formOpen ? (
        <RuleForm
          bootstrap={bootstrap}
          initial={editing ?? undefined}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={async (rule) => {
            showToast(editing ? `Saved ${rule.name}` : `Added ${rule.name}`);
            setFormOpen(false);
            setEditing(null);
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
            <h3>No noise rules</h3>
            <p>
              Create a rule for recurring topics, authors, or phrases you do not want in the queue.
            </p>
            <button className="secondary-button" type="button" onClick={() => setFormOpen(true)}>
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
                  <th scope="col">Match</th>
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
                    onEdit={() => {
                      setEditing(rule);
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

function RuleForm({
  bootstrap,
  initial,
  onCancel,
  onSaved,
  showToast,
}: {
  bootstrap: BootstrapData;
  initial?: Rule;
  onCancel: () => void;
  onSaved: (rule: Rule) => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [scope, setScope] = useState(
    initial?.feedId
      ? `feed:${initial.feedId}`
      : initial?.folderId
        ? `folder:${initial.folderId}`
        : "all",
  );
  const [field, setField] = useState<RuleField>(initial?.field ?? "title");
  const [pattern, setPattern] = useState(initial?.pattern ?? "");
  const [action, setAction] = useState<RuleAction>(initial?.action ?? "hide");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const [scopeType, rawId] = scope.split(":");
    const input: RuleInput = {
      name: name.trim(),
      feedId: scopeType === "feed" ? Number(rawId) : null,
      folderId: scopeType === "folder" ? Number(rawId) : null,
      field,
      pattern: pattern.trim(),
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
    <form className="inline-editor rule-form" onSubmit={(event) => void submit(event)}>
      <div className="inline-editor-heading">
        <div>
          <h2>{initial ? "Edit rule" : "Add a noise rule"}</h2>
          <p>
            Matches are case-insensitive. Existing articles are checked now and new articles on
            refresh.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onCancel}
          aria-label="Close rule form"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="form-grid rule-form-grid">
        <label className="field">
          <span>Rule name</span>
          <input
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
        <label className="field">
          <span>Look in</span>
          <select value={field} onChange={(event) => setField(event.target.value as RuleField)}>
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="summary">Summary</option>
            <option value="content">Full content</option>
            <option value="any">Any text</option>
          </select>
        </label>
        <label className="field wide-field">
          <span>Text to match</span>
          <input
            required
            value={pattern}
            placeholder="sponsored"
            onChange={(event) => setPattern(event.target.value)}
          />
          <small>Enter a word or phrase exactly as it appears.</small>
        </label>
        <label className="field">
          <span>Then</span>
          <select value={action} onChange={(event) => setAction(event.target.value as RuleAction)}>
            <option value="hide">Hide article</option>
            <option value="mark_read">Mark as read</option>
          </select>
        </label>
        <label className="checkbox-field">
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
      </div>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={saving || !name.trim() || !pattern.trim()}
        >
          {saving ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : (
            <Check aria-hidden="true" size={16} />
          )}
          {saving ? "Saving rule" : "Save rule"}
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
  onEdit: () => void;
  onReload: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const scope = rule.feedId
    ? (bootstrap.feeds.find((feed) => feed.id === rule.feedId)?.title ?? "Deleted feed")
    : rule.folderId
      ? (bootstrap.folders.find((folder) => folder.id === rule.folderId)?.name ?? "Deleted folder")
      : "All feeds";

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
      <td data-label="Match">
        <span className="rule-condition">
          <small>{rule.field === "any" ? "Any text" : rule.field}</small>
          <code>{rule.pattern}</code>
        </span>
      </td>
      <td data-label="Action">
        <span className={`action-badge ${rule.action}`}>
          {rule.action === "hide" ? (
            <EyeOff aria-hidden="true" size={13} />
          ) : (
            <Eye aria-hidden="true" size={13} />
          )}
          {rule.action === "hide" ? "Hide" : "Mark read"}
        </span>
      </td>
      <td data-label="Matched">
        <span className="numeric-cell">{rule.matchedCount}</span>
      </td>
      <td className="row-actions">
        <button type="button" onClick={onEdit} aria-label={`Edit ${rule.name}`}>
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

export function SettingsPage({
  settings,
  theme,
  fontSize,
  onMenu,
  onTheme,
  onFontSize,
  onSettings,
  onReload,
  showToast,
}: {
  settings: AppSettings;
  theme: Theme;
  fontSize: number;
  onMenu: () => void;
  onTheme: (theme: Theme) => void;
  onFontSize: (value: number | ((current: number) => number)) => void;
  onSettings: (settings: AppSettings) => void;
  onReload: () => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);

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
        description="Reading preferences, polling, shortcuts, and portable subscriptions for this account."
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
      </section>

      <section className="settings-section" aria-labelledby="refresh-heading">
        <div className="settings-heading">
          <h2 id="refresh-heading">Refresh</h2>
          <p>Background polling continues while the server is running.</p>
        </div>
        <div className="setting-row">
          <label htmlFor="poll-interval">
            <strong>Polling interval</strong>
            <p>How often Echovale asks feeds for new articles.</p>
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
                {minutes < 60
                  ? `${minutes} minutes`
                  : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}
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
              href="/api/opml/export"
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
