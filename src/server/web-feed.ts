import { randomBytes, randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import type { WebFeedAnalysis, WebFeedConfig } from "../shared/types.js";
import type { ParsedFeed } from "./features/shared.js";
import {
  WebFeedBrowserLoader,
  type WebFeedBrowserLoaderOptions,
  webFeedContentRequestError,
} from "./web-feed-browser.js";
import {
  analyzeWebFeedDocument,
  extractWebFeedSelection,
  suggestedWebFeedCandidateIds,
} from "./web-feed-dom.js";
import { WebFeedError } from "./web-feed-error.js";
import { createWebFeedSnapshot } from "./web-feed-snapshot.js";

export { isBlockedNetworkAddress } from "./public-network.js";
export { WebFeedError } from "./web-feed-error.js";

const DEFAULT_SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
const MAX_SNAPSHOTS = 100;

export interface WebFeedServiceOptions extends WebFeedBrowserLoaderOptions {
  snapshotTtlMs?: number;
  now?: () => number;
}

export interface WebFeedExtraction {
  parsed: ParsedFeed;
  matchCount: number;
  httpStatus: number | null;
}

interface StoredSnapshot {
  userId: string;
  html: string;
  expiresAt: number;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export class WebFeedService {
  readonly #loader: WebFeedBrowserLoader;
  readonly #snapshotTtlMs: number;
  readonly #now: () => number;
  readonly #snapshots = new Map<string, StoredSnapshot>();

  constructor(options: WebFeedServiceOptions = {}) {
    this.#loader = new WebFeedBrowserLoader(options);
    this.#snapshotTtlMs = finitePositive(options.snapshotTtlMs, DEFAULT_SNAPSHOT_TTL_MS);
    this.#now = options.now ?? Date.now;
  }

  async analyze(
    userId: string,
    inputUrl: string,
    savedConfig: WebFeedConfig | null = null,
  ): Promise<WebFeedAnalysis> {
    const loaded = await this.#loader.load(inputUrl, savedConfig);
    const dom = new JSDOM(loaded.html, { url: loaded.pageUrl });
    try {
      const { document } = dom.window;
      const documentAnalysis = analyzeWebFeedDocument(document, loaded.pageUrl, savedConfig);
      const candidates = await this.#loader.publicCandidates(documentAnalysis.candidates);
      const savedSelectionMatched =
        documentAnalysis.savedCandidateId !== null &&
        candidates.some(({ candidate }) => candidate.id === documentAnalysis.savedCandidateId);
      const selectedCandidateId = savedSelectionMatched ? documentAnalysis.savedCandidateId : null;
      if (savedConfig && !savedSelectionMatched) {
        const loadingError = webFeedContentRequestError(loaded);
        if (loadingError) throw loadingError;
      }
      const suggestedCandidateIds = suggestedWebFeedCandidateIds(candidates);
      if (candidates.length === 0 && !savedConfig) {
        const loadingError = webFeedContentRequestError(loaded);
        if (loadingError) throw loadingError;
        if (!loaded.domContentLoaded) {
          throw new WebFeedError(
            "This webpage did not finish loading before echovale could find its items.",
            "javascript_timeout",
            loaded.httpStatus,
          );
        }
        throw new WebFeedError(
          "echovale could not find a repeated group of linked items on this webpage.",
          "unsupported_content",
          loaded.httpStatus,
        );
      }

      const messageToken = randomBytes(24).toString("base64url");
      const snapshotId = randomUUID();
      this.#pruneSnapshots();
      while (this.#snapshots.size >= MAX_SNAPSHOTS) {
        const oldest = this.#snapshots.keys().next().value;
        if (typeof oldest !== "string") break;
        this.#snapshots.delete(oldest);
      }
      this.#snapshots.set(snapshotId, {
        userId,
        html: createWebFeedSnapshot(document, candidates, messageToken),
        expiresAt: this.#now() + this.#snapshotTtlMs,
      });
      return {
        pageUrl: loaded.pageUrl,
        title: loaded.title,
        snapshotId,
        messageToken,
        candidates: candidates.map(({ candidate }) => candidate),
        suggestedCandidateIds,
        selectedCandidateId,
        savedSelectionMatched,
      };
    } finally {
      dom.window.close();
    }
  }

  async extract(config: WebFeedConfig): Promise<WebFeedExtraction> {
    const loaded = await this.#loader.load(config.pageUrl, config);
    const dom = new JSDOM(loaded.html, { url: loaded.pageUrl });
    try {
      const extracted = extractWebFeedSelection(
        dom.window.document,
        loaded.pageUrl,
        config.selectors,
      );
      const minimum = Math.max(1, Math.floor(config.minimumItemCount));
      if (!Number.isFinite(config.minimumItemCount) || extracted.articles.length < minimum) {
        const loadingError = webFeedContentRequestError(loaded);
        if (loadingError) throw loadingError;
        if (!loaded.domContentLoaded) {
          throw new WebFeedError(
            "This webpage did not finish loading before echovale could apply the saved selection.",
            "javascript_timeout",
            loaded.httpStatus,
          );
        }
        throw new WebFeedError(
          "The webpage structure or content has changed and the saved selection no longer finds enough items. Reload the page to repair it.",
          "selection_broken",
          loaded.httpStatus,
        );
      }
      await this.#loader.validateArticleUrls(
        extracted.articles.flatMap((article) => (article.url ? [article.url] : [])),
      );
      return {
        parsed: {
          title: loaded.title,
          siteUrl: loaded.pageUrl,
          articles: extracted.articles,
        },
        matchCount: extracted.articles.length,
        httpStatus: loaded.httpStatus,
      };
    } finally {
      dom.window.close();
    }
  }

  snapshot(userId: string, snapshotId: string): string {
    this.#pruneSnapshots();
    const snapshot = this.#snapshots.get(snapshotId);
    if (!snapshot || snapshot.userId !== userId) {
      throw new WebFeedError(
        "This webpage preview has expired. Reload the page to continue selecting items.",
        "inaccessible",
      );
    }
    return snapshot.html;
  }

  async close(): Promise<void> {
    this.#snapshots.clear();
    await this.#loader.close();
  }

  #pruneSnapshots(): void {
    const now = this.#now();
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= now) this.#snapshots.delete(id);
    }
  }
}
