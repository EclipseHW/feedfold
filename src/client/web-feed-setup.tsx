import {
  ArrowLeft,
  Check,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  MousePointer2,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import type {
  FeedPreviewArticle,
  WebFeedAnalysis,
  WebFeedCandidate,
  WebFeedField,
} from "../shared/types";
import { appUrl } from "./api";
import { parseWebFeedSelectionMessage, webFeedHighlightMessage } from "./web-feed-selection";

const WEB_FEED_FIELDS: WebFeedField[] = ["title", "link", "date", "author", "summary", "image"];

const WEB_FEED_FIELD_LABELS: Record<WebFeedField, string> = {
  title: "Title",
  link: "Link",
  date: "Date",
  author: "Author",
  summary: "Summary",
  image: "Image",
};

export interface WebFeedSetupProps {
  analysis: WebFeedAnalysis;
  selectedCandidateId: string | null;
  disabled?: boolean;
  busyLabel?: string;
  onSelect: (candidateId: string | null) => void;
  onBack?: () => void;
}

function formatPreviewDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function previewTitle(article: FeedPreviewArticle): string {
  return article.title || article.summary || "Untitled article";
}

function CandidateSuggestion({
  candidate,
  selected,
  disabled,
  onSelect,
}: {
  candidate: WebFeedCandidate;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`web-feed-suggestion${selected ? " is-selected" : ""}`}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="web-feed-suggestion-state" aria-hidden="true">
        <Check size={11} strokeWidth={2.5} />
      </span>
      <span className="web-feed-suggestion-copy">
        <strong>{candidate.label}</strong>
        <small>
          {candidate.itemCount} {candidate.itemCount === 1 ? "item" : "items"} ·{" "}
          {candidate.availableFields.length} of {WEB_FEED_FIELDS.length} fields
        </small>
      </span>
    </button>
  );
}

function FieldAvailability({ candidate }: { candidate: WebFeedCandidate }) {
  const availableFields = new Set(candidate.availableFields);

  return (
    <ul className="web-feed-field-availability" aria-label="Available article fields">
      {WEB_FEED_FIELDS.map((field) => {
        const available = availableFields.has(field);
        return (
          <li
            key={field}
            className={`web-feed-field${available ? " is-available" : " is-missing"}`}
          >
            {available ? <Check aria-hidden="true" size={12} /> : <span aria-hidden="true">–</span>}
            {WEB_FEED_FIELD_LABELS[field]}
            <span className="sr-only"> {available ? "available" : "not found"}</span>
          </li>
        );
      })}
    </ul>
  );
}

function PreviewArticle({ article }: { article: FeedPreviewArticle }) {
  return (
    <li className={`feed-preview-article${article.imageUrl ? " has-image" : ""}`}>
      {article.imageUrl ? <img src={article.imageUrl} alt="" loading="lazy" /> : null}
      <div>
        {article.url ? (
          <a
            className="feed-preview-article-title"
            href={article.url}
            target="_blank"
            rel="noreferrer"
          >
            {previewTitle(article)}
            <ExternalLink aria-hidden="true" size={12} />
          </a>
        ) : (
          <strong className="feed-preview-article-title">{previewTitle(article)}</strong>
        )}
        {article.author || article.publishedAt ? (
          <div className="feed-preview-article-meta">
            {article.author ? <span>{article.author}</span> : null}
            {article.author && article.publishedAt ? <span aria-hidden="true">·</span> : null}
            {article.publishedAt ? (
              <time dateTime={article.publishedAt}>{formatPreviewDate(article.publishedAt)}</time>
            ) : null}
          </div>
        ) : null}
        {article.summary ? <p>{article.summary}</p> : null}
      </div>
    </li>
  );
}

