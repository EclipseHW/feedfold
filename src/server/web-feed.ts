import { createHash, randomBytes, randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  errors as playwrightErrors,
  type Request,
} from "playwright";
import type {
  FeedErrorKind,
  FeedPreviewArticle,
  WebFeedAnalysis,
  WebFeedCandidate,
  WebFeedConfig,
  WebFeedField,
  WebFeedSelectors,
} from "../shared/types.js";
import type { ParsedArticle, ParsedFeed } from "./db.js";
import {
  type PinnedAddress,
  PinnedPublicProxy,
  PublicNetworkError,
  publicProxyUrl,
  resolvePublicAddress,
} from "./public-network.js";

export { isBlockedNetworkAddress } from "./public-network.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_QUIET_MS = 500;
const DEFAULT_SETTLE_TIMEOUT_MS = 8_000;
const DEFAULT_SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_DOCUMENT_BYTES = 5 * 1_024 * 1_024;
const DEFAULT_MAX_RESOURCE_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_MAX_ELEMENTS = 50_000;
const DEFAULT_MAX_REQUESTS = 300;
const MAX_SNAPSHOTS = 100;
const MAX_MATCHED_ITEMS = 2_000;
const MAX_SUGGESTIONS = 8;
const MAX_SELECTABLE_CANDIDATES = 100;
const PREVIEW_ARTICLE_LIMIT = 5;
const MAX_INLINE_STYLE_BYTES = 2 * 1_024 * 1_024;
const MIN_CANDIDATE_SCORE = 28;

const REPEATED_ITEM_TAGS = new Set(["a", "article", "div", "li", "section", "tr"]);
const CONTENT_REQUEST_TYPES = new Set(["fetch", "script", "xhr"]);
const EXCLUDED_REGION_SELECTOR =
  'nav, header, footer, aside, [role="navigation"], [role="menu"], [aria-hidden="true"], [hidden]';
const EXCLUDED_REGION_NAME = /(?:^|[-_\s])(header|footer|nav|menu|sidebar)(?:$|[-_\s])/i;
const STATE_CLASS_PATTERN =
  /^(?:active|current|disabled|expanded|focus|focused|hidden|hover|open|selected)$/i;

export class WebFeedError extends Error {
  constructor(
    message: string,
    readonly kind: FeedErrorKind,
    readonly httpStatus: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebFeedError";
  }
}

export interface WebFeedServiceOptions {
  allowPrivateNetworks?: boolean;
  browserFactory?: () => Promise<Browser>;
  publicAddressResolver?: (hostname: string) => Promise<PinnedAddress>;
  timeoutMs?: number;
  settleQuietMs?: number;
  settleTimeoutMs?: number;
  snapshotTtlMs?: number;
  maxDocumentBytes?: number;
  maxResourceBytes?: number;
  maxElements?: number;
  maxRequests?: number;
  now?: () => number;
}

export interface WebFeedExtraction {
  parsed: ParsedFeed;
  matchCount: number;
  httpStatus: number | null;
}

interface LoadedPage {
  html: string;
  pageUrl: string;
  title: string;
  httpStatus: number | null;
  domContentLoaded: boolean;
  contentRequestFailure: ContentRequestFailure | null;
}

interface ContentRequestFailure {
  kind: "http" | "network";
  httpStatus: number | null;
}

interface StoredSnapshot {
  userId: string;
  html: string;
  expiresAt: number;
}

interface ExtractedSelection {
  articles: ParsedArticle[];
  elements: Element[];
}

interface RankedCandidate {
  candidate: WebFeedCandidate;
  elements: Element[];
  articleUrls: string[];
  linkKey: string;
  score: number;
}

type HostValidationCache = Map<string, Promise<void>>;

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function singleLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncated(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cssString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")
    .replaceAll("\f", "\\c ");
}

function stableClasses(element: Element): string[] {
  return [...element.classList]
    .filter((name) => name.length <= 80 && !STATE_CLASS_PATTERN.test(name))
    .sort();
}

function normalizedHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function imageUrl(element: Element | null, baseUrl: string): string | null {
  if (!element) return null;
  const direct =
    element.getAttribute("src") ??
    element.getAttribute("data-src") ??
    element.getAttribute("data-lazy-src") ??
    element.getAttribute("data-original") ??
    element.getAttribute("content");
  if (direct) return normalizedHttpUrl(direct, baseUrl);
  const srcset = element.getAttribute("srcset") ?? element.getAttribute("data-srcset");
  const first = srcset?.split(",", 1)[0]?.trim().split(/\s+/, 1)[0];
  return first ? normalizedHttpUrl(first, baseUrl) : null;
}

function parsedDate(element: Element | null): string | null {
  if (!element) return null;
  const value = singleLine(
    element.getAttribute("datetime") ??
      element.getAttribute("content") ??
      element.getAttribute("title") ??
      element.textContent,
  );
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function selectedElement(item: Element, selector: string | null): Element | null {
  if (!selector) return null;
  if (selector === ":scope") return item;
  return item.querySelector(selector);
}

function fieldSelector(items: Element[], patterns: string[]): string | null {
  let best: { selector: string; matches: number } | null = null;
  for (const selector of patterns) {
    let matches = 0;
    for (const item of items) {
      try {
        if (selectedElement(item, selector)) matches += 1;
      } catch {
        matches = 0;
        break;
      }
    }
    if (matches === 0) continue;
    if (!best || matches > best.matches) best = { selector, matches };
    if (matches === items.length) break;
  }
  return best?.selector ?? null;
}

function selectorsFor(items: Element[], itemSelector: string): WebFeedSelectors | null {
  const itemIsLink = items.every((item) => item.matches("a[href]"));
  const link = itemIsLink
    ? ":scope"
    : fieldSelector(items, [
        'a[itemprop~="url"][href]',
        'a[rel~="bookmark"][href]',
        "h1 a[href], h2 a[href], h3 a[href], h4 a[href]",
        'a[class*="title" i][href], a[class*="headline" i][href]',
        "a[href]",
      ]);
  if (!link) return null;
  const title =
    fieldSelector(items, [
      '[itemprop~="headline"]',
      '[itemprop~="name"]',
      "h1, h2, h3, h4, h5, h6",
      '[class*="headline" i]',
      '[class*="title" i]',
      '[class*="name" i]',
      link,
    ]) ?? link;
  return {
    item: itemSelector,
    title,
    link,
    date: fieldSelector(items, [
      "time[datetime]",
      '[itemprop~="datePublished"]',
      '[itemprop~="dateCreated"]',
      "time",
      '[class*="date" i]',
      '[class*="time" i]',
    ]),
    author: fieldSelector(items, [
      '[itemprop~="author"]',
      '[rel~="author"]',
      '[class*="byline" i]',
      '[class*="author" i]',
    ]),
    summary: fieldSelector(items, [
      '[itemprop~="description"]',
      '[class*="summary" i]',
      '[class*="excerpt" i]',
      '[class*="description" i]',
      "p",
    ]),
    image: fieldSelector(items, [
      '[itemprop~="image"] img',
      'img[itemprop~="image"]',
      "picture img",
      "img",
    ]),
  };
}

function fallbackTitle(url: string): string {
  const parsed = new URL(url);
  const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!lastSegment) return parsed.hostname;
  try {
    return singleLine(decodeURIComponent(lastSegment).replaceAll(/[-_]+/g, " ")) || parsed.hostname;
  } catch {
    return singleLine(lastSegment.replaceAll(/[-_]+/g, " ")) || parsed.hostname;
  }
}

