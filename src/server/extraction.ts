import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";
import type { AppDatabase, ExtractionRecord } from "./db.js";

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    "article",
    "section",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "div",
    "span",
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "code",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "sub",
    "sup",
    "mark",
    "small",
    "a",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "figure",
    "figcaption",
    "picture",
    "img",
    "source",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "time",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
    source: ["src", "srcset", "type", "media", "sizes"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    time: ["datetime"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"], source: ["http", "https"] },
  allowProtocolRelative: false,
};

function absoluteUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function resolveRelativeUrls(html: string, baseUrl: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  try {
    for (const element of dom.window.document.querySelectorAll<HTMLElement>("[href], [src]")) {
      for (const attribute of ["href", "src"] as const) {
        const value = element.getAttribute(attribute);
        if (value) element.setAttribute(attribute, absoluteUrl(value, baseUrl));
      }
    }
    for (const element of dom.window.document.querySelectorAll<HTMLElement>("[srcset]")) {
      const value = element.getAttribute("srcset");
      if (!value) continue;
      element.setAttribute(
        "srcset",
        value
          .split(",")
          .map((candidate) => {
            const [candidateUrl, ...descriptor] = candidate.trim().split(/\s+/);
            return [absoluteUrl(candidateUrl, baseUrl), ...descriptor].join(" ");
          })
          .join(", "),
      );
    }
    for (const link of dom.window.document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    return dom.window.document.body.innerHTML;
  } finally {
    dom.window.close();
  }
}

export function cleanArticleHtml(html: string, baseUrl?: string): string {
  const normalized = baseUrl ? resolveRelativeUrls(html, baseUrl) : html;
  return sanitizeHtml(normalized, sanitizeOptions).trim();
}

function containsText(html: string): boolean {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim().length > 0;
}

function containsArticleMedia(html: string): boolean {
  return /<(?:img|picture)(?:\s|>)/i.test(html);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export type ExtractionOutcome = {
  contentHtml: string | null;
  contentSource: "article" | "feed" | null;
  status: "complete" | "feed" | "failed";
  error: string | null;
};

export async function extractArticle(
  record: ExtractionRecord,
  timeoutMs = 20_000,
): Promise<ExtractionOutcome> {
  const feedContent = record.feedContentHtml
    ? cleanArticleHtml(record.feedContentHtml, record.url ?? undefined)
    : null;
  if (feedContent && !containsText(feedContent) && containsArticleMedia(feedContent)) {
    return {
      contentHtml: feedContent,
      contentSource: "feed",
      status: "feed",
      error: null,
    };
  }

  let extractionError: string | null = null;
  if (record.url) {
    try {
      const response = await fetch(record.url, {
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "User-Agent": "Echovale/0.1 (+self-hosted RSS reader)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Article request returned HTTP ${response.status}`);
      const html = await response.text();
      const dom = new JSDOM(html, { url: response.url || record.url });
      try {
        const result = new Readability(dom.window.document).parse();
        if (!result?.content) throw new Error("No readable article content was found");
        const contentHtml = cleanArticleHtml(result.content, response.url || record.url);
        if (!containsText(contentHtml)) throw new Error("Extracted article content was empty");
        return {
          contentHtml,
          contentSource: "article",
          status: "complete",
          error: null,
        };
      } finally {
        dom.window.close();
      }
    } catch (error) {
      extractionError = message(error);
    }
  } else {
    extractionError = "Article has no URL";
  }

  if (feedContent) {
    if (containsText(feedContent) || containsArticleMedia(feedContent)) {
      return {
        contentHtml: feedContent,
        contentSource: "feed",
        status: "feed",
        error: extractionError,
      };
    }
  }

  return {
    contentHtml: null,
    contentSource: null,
    status: "failed",
    error: extractionError ?? "Feed did not include readable content",
  };
}

export class ExtractionQueue {
  private readonly pending: number[] = [];
  private readonly enqueued = new Set<number>();
  private active = 0;
  private stopped = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly database: AppDatabase,
    private readonly concurrency = 2,
    private readonly timeoutMs = 20_000,
  ) {}

  start(): void {
    this.refill();
  }

  enqueue(articleIds: number[]): void {
    if (this.stopped) return;
    for (const articleId of articleIds) {
      if (this.enqueued.has(articleId)) continue;
      this.enqueued.add(articleId);
      this.pending.push(articleId);
    }
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.pending.length > 0) {
      const articleId = this.pending.shift();
      if (articleId === undefined) break;
      this.active += 1;
      void this.process(articleId).finally(() => {
        this.active -= 1;
        this.enqueued.delete(articleId);
        this.refill();
        this.pump();
        this.resolveIdleIfNeeded();
      });
    }
    this.resolveIdleIfNeeded();
  }

  private async process(articleId: number): Promise<void> {
    const record = this.database.getExtractionRecord(articleId);
    if (!record || !this.database.markExtractionProcessing(articleId)) return;
    const outcome = await extractArticle(record, this.timeoutMs);
    this.database.completeExtraction(articleId, outcome);
  }

  private refill(): void {
    if (this.stopped) return;
    this.enqueue(this.database.getPendingExtractions(100).map((article) => article.id));
  }

  async waitForIdle(): Promise<void> {
    if (this.pending.length === 0 && this.active === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.length = 0;
    await this.waitForIdle();
  }

  private resolveIdleIfNeeded(): void {
    if (this.pending.length > 0 || this.active > 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