export function WebFeedSetup({
  analysis,
  selectedCandidateId,
  disabled = false,
  busyLabel = "Saving selection…",
  onSelect,
  onBack,
}: WebFeedSetupProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const suggestionsHeadingId = useId();
  const candidateIds = useMemo(
    () => new Set(analysis.candidates.map((candidate) => candidate.id)),
    [analysis.candidates],
  );
  const suggestedCandidates = useMemo(() => {
    const candidatesById = new Map(
      analysis.candidates.map((candidate) => [candidate.id, candidate] as const),
    );
    return analysis.suggestedCandidateIds
      .map((candidateId) => candidatesById.get(candidateId))
      .filter((candidate): candidate is WebFeedCandidate => candidate !== undefined);
  }, [analysis.candidates, analysis.suggestedCandidateIds]);
  const selectedCandidate =
    analysis.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;

  const highlightSelection = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      webFeedHighlightMessage(analysis.messageToken, selectedCandidate?.id ?? null),
      "*",
    );
  }, [analysis.messageToken, selectedCandidate?.id]);

  useEffect(() => {
    highlightSelection();
  }, [highlightSelection]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const receiveSelection = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;

      const action = parseWebFeedSelectionMessage(event.data, analysis.messageToken, candidateIds);
      if (!action || disabled) return;
      onSelect(action.candidateId);
    };

    window.addEventListener("message", receiveSelection);
    return () => window.removeEventListener("message", receiveSelection);
  }, [analysis.messageToken, candidateIds, disabled, onSelect]);

  const matchAnnouncement = selectedCandidate
    ? `${selectedCandidate.itemCount} matching ${selectedCandidate.itemCount === 1 ? "item" : "items"} highlighted.`
    : "No item group selected.";

  return (
    <section className="web-feed-setup" aria-labelledby={headingId} aria-busy={disabled}>
      <header className="web-feed-setup-heading">
        {onBack ? (
          <button
            className="icon-button web-feed-back-button"
            type="button"
            disabled={disabled}
            onClick={onBack}
            aria-label="Back to website address"
          >
            <ArrowLeft aria-hidden="true" size={18} />
          </button>
        ) : null}
        <div className="web-feed-setup-title">
          <h3 ref={headingRef} id={headingId} tabIndex={-1}>
            Choose the items to follow
          </h3>
          <p>Select a suggestion or choose one representative item directly on {analysis.title}.</p>
        </div>
        <span className="web-feed-selection-badge">
          <LockKeyhole aria-hidden="true" size={13} />
          Selection mode
        </span>
      </header>

      <div className="web-feed-workspace">
        <div className="web-feed-page-pane">
          <div className="web-feed-page-toolbar">
            <div>
              <strong>Page preview</strong>
              <span>Scroll normally. Links, forms, and page actions are disabled.</span>
            </div>
            <span className="web-feed-match-count" aria-hidden="true">
              <MousePointer2 aria-hidden="true" size={14} />
              {selectedCandidate ? `${selectedCandidate.itemCount} matched` : "Choose an item"}
            </span>
          </div>
          <div className="web-feed-frame-wrap" data-disabled={disabled || undefined}>
            <iframe
              ref={iframeRef}
              key={`${analysis.snapshotId}:${analysis.messageToken}`}
              className="web-feed-frame"
              src={appUrl(`/api/web-feed-snapshots/${encodeURIComponent(analysis.snapshotId)}`)}
              title={`Select repeating items on ${analysis.title}`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              tabIndex={disabled ? -1 : 0}
              onLoad={highlightSelection}
            />
            {disabled ? (
              <div className="web-feed-frame-busy" role="status">
                <LoaderCircle className="spin" aria-hidden="true" size={16} />
                <span>{busyLabel}</span>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="web-feed-suggestions" aria-labelledby={suggestionsHeadingId}>
          <div className="web-feed-suggestions-heading">
            <h4 id={suggestionsHeadingId}>Suggested groups</h4>
            <p>Choose the group that best represents new entries.</p>
          </div>
          {suggestedCandidates.length > 0 ? (
            <div className="web-feed-suggestion-list">
              {suggestedCandidates.map((candidate) => (
                <CandidateSuggestion
                  key={candidate.id}
                  candidate={candidate}
                  selected={candidate.id === selectedCandidate?.id}
                  disabled={disabled}
                  onSelect={() => onSelect(candidate.id)}
                />
              ))}
            </div>
          ) : (
            <div className="web-feed-suggestions-empty" role="status">
              <p>
                {analysis.candidates.length > 0
                  ? "No automatic suggestions were found. Choose a representative item in the page preview."
                  : "No repeating item groups were found on this page."}
              </p>
              {analysis.candidates.length === 0 && onBack ? (
                <button className="secondary-button" type="button" onClick={onBack}>
                  Try another page
                </button>
              ) : null}
            </div>
          )}
        </aside>
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {matchAnnouncement}
      </p>

      {selectedCandidate ? (
        <section className="web-feed-selected-preview" aria-labelledby={`${headingId}-preview`}>
          <div className="web-feed-preview-heading">
            <div>
              <h4 id={`${headingId}-preview`}>Feed preview</h4>
              <p>
                {selectedCandidate.itemCount} currently matched{" "}
                {selectedCandidate.itemCount === 1 ? "entry" : "entries"}
              </p>
            </div>
            <FieldAvailability candidate={selectedCandidate} />
          </div>
          {selectedCandidate.articles.length > 0 ? (
            <ol className="feed-preview-articles">
              {selectedCandidate.articles.map((article) => (
                <PreviewArticle
                  key={`${article.url ?? ""}\u0000${article.publishedAt ?? ""}\u0000${article.title}`}
                  article={article}
                />
              ))}
            </ol>
          ) : (
            <p className="feed-preview-empty">The selected group has no previewable entries.</p>
          )}
        </section>
      ) : null}
    </section>
  );
}