function mergeDuplicate(existing: ParsedArticle, incoming: ParsedArticle): void {
  if (!existing.title && incoming.title) existing.title = incoming.title;
  if (!existing.author && incoming.author) existing.author = incoming.author;
  if (!existing.publishedAt && incoming.publishedAt) existing.publishedAt = incoming.publishedAt;
  if (!existing.summary && incoming.summary) {
    existing.summary = incoming.summary;
    existing.feedContentHtml = incoming.feedContentHtml;
  }
  if (!existing.imageUrl && incoming.imageUrl) existing.imageUrl = incoming.imageUrl;
}

function extractSelection(
  document: Document,
  pageUrl: string,
  selectors: WebFeedSelectors,
): ExtractedSelection {
  let items: Element[];
  try {
    items = [...document.querySelectorAll(selectors.item)];
  } catch {
    throw new WebFeedError(
      "The saved page selection is no longer valid. Reload the page to repair it.",
      "selection_broken",
    );
  }
  if (items.length > MAX_MATCHED_ITEMS) {
    throw new WebFeedError(
      "This selection matches too many page elements to create a reliable feed.",
      "unsupported_content",
    );
  }
  const articlesByUrl = new Map<string, ParsedArticle>();
  for (const item of items) {
    let linkElement: Element | null;
    let titleElement: Element | null;
    let dateElement: Element | null;
    let authorElement: Element | null;
    let summaryElement: Element | null;
    let imageElement: Element | null;
    try {
      linkElement = selectedElement(item, selectors.link);
      titleElement = selectedElement(item, selectors.title);
      dateElement = selectedElement(item, selectors.date);
      authorElement = selectedElement(item, selectors.author);
      summaryElement = selectedElement(item, selectors.summary);
      imageElement = selectedElement(item, selectors.image);
    } catch {
      throw new WebFeedError(
        "The saved page selection is no longer valid. Reload the page to repair it.",
        "selection_broken",
      );
    }
    const rawLink = linkElement?.getAttribute("href") ?? linkElement?.getAttribute("data-href");
    const url = rawLink ? normalizedHttpUrl(rawLink, pageUrl) : null;
    if (!url) continue;
    const linkText = singleLine(linkElement?.textContent);
    const title = truncated(
      singleLine(titleElement?.textContent) || linkText || fallbackTitle(url),
      500,
    );
    const author = truncated(singleLine(authorElement?.textContent), 200) || null;
    const summary = truncated(singleLine(summaryElement?.textContent), 4_000);
    const article: ParsedArticle = {
      externalId: url,
      title,
      url,
      author,
      publishedAt: parsedDate(dateElement),
      summary,
      imageUrl: imageUrl(imageElement, pageUrl),
      feedContentHtml: summary ? `<p>${htmlEscape(summary)}</p>` : null,
    };
    const existing = articlesByUrl.get(url);
    if (existing) mergeDuplicate(existing, article);
    else articlesByUrl.set(url, article);
  }
  return { articles: [...articlesByUrl.values()], elements: items };
}

function previewArticle(article: ParsedArticle): FeedPreviewArticle {
  return {
    title: article.title,
    url: article.url,
    author: article.author,
    publishedAt: article.publishedAt,
    summary: article.summary,
    imageUrl: article.imageUrl,
  };
}

function availableFields(articles: ParsedArticle[]): WebFeedField[] {
  const fields: WebFeedField[] = ["link"];
  if (articles.some((article) => article.title.length > 0)) fields.unshift("title");
  if (articles.some((article) => article.publishedAt)) fields.push("date");
  if (articles.some((article) => article.author)) fields.push("author");
  if (articles.some((article) => article.summary)) fields.push("summary");
  if (articles.some((article) => article.imageUrl)) fields.push("image");
  return fields;
}

function candidateId(config: WebFeedConfig): string {
  const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
  return `web-${hash}`;
}

function elementSegment(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute("id");
  if (id) return `${tag}[id="${cssString(id)}"]`;
  const classes = stableClasses(element).slice(0, 3);
  const classPart = classes.map((name) => `[class~="${cssString(name)}"]`).join("");
  const base = `${tag}${classPart}`;
  const parent = element.parentElement;
  if (!parent) return base;
  const peers = [...parent.children].filter((peer) => {
    if (peer.tagName !== element.tagName) return false;
    return classes.every((name) => peer.classList.contains(name));
  });
  if (peers.length <= 1) return base;
  const sameTag = [...parent.children].filter((peer) => peer.tagName === element.tagName);
  return `${base}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

function uniqueSelector(element: Element, document: Document): string {
  const id = element.getAttribute("id");
  if (id) {
    const selector = `[id="${cssString(id)}"]`;
    if (document.querySelectorAll(selector).length === 1) return selector;
  }
  const path: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName.toLowerCase() !== "html") {
    path.unshift(elementSegment(current));
    const selector = path.join(" > ");
    if (document.querySelectorAll(selector).length === 1) return selector;
    current = current.parentElement;
  }
  return `html > ${path.join(" > ")}`;
}

function sharedClasses(elements: Element[]): string[] {
  if (elements.length === 0) return [];
  const rest = elements.slice(1).map((element) => new Set(stableClasses(element)));
  return stableClasses(elements[0]).filter((name) => rest.every((classes) => classes.has(name)));
}

function itemSelector(parent: Element, elements: Element[], document: Document): string {
  const tag = elements[0]?.tagName.toLowerCase() ?? "div";
  const classes = sharedClasses(elements).slice(0, 4);
  const classPart = classes.map((name) => `[class~="${cssString(name)}"]`).join("");
  return `${uniqueSelector(parent, document)} > ${tag}${classPart}`;
}

function isExcludedRegion(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.matches(EXCLUDED_REGION_SELECTOR)) return true;
    const name = `${current.id} ${current.getAttribute("class") ?? ""}`;
    if (EXCLUDED_REGION_NAME.test(name)) return true;
    current = current.parentElement;
  }
  return false;
}

function isPotentialItem(element: Element, pageUrl: string): boolean {
  if (!REPEATED_ITEM_TAGS.has(element.tagName.toLowerCase())) return false;
  if (isExcludedRegion(element)) return false;
  const style = element.getAttribute("style")?.toLowerCase() ?? "";
  if (style.includes("display:none") || style.includes("visibility:hidden")) return false;
  const link = element.matches("a[href]") ? element : element.querySelector("a[href]");
  const href = link?.getAttribute("href");
  return Boolean(
    href && normalizedHttpUrl(href, pageUrl) && singleLine(element.textContent).length >= 3,
  );
}

function groupLabel(parent: Element, elements: Element[]): string {
  const explicit = singleLine(parent.getAttribute("aria-label"));
  if (explicit) return truncated(explicit, 80);
  const heading = parent.querySelector(":scope > h1, :scope > h2, :scope > h3");
  if (singleLine(heading?.textContent)) return truncated(singleLine(heading?.textContent), 80);
  let sibling = parent.previousElementSibling;
  while (sibling) {
    if (/^H[1-6]$/.test(sibling.tagName) && singleLine(sibling.textContent)) {
      return truncated(singleLine(sibling.textContent), 80);
    }
    if (sibling.tagName.toLowerCase() !== "script") break;
    sibling = sibling.previousElementSibling;
  }
  const words = `${parent.className} ${elements[0]?.className ?? ""}`.toLowerCase();
  if (/\bjob|career|position|vacanc/.test(words)) return "Jobs";
  if (/\bproduct|shop|store|catalog/.test(words)) return "Products";
  if (/\brelease|version|changelog/.test(words)) return "Releases";
  if (/\bannounce|notice|update/.test(words)) return "Announcements";
  if (/\barticle|post|story|news|entry/.test(words)) return "Articles";
  return "Page items";
}

function groupScore(parent: Element, elements: Element[], fields: WebFeedField[]): number {
  const first = elements[0];
  const tag = first?.tagName.toLowerCase();
  let score = Math.min(elements.length, 30) * 2 + fields.length * 6;
  if (tag === "article") score += 45;
  else if (tag === "li") score += 20;
  else if (tag === "tr") score += 12;
  const semantics = `${parent.className} ${first?.className ?? ""}`;
  if (/article|post|story|news|job|product|release|result|entry|card/i.test(semantics)) score += 24;
  if (parent.tagName.toLowerCase() === "body" || parent.tagName.toLowerCase() === "main")
    score -= 15;
  if (fields.includes("date")) score += 8;
  if (fields.includes("summary")) score += 5;
  if (fields.includes("image")) score += 4;
  return score;
}

function rankedCandidate(
  document: Document,
  pageUrl: string,
  parent: Element,
  elements: Element[],
): RankedCandidate | null {
  const selector = itemSelector(parent, elements, document);
  let selectedItems: Element[];
  try {
    selectedItems = [...document.querySelectorAll(selector)];
  } catch {
    return null;
  }
  const selectors = selectorsFor(selectedItems, selector);
  if (!selectors) return null;
  const extracted = extractSelection(document, pageUrl, selectors);
  if (extracted.articles.length < 2) return null;
  const config: WebFeedConfig = {
    pageUrl,
    selectors,
    minimumItemCount: Math.min(3, extracted.articles.length),
  };
  const fields = availableFields(extracted.articles);
  const score = groupScore(parent, elements, fields);
  const candidate: WebFeedCandidate = {
    id: candidateId(config),
    label: groupLabel(parent, elements),
    itemCount: extracted.articles.length,
    availableFields: fields,
    config,
    articles: extracted.articles.slice(0, PREVIEW_ARTICLE_LIMIT).map(previewArticle),
  };
  return {
    candidate,
    elements: selectedItems,
    articleUrls: extracted.articles.map((article) => article.url).filter((url) => url !== null),
    linkKey: extracted.articles
      .map((article) => article.externalId)
      .sort()
      .join("\n"),
    score,
  };
}

function detectCandidates(document: Document, pageUrl: string): RankedCandidate[] {
  const found: RankedCandidate[] = [];
  const parents = document.body
    ? [document.body, ...document.querySelectorAll("body *")]
    : [...document.querySelectorAll("*")];
  for (const parent of parents) {
    if (isExcludedRegion(parent)) continue;
    const eligible = [...parent.children].filter((child) => isPotentialItem(child, pageUrl));
    if (eligible.length < 2) continue;
    const groups = new Map<string, Element[]>();
    for (const element of eligible) {
      const tag = element.tagName.toLowerCase();
      const exactKey = `${tag}|${stableClasses(element).join(".")}`;
      const exact = groups.get(exactKey) ?? [];
      exact.push(element);
      groups.set(exactKey, exact);
      const tagKey = `${tag}|*`;
      const byTag = groups.get(tagKey) ?? [];
      byTag.push(element);
      groups.set(tagKey, byTag);
    }
    for (const elements of groups.values()) {
      if (elements.length < 2) continue;
      const candidate = rankedCandidate(document, pageUrl, parent, elements);
      if (candidate) found.push(candidate);
    }
  }
  found.sort(
    (left, right) =>
      right.score - left.score || right.candidate.itemCount - left.candidate.itemCount,
  );
  const unique: RankedCandidate[] = [];
  const seenLinks = new Set<string>();
  for (const candidate of found) {
    if (seenLinks.has(candidate.linkKey)) continue;
    seenLinks.add(candidate.linkKey);
    unique.push(candidate);
    if (unique.length === MAX_SELECTABLE_CANDIDATES) break;
  }
  return unique;
}

function candidateFromConfig(
  document: Document,
  pageUrl: string,
  savedConfig: WebFeedConfig,
): RankedCandidate | null {
  try {
    const extracted = extractSelection(document, pageUrl, savedConfig.selectors);
    if (extracted.articles.length < savedConfig.minimumItemCount) return null;
    const config: WebFeedConfig = { ...savedConfig, pageUrl };
    const fields = availableFields(extracted.articles);
    return {
      candidate: {
        id: candidateId(config),
        label: "Saved selection",
        itemCount: extracted.articles.length,
        availableFields: fields,
        config,
        articles: extracted.articles.slice(0, PREVIEW_ARTICLE_LIMIT).map(previewArticle),
      },
      elements: extracted.elements,
      articleUrls: extracted.articles.map((article) => article.url).filter((url) => url !== null),
      linkKey: extracted.articles
        .map((article) => article.externalId)
        .sort()
        .join("\n"),
      score: Number.POSITIVE_INFINITY,
    };
  } catch {
    return null;
  }
}

async function publicCandidates(
  candidates: RankedCandidate[],
  allowPrivateNetworks: boolean,
  cache: HostValidationCache,
  addressResolver: (hostname: string) => Promise<PinnedAddress>,
): Promise<RankedCandidate[]> {
  if (allowPrivateNetworks) return candidates;
  const accepted: RankedCandidate[] = [];
  for (const candidate of candidates) {
    try {
      for (const url of candidate.articleUrls) {
        await assertPublicPageUrl(url, false, cache, addressResolver);
      }
      accepted.push(candidate);
    } catch (error) {
      if (error instanceof WebFeedError && error.kind === "inaccessible") continue;
      throw error;
    }
  }
  return accepted;
}

function markCandidateElements(candidates: RankedCandidate[]): void {
  for (const { candidate, elements } of candidates) {
    for (const element of elements) {
      const ids = new Set((element.getAttribute("data-echovale-candidates") ?? "").split(/\s+/));
      ids.delete("");
      ids.add(candidate.id);
      element.setAttribute("data-echovale-candidates", [...ids].join(" "));
    }
  }
}

function safeSnapshotResource(element: Element, attributeName: string): boolean {
  const value = element.getAttribute(attributeName);
  if (!value) return false;
  return /^(?:data|blob):/i.test(value);
}

function pickerScript(messageToken: string): string {
  return `(() => {
  const MESSAGE_TOKEN = ${JSON.stringify(messageToken)};
  const ITEM_SELECTOR = "[data-echovale-candidates]";
  const INSTRUCTIONS_ID = "echovale-picker-instructions";
  let activeCandidateId = null;
  let pointerStart = null;

  const items = () => Array.from(document.querySelectorAll(ITEM_SELECTOR));
  const candidateIds = (element) => (element.getAttribute("data-echovale-candidates") || "")
    .split(/\\s+/).filter(Boolean);
  const setHighlight = (candidateId) => {
    activeCandidateId = candidateId;
    for (const element of items()) {
      const highlighted = Boolean(candidateId) && candidateIds(element).includes(candidateId);
      element.toggleAttribute("data-echovale-highlighted", highlighted);
      element.setAttribute("aria-pressed", String(highlighted));
    }
  };
  const select = (element) => {
    const ids = candidateIds(element);
    const candidateId = ids.includes(activeCandidateId) ? activeCandidateId : (ids[0] || null);
    if (!candidateId) return;
    setHighlight(candidateId);
    parent.postMessage({
      type: "echovale:web-feed-select",
      messageToken: MESSAGE_TOKEN,
      candidateId,
    }, "*");
  };
  const itemFor = (target) => target instanceof Element ? target.closest(ITEM_SELECTOR) : null;

  const instructions = document.createElement("p");
  instructions.id = INSTRUCTIONS_ID;
  instructions.textContent = "Selection mode. Links and controls are disabled. Use arrow keys to move between items, Enter or Space to select a group, and Escape to clear the selection.";
  Object.assign(instructions.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: "0",
  });
  document.body.prepend(instructions);

  for (const element of items()) {
    const visibleName = (element.querySelector("h1, h2, h3, h4, h5, h6")?.textContent ||
      element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", visibleName
      ? "Select the group represented by " + visibleName
      : "Select this group for the web feed");
    element.setAttribute("aria-describedby", INSTRUCTIONS_ID);
    element.setAttribute("aria-pressed", "false");
  }

  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== "echovale:web-feed-highlight" ||
        data.messageToken !== MESSAGE_TOKEN) return;
    setHighlight(typeof data.candidateId === "string" ? data.candidateId : null);
  });
  addEventListener("submit", (event) => event.preventDefault(), true);
  for (const eventName of ["auxclick", "dragstart", "drop"]) {
    addEventListener(eventName, (event) => event.preventDefault(), true);
  }
  addEventListener("pointerdown", (event) => {
    const item = itemFor(event.target);
    pointerStart = item ? { item, x: event.clientX, y: event.clientY, pointerId: event.pointerId } : null;
  }, true);
  addEventListener("pointerup", (event) => {
    const start = pointerStart;
    pointerStart = null;
    const item = itemFor(event.target);
    if (!start || !item || start.item !== item || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) select(item);
  }, true);
  addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.detail === 0) {
      const item = itemFor(event.target);
      if (item) select(item);
    }
  }, true);
  addEventListener("keydown", (event) => {
    const item = itemFor(event.target);
    if (event.key === "Escape") {
      event.preventDefault();
      setHighlight(null);
      parent.postMessage({
        type: "echovale:web-feed-select",
        messageToken: MESSAGE_TOKEN,
        candidateId: null,
      }, "*");
      return;
    }
    if (!item) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(item);
      return;
    }
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
    event.preventDefault();
    const allItems = items();
    const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const next = allItems[(allItems.indexOf(item) + offset + allItems.length) % allItems.length];
    next?.focus();
  }, true);
})();`;
}

function sanitizeSnapshot(document: Document, messageToken: string): string {
  document
    .querySelectorAll(
      "script, noscript, iframe, frame, object, embed, template, video, audio, meta[http-equiv], base",
    )
    .forEach((element) => {
      element.remove();
    });
  for (const link of document.querySelectorAll("link")) link.remove();
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "autofocus" || name === "nonce") {
        element.removeAttribute(attribute.name);
      }
    }
    element.removeAttribute("contenteditable");
    element.removeAttribute("formaction");
    element.removeAttribute("background");
    element.removeAttribute("ping");
    element.removeAttribute("xlink:href");
    if (element.matches("a, area")) element.removeAttribute("href");
    if (element.matches("form")) {
      element.removeAttribute("action");
      element.removeAttribute("method");
    }
    if (element.matches("button, input, select, textarea")) {
      element.setAttribute("disabled", "");
      element.setAttribute("tabindex", "-1");
    }
    if (element.hasAttribute("src") && !element.matches("img")) element.removeAttribute("src");
    if (element.hasAttribute("href")) element.removeAttribute("href");
    for (const attributeName of ["src", "href", "poster"] as const) {
      if (element.hasAttribute(attributeName) && !safeSnapshotResource(element, attributeName)) {
        element.removeAttribute(attributeName);
      }
    }
    for (const attributeName of ["srcset", "data-srcset"] as const) {
      element.removeAttribute(attributeName);
    }
    element.removeAttribute("data-src");
    element.removeAttribute("data-lazy-src");
    element.removeAttribute("data-original");
  }

  const head = document.head ?? document.documentElement.prepend(document.createElement("head"));
  const nonce = randomBytes(18).toString("base64url");
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
  head.prepend(csp);
  const pickerStyle = document.createElement("style");
  pickerStyle.textContent = `
    [data-echovale-candidates] {
      cursor: pointer !important;
      touch-action: pan-x pan-y pinch-zoom;
    }
    [data-echovale-candidates]:focus-visible {
      outline: 3px solid #2563eb !important;
      outline-offset: 3px !important;
    }
    [data-echovale-highlighted] {
      outline: 3px solid #2563eb !important;
      outline-offset: 3px !important;
      background-color: color-mix(in srgb, #2563eb 12%, transparent) !important;
    }
  `;
  head.append(pickerStyle);
  const script = document.createElement("script");
  script.setAttribute("nonce", nonce);
  script.textContent = pickerScript(messageToken);
  document.body?.append(script);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function pageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebFeedError("Enter a valid public webpage URL.", "inaccessible");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFeedError(
      "Only public HTTP and HTTPS webpages can become web feeds.",
      "inaccessible",
    );
  }
  if (url.username || url.password) {
    throw new WebFeedError(
      "Authenticated webpages are not supported by web feeds.",
      "inaccessible",
    );
  }
  return url;
}

async function assertPublicPageUrl(
  value: string,
  allowPrivateNetworks: boolean,
  cache: HostValidationCache,
  addressResolver: (hostname: string) => Promise<PinnedAddress>,
): Promise<void> {
  const url = pageUrl(value);
  if (allowPrivateNetworks) return;
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  let validation = cache.get(hostname);
  if (!validation) {
    validation = addressResolver(hostname)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (error instanceof PublicNetworkError) {
          throw new WebFeedError(error.message, error.kind);
        }
        throw error;
      });
    cache.set(hostname, validation);
  }
  await validation;
}

function challengeDetected(title: string, bodyText: string): boolean {
  const pageText = `${title}\n${bodyText}`.toLowerCase();
  return [
    "verify you are human",
    "checking your browser",
    "complete the security check",
    "attention required! | cloudflare",
    "cf-chl-",
  ].some((phrase) => pageText.includes(phrase));
}

async function detectedChallenge(page: Page): Promise<boolean> {
  const content = await page.evaluate(() => ({
    title: document.title,
    bodyText: (document.body?.innerText ?? "").slice(0, 50_000),
  }));
  return challengeDetected(content.title, content.bodyText);
}

function contentRequestError(loaded: LoadedPage): WebFeedError | null {
  const failure = loaded.contentRequestFailure;
  if (!failure) return null;
  if (failure.kind === "http" && failure.httpStatus !== null) {
    return new WebFeedError(
      `This webpage could not finish loading its items because a page request returned HTTP ${failure.httpStatus}.`,
      "http",
      failure.httpStatus,
    );
  }
  return new WebFeedError(
    "This webpage could not finish loading its items because a page request failed.",
    "network",
  );
}

async function settleDom(
  page: Page,
  quietMs: number,
  timeoutMs: number,
  expectedConfig: WebFeedConfig | null,
  pendingRequestBinding: string,
): Promise<"ready" | "quiet_missing_selection" | "timeout"> {
  const minimumWaitMs = Math.min(timeoutMs, Math.max(expectedConfig ? 1_000 : 3_000, quietMs, 250));
  return page.evaluate(
    ({ expectedConfig, minimumWaitMs, pendingRequestBinding, quietMs, timeoutMs }) =>
      new Promise<"ready" | "quiet_missing_selection" | "timeout">((resolve) => {
        const root = document.documentElement;
        if (!root) {
          resolve("ready");
          return;
        }
        const startedAt = performance.now();
        let lastMutationAt = startedAt;
        let repeatedItemsCheckedAt = -1;
        let repeatedItemsReady = false;
        const observer = new MutationObserver(() => {
          lastMutationAt = performance.now();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        const timer = setInterval(
          async () => {
            const now = performance.now();
            const quiet = now - lastMutationAt >= quietMs;
            const pendingRequests = await (
              window as unknown as Record<string, () => Promise<number>>
            )[pendingRequestBinding]();
            if (
              expectedConfig === null &&
              pendingRequests > 0 &&
              now - startedAt >= minimumWaitMs &&
              quiet &&
              repeatedItemsCheckedAt !== lastMutationAt
            ) {
              repeatedItemsCheckedAt = lastMutationAt;
              for (const parent of document.querySelectorAll("body, body *")) {
                if (
                  parent.closest(
                    'nav, header, footer, aside, [role="navigation"], [role="menu"], [aria-hidden="true"], [hidden]',
                  )
                ) {
                  continue;
                }
                const counts = new Map<string, number>();
                for (const child of parent.children) {
                  const tag = child.tagName.toLowerCase();
                  if (!["a", "article", "div", "li", "section", "tr"].includes(tag)) continue;
                  const link = child.matches("a[href]") ? child : child.querySelector("a[href]");
                  const rawHref = link?.getAttribute("href");
                  if (!rawHref) continue;
                  try {
                    const url = new URL(rawHref, location.href);
                    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                  } catch {
                    continue;
                  }
                  const count = (counts.get(tag) ?? 0) + 1;
                  counts.set(tag, count);
                  if (count >= 2) {
                    repeatedItemsReady = true;
                    break;
                  }
                }
                if (repeatedItemsReady) break;
              }
            }
            let expectedSelectionReady = expectedConfig === null;
            if (expectedConfig) {
              try {
                let matches = 0;
                for (const item of document.querySelectorAll(expectedConfig.selectors.item)) {
                  const link =
                    expectedConfig.selectors.link === ":scope"
                      ? item
                      : item.querySelector(expectedConfig.selectors.link);
                  const rawHref = link?.getAttribute("href") ?? link?.getAttribute("data-href");
                  if (!rawHref) continue;
                  const url = new URL(rawHref, location.href);
                  if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                  matches += 1;
                  if (matches >= expectedConfig.minimumItemCount) {
                    expectedSelectionReady = true;
                    break;
                  }
                }
              } catch {
                expectedSelectionReady = false;
              }
            }
            if (
              now - startedAt >= minimumWaitMs &&
              quiet &&
              expectedSelectionReady &&
              (expectedConfig !== null || pendingRequests === 0 || repeatedItemsReady)
            ) {
              clearInterval(timer);
              observer.disconnect();
              resolve("ready");
            } else if (now - startedAt >= timeoutMs) {
              clearInterval(timer);
              observer.disconnect();
              resolve(
                expectedConfig !== null && quiet && pendingRequests === 0
                  ? "quiet_missing_selection"
                  : "timeout",
              );
            }
          },
          Math.min(100, quietMs),
        );
      }),
    { expectedConfig, minimumWaitMs, pendingRequestBinding, quietMs, timeoutMs },
  );
}

async function materializeOpenShadowRoots(page: Page): Promise<void> {
  await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      for (const element of root.querySelectorAll("*")) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        const container = document.createElement("div");
        container.setAttribute("data-echovale-shadow-root", "");
        for (const child of element.shadowRoot.childNodes) container.append(child.cloneNode(true));
        element.append(container);
      }
    }
  });
}

async function inlineComputedStyles(page: Page, byteLimit: number): Promise<void> {
  await page.evaluate((byteLimit) => {
    const properties = [
      "accent-color",
      "align-content",
      "align-items",
      "align-self",
      "aspect-ratio",
      "background-color",
      "border-bottom-color",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "border-bottom-style",
      "border-bottom-width",
      "border-left-color",
      "border-left-style",
      "border-left-width",
      "border-right-color",
      "border-right-style",
      "border-right-width",
      "border-top-color",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-top-style",
      "border-top-width",
      "box-shadow",
      "box-sizing",
      "clear",
      "color",
      "column-gap",
      "display",
      "flex-basis",
      "flex-direction",
      "flex-grow",
      "flex-shrink",
      "flex-wrap",
      "float",
      "font-family",
      "font-size",
      "font-style",
      "font-weight",
      "gap",
      "grid-auto-columns",
      "grid-auto-flow",
      "grid-auto-rows",
      "grid-template-columns",
      "grid-template-rows",
      "height",
      "justify-content",
      "justify-items",
      "justify-self",
      "letter-spacing",
      "line-height",
      "list-style-position",
      "list-style-type",
      "margin-bottom",
      "margin-left",
      "margin-right",
      "margin-top",
      "max-height",
      "max-width",
      "min-height",
      "min-width",
      "object-fit",
      "opacity",
      "order",
      "overflow-wrap",
      "overflow-x",
      "overflow-y",
      "padding-bottom",
      "padding-left",
      "padding-right",
      "padding-top",
      "position",
      "row-gap",
      "table-layout",
      "text-align",
      "text-decoration-color",
      "text-decoration-line",
      "text-decoration-style",
      "text-indent",
      "text-overflow",
      "text-transform",
      "transform",
      "transform-origin",
      "vertical-align",
      "visibility",
      "white-space",
      "width",
      "word-break",
      "z-index",
    ];
    const elements: Element[] = [];
    const roots: Array<Document | ShadowRoot> = [document];
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      for (const element of root.querySelectorAll("*")) {
        elements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const captured: Array<{ element: HTMLElement | SVGElement; cssText: string }> = [];
    let capturedBytes = 0;
    for (const element of elements) {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
      if (
        element.matches("script, noscript, iframe, frame, object, embed, template, style, link")
      ) {
        continue;
      }
      const computed = getComputedStyle(element);
      const hidden = computed.display === "none" || computed.visibility === "hidden";
      const selectedProperties = hidden ? ["display", "visibility"] : properties;
      const cssText = selectedProperties
        .map((property) => `${property}:${computed.getPropertyValue(property)};`)
        .join("");
      const nextBytes = new TextEncoder().encode(cssText).byteLength;
      if (capturedBytes + nextBytes > byteLimit) break;
      capturedBytes += nextBytes;
      captured.push({ element, cssText });
    }
    for (const { element, cssText } of captured) element.style.cssText = cssText;
  }, byteLimit);
}

function browserFailure(error: unknown): WebFeedError {
  if (error instanceof WebFeedError) return error;
  if (error instanceof playwrightErrors.TimeoutError) {
    return new WebFeedError("This webpage took too long to load.", "timeout", null, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : "Unknown browser error";
  if (/executable doesn't exist|browser.*not found|failed to launch/i.test(message)) {
    return new WebFeedError(
      "JavaScript webpage loading is not available on this Echovale installation.",
      "unsupported_content",
      null,
      { cause: error },
    );
  }
  return new WebFeedError("Could not load this webpage.", "network", null, { cause: error });
}

export class WebFeedService {
  readonly #allowPrivateNetworks: boolean;
  readonly #addressResolver: (hostname: string) => Promise<PinnedAddress>;
  readonly #browserFactory: () => Promise<Browser>;
  readonly #usesSharedPublicProxy: boolean;
  readonly #timeoutMs: number;
  readonly #settleQuietMs: number;
  readonly #settleTimeoutMs: number;
  readonly #snapshotTtlMs: number;
  readonly #maxDocumentBytes: number;
  readonly #maxResourceBytes: number;
  readonly #maxElements: number;
  readonly #maxRequests: number;
  readonly #now: () => number;
  readonly #snapshots = new Map<string, StoredSnapshot>();
  #browserPromise: Promise<Browser> | null = null;
  #customPublicProxy: PinnedPublicProxy | null = null;
  #closed = false;

  constructor(options: WebFeedServiceOptions = {}) {
    this.#allowPrivateNetworks = options.allowPrivateNetworks ?? false;
    this.#addressResolver = options.publicAddressResolver ?? resolvePublicAddress;
    this.#usesSharedPublicProxy = options.publicAddressResolver === undefined;
    this.#browserFactory =
      options.browserFactory ??
      (() =>
        chromium.launch({
          args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
          headless: true,
          chromiumSandbox: process.platform === "linux",
        }));
    this.#timeoutMs = finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#settleQuietMs = finitePositive(options.settleQuietMs, DEFAULT_SETTLE_QUIET_MS);
    this.#settleTimeoutMs = finitePositive(options.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS);
    this.#snapshotTtlMs = finitePositive(options.snapshotTtlMs, DEFAULT_SNAPSHOT_TTL_MS);
    this.#maxDocumentBytes = finitePositive(options.maxDocumentBytes, DEFAULT_MAX_DOCUMENT_BYTES);
    this.#maxResourceBytes = finitePositive(options.maxResourceBytes, DEFAULT_MAX_RESOURCE_BYTES);
    this.#maxElements = finitePositive(options.maxElements, DEFAULT_MAX_ELEMENTS);
    this.#maxRequests = finitePositive(options.maxRequests, DEFAULT_MAX_REQUESTS);
    this.#now = options.now ?? Date.now;
  }

  async analyze(
    userId: string,
    inputUrl: string,
    savedConfig: WebFeedConfig | null = null,
  ): Promise<WebFeedAnalysis> {
    const loaded = await this.#load(inputUrl, savedConfig);
    const dom = new JSDOM(loaded.html, { url: loaded.pageUrl });
    try {
      const { document } = dom.window;
      let candidates = detectCandidates(document, loaded.pageUrl);
      let savedCandidateId: string | null = null;
      if (savedConfig) {
        const saved = candidateFromConfig(document, loaded.pageUrl, savedConfig);
        if (saved) {
          savedCandidateId = saved.candidate.id;
          candidates = [
            saved,
            ...candidates.filter((candidate) => candidate.linkKey !== saved.linkKey),
          ];
          candidates = candidates.slice(0, MAX_SELECTABLE_CANDIDATES);
        }
      }
      candidates = await publicCandidates(
        candidates,
        this.#allowPrivateNetworks,
        new Map(),
        this.#addressResolver,
      );
      const savedSelectionMatched =
        savedCandidateId !== null &&
        candidates.some(({ candidate }) => candidate.id === savedCandidateId);
      const selectedCandidateId = savedSelectionMatched ? savedCandidateId : null;
      if (savedConfig && !savedSelectionMatched) {
        const loadingError = contentRequestError(loaded);
        if (loadingError) throw loadingError;
      }
      const suggestedCandidateIds = candidates
        .filter(({ score }) => score >= MIN_CANDIDATE_SCORE)
        .slice(0, MAX_SUGGESTIONS)
        .map(({ candidate }) => candidate.id);
      if (candidates.length === 0 && !savedConfig) {
        const loadingError = contentRequestError(loaded);
        if (loadingError) throw loadingError;
        if (!loaded.domContentLoaded) {
          throw new WebFeedError(
            "This webpage did not finish loading before Echovale could find its items.",
            "javascript_timeout",
            loaded.httpStatus,
          );
        }
        throw new WebFeedError(
          "Echovale could not find a repeated group of linked items on this webpage.",
          "unsupported_content",
          loaded.httpStatus,
        );
      }
      markCandidateElements(candidates);
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
        html: sanitizeSnapshot(document, messageToken),
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
    const loaded = await this.#load(config.pageUrl, config);
    const dom = new JSDOM(loaded.html, { url: loaded.pageUrl });
    try {
      const extracted = extractSelection(dom.window.document, loaded.pageUrl, config.selectors);
      const minimum = Math.max(1, Math.floor(config.minimumItemCount));
      if (!Number.isFinite(config.minimumItemCount) || extracted.articles.length < minimum) {
        const loadingError = contentRequestError(loaded);
        if (loadingError) throw loadingError;
        if (!loaded.domContentLoaded) {
          throw new WebFeedError(
            "This webpage did not finish loading before Echovale could apply the saved selection.",
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
      const articleValidationCache: HostValidationCache = new Map();
      for (const article of extracted.articles) {
        if (article.url) {
          await assertPublicPageUrl(
            article.url,
            this.#allowPrivateNetworks,
            articleValidationCache,
            this.#addressResolver,
          );
        }
      }
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
    this.#closed = true;
    this.#snapshots.clear();
    const browserPromise = this.#browserPromise;
    this.#browserPromise = null;
    if (browserPromise) {
      const browser = await browserPromise.catch(() => null);
      await browser?.close().catch(() => undefined);
    }
    await this.#customPublicProxy?.close();
    this.#customPublicProxy = null;
  }

  #pruneSnapshots(): void {
    const now = this.#now();
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= now) this.#snapshots.delete(id);
    }
  }

  async #browser(): Promise<Browser> {
    if (this.#closed) throw new WebFeedError("Web feed loading has stopped.", "network");
    if (!this.#browserPromise) {
      const browserPromise = this.#browserFactory();
      this.#browserPromise = browserPromise;
      void browserPromise.then(
        (browser) => {
          browser.once("disconnected", () => {
            if (this.#browserPromise === browserPromise) this.#browserPromise = null;
          });
        },
        () => {
          if (this.#browserPromise === browserPromise) this.#browserPromise = null;
        },
      );
    }
    try {
      return await this.#browserPromise;
    } catch (error) {
      throw browserFailure(error);
    }
  }

  async #proxyUrl(): Promise<string> {
    if (this.#usesSharedPublicProxy) return publicProxyUrl();
    this.#customPublicProxy ??= new PinnedPublicProxy(this.#timeoutMs, this.#addressResolver);
    return this.#customPublicProxy.url();
  }

  async #load(inputUrl: string, expectedConfig: WebFeedConfig | null = null): Promise<LoadedPage> {
    const validationCache: HostValidationCache = new Map();
    await assertPublicPageUrl(
      inputUrl,
      this.#allowPrivateNetworks,
      validationCache,
      this.#addressResolver,
    );
    const browser = await this.#browser();
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let fatalError: WebFeedError | null = null;
    let requestCount = 0;
    let declaredResourceBytes = 0;
    let transferredResourceBytes = 0;
    let contentRequestFailure: ContentRequestFailure | null = null;
    const pendingContentRequests = new Set<Request>();
    const pendingRequestBinding = `__echovalePending${randomBytes(12).toString("hex")}`;
    try {
      context = await browser.newContext({
        acceptDownloads: false,
        javaScriptEnabled: true,
        permissions: [],
        proxy: this.#allowPrivateNetworks ? undefined : { server: await this.#proxyUrl() },
        serviceWorkers: "block",
        viewport: { width: 900, height: 900 },
      });
      page = await context.newPage();
      await page.exposeFunction(pendingRequestBinding, () => pendingContentRequests.size);
      page.on("request", (request) => {
        if (CONTENT_REQUEST_TYPES.has(request.resourceType())) {
          pendingContentRequests.add(request);
        }
      });
      page.on("requestfinished", (request) => pendingContentRequests.delete(request));
      page.on("requestfailed", (request) => {
        if (CONTENT_REQUEST_TYPES.has(request.resourceType())) {
          pendingContentRequests.delete(request);
          contentRequestFailure ??= { kind: "network", httpStatus: null };
        }
      });
      const devtools = await context.newCDPSession(page);
      await devtools.send("Network.enable");
      devtools.on("Network.dataReceived", (event) => {
        transferredResourceBytes += event.dataLength;
        if (transferredResourceBytes > this.#maxResourceBytes && !fatalError) {
          fatalError = new WebFeedError(
            "This webpage loads too much data to create a reliable web feed.",
            "unsupported_content",
          );
          void page?.close();
        }
      });
      page.on("dialog", (dialog) => void dialog.dismiss());
      page.on("download", (download) => void download.cancel());
      page.on("popup", (popup) => void popup.close());
      page.on("response", (response) => {
        if (
          CONTENT_REQUEST_TYPES.has(response.request().resourceType()) &&
          response.status() >= 400
        ) {
          contentRequestFailure ??= { kind: "http", httpStatus: response.status() };
        }
        const length = Number(response.headers()["content-length"]);
        if (!Number.isFinite(length) || length <= 0) return;
        declaredResourceBytes += length;
        if (declaredResourceBytes > this.#maxResourceBytes && !fatalError) {
          fatalError = new WebFeedError(
            "This webpage loads too much data to create a reliable web feed.",
            "unsupported_content",
          );
          void page?.close();
        }
      });
      await context.route("**/*", async (route) => {
        requestCount += 1;
        if (requestCount > this.#maxRequests) {
          fatalError ??= new WebFeedError(
            "This webpage makes too many requests to create a reliable web feed.",
            "unsupported_content",
          );
          await route.abort("blockedbyclient");
          return;
        }
        const request = route.request();
        if (request.resourceType() === "media") {
          await route.abort("blockedbyclient");
          return;
        }
        try {
          const requestUrl = request.url();
          if (!/^(?:about|blob|data):/i.test(requestUrl)) {
            await assertPublicPageUrl(
              requestUrl,
              this.#allowPrivateNetworks,
              validationCache,
              this.#addressResolver,
            );
          }
          await route.continue();
        } catch (error) {
          if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) {
            fatalError = browserFailure(error);
          }
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket(/.*/, async (socket) => {
        try {
          const socketUrl = socket.url().replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
          await assertPublicPageUrl(
            socketUrl,
            this.#allowPrivateNetworks,
            validationCache,
            this.#addressResolver,
          );
          socket.connectToServer();
        } catch {
          await socket.close({ code: 1008, reason: "Private network connections are blocked" });
        }
      });

      let response: Awaited<ReturnType<Page["goto"]>>;
      try {
        response = await page.goto(pageUrl(inputUrl).toString(), {
          timeout: this.#timeoutMs,
          waitUntil: "commit",
        });
      } catch (error) {
        if (fatalError) throw fatalError;
        throw browserFailure(error);
      }
      if (fatalError) throw fatalError;
      if (!response) throw new WebFeedError("Could not load this webpage.", "network");
      const status = response.status();
      if (status === 401 || status === 407) {
        throw new WebFeedError("This webpage is not publicly accessible.", "inaccessible", status);
      }
      if (status === 403 || status === 429) {
        throw new WebFeedError(
          "This webpage blocked automated loading or requires a security check.",
          "access_blocked",
          status,
        );
      }
      if (status >= 400) {
        throw new WebFeedError(`This webpage returned HTTP ${status}.`, "http", status);
      }
      const headers = response.headers();
      const contentType = headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
        throw new WebFeedError(
          "This URL does not return a supported HTML webpage.",
          "unsupported_content",
          status,
        );
      }
      if (/attachment/i.test(headers["content-disposition"] ?? "")) {
        throw new WebFeedError(
          "Downloads cannot be converted into web feeds.",
          "unsupported_content",
          status,
        );
      }
      const declaredDocumentBytes = Number(headers["content-length"]);
      if (
        Number.isFinite(declaredDocumentBytes) &&
        declaredDocumentBytes > this.#maxDocumentBytes
      ) {
        throw new WebFeedError(
          "This webpage is too large to create a reliable web feed.",
          "unsupported_content",
          status,
        );
      }
      const domContentLoaded = await page
        .waitForLoadState("domcontentloaded", {
          timeout: Math.min(5_000, this.#timeoutMs),
        })
        .then(
          () => true,
          () => false,
        );
      if (await detectedChallenge(page)) {
        throw new WebFeedError(
          "This webpage requires a CAPTCHA or bot-protection check that Echovale cannot bypass.",
          "access_blocked",
          status,
        );
      }
      const settled = await settleDom(
        page,
        this.#settleQuietMs,
        this.#settleTimeoutMs,
        expectedConfig,
        pendingRequestBinding,
      );
      if (settled === "timeout") {
        throw new WebFeedError(
          "This webpage's JavaScript did not finish updating the page in time.",
          "javascript_timeout",
          status,
        );
      }
      if (fatalError) throw fatalError;
      const title =
        singleLine(await page.title()) || new URL(page.url()).hostname.replace(/^www\./, "");
      const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
      if (challengeDetected(title, bodyText.slice(0, 50_000))) {
        throw new WebFeedError(
          "This webpage requires a CAPTCHA or bot-protection check that Echovale cannot bypass.",
          "access_blocked",
          status,
        );
      }
      const initialElementCount = await page.locator("*").count();
      if (initialElementCount > this.#maxElements) {
        throw new WebFeedError(
          "This webpage has too many elements to create a reliable web feed.",
          "unsupported_content",
          status,
        );
      }
      await inlineComputedStyles(
        page,
        Math.min(MAX_INLINE_STYLE_BYTES, Math.floor(this.#maxDocumentBytes / 2)),
      );
      await materializeOpenShadowRoots(page);
      const elementCount = await page.locator("*").count();
      if (elementCount > this.#maxElements) {
        throw new WebFeedError(
          "This webpage has too many elements to create a reliable web feed.",
          "unsupported_content",
          status,
        );
      }
      const html = await page.content();
      if (Buffer.byteLength(html, "utf8") > this.#maxDocumentBytes) {
        throw new WebFeedError(
          "This webpage is too large to create a reliable web feed.",
          "unsupported_content",
          status,
        );
      }
      if (!singleLine(bodyText)) {
        if (!domContentLoaded) {
          throw new WebFeedError(
            "This webpage did not finish loading before Echovale could read its content.",
            "javascript_timeout",
            status,
          );
        }
        throw new WebFeedError(
          "This webpage did not produce readable content after loading.",
          "unsupported_content",
          status,
        );
      }
      return {
        html,
        pageUrl: page.url(),
        title,
        httpStatus: status,
        domContentLoaded,
        contentRequestFailure,
      };
    } catch (error) {
      if (fatalError) throw fatalError;
      throw browserFailure(error);
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
}
