import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ApplicationApi, ApplicationApiError } from "../../src/server/application-api.js";
import { AppDatabase, type ParsedFeed } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AiService } from "../../src/server/features/ai/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { TelegramMediaService } from "../../src/server/telegram-media.js";
import { WebFeedService } from "../../src/server/web-feed.js";
import { XMediaService } from "../../src/server/x-media.js";
import type {
  DesktopRequest,
  DesktopResponse,
  FeedfoldDesktopBridge,
} from "../../src/shared/desktop.js";

const TEST_USER_ID = 1;

async function waitFor(description: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function parsedArticle(
  externalId: string,
  title: string,
  publishedAt: string,
): ParsedFeed["articles"][number] {
  return {
    externalId,
    title,
    url: null,
    author: null,
    publishedAt,
    summary: `${title} summary`,
    imageUrl: null,
    feedContentHtml: null,
  };
}

function exposeBrowserGlobals(window: JSDOM["window"]): () => void {
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const expose = (key: PropertyKey, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };

  expose("window", window);
  expose("document", window.document);
  expose("navigator", window.navigator);
  expose("Element", window.Element);
  expose("HTMLElement", window.HTMLElement);
  expose("Node", window.Node);
  expose("Event", window.Event);
  expose("MouseEvent", window.MouseEvent);
  expose("KeyboardEvent", window.KeyboardEvent);
  expose("DOMException", window.DOMException);

  return () => {
    for (const [key, descriptor] of [...previous].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function articleHeading(container: HTMLElement): string | null {
  return (
    container
      .querySelector<HTMLElement>(".article-swipe-layer.is-active .article-header h2")
      ?.textContent?.trim() ?? null
  );
}

function nextArticleButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Next article (J)"]');
  if (!button) throw new Error("The article reader did not render its next button");
  return button;
}

function openArticleButton(container: HTMLElement, title: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".article-open-button")].find(
    (candidate) => candidate.textContent?.includes(`Open ${title}`),
  );
  if (!button) throw new Error(`The article list did not render ${title}`);
  return button;
}

describe("live article delivery", () => {
  it("continues from the last open article into an article delivered while reading", async () => {
    const database = new AppDatabase(":memory:");
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const webFeeds = new WebFeedService();
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, webFeeds);
    const application = new ApplicationApi({
      database,
      extractionQueue: extraction,
      refreshService: refresh,
      webFeedService: webFeeds,
      aiService: new AiService(database, { credentialCipher: null }),
      telegramMediaService: new TelegramMediaService(1_000),
      xMediaService: new XMediaService(1_000),
    });
    const feed = database.feeds.createFeed(TEST_USER_ID, {
      title: "Live reading",
      feedUrl: "https://example.test/live-reading.xml",
      folderId: null,
      paused: true,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: null,
        articles: [
          parsedArticle("starting", "Starting article", "2026-08-10T12:00:00.000Z"),
          parsedArticle("last-loaded", "Last loaded article", "2026-08-09T12:00:00.000Z"),
        ],
      },
    });

    const dataChangedListeners = new Set<() => void>();
    const invoke = async (request: DesktopRequest): Promise<DesktopResponse> => {
      try {
        return { ok: true, value: await application.invoke(request) };
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        return {
          ok: false,
          error: {
            message: error.message,
            status: caught instanceof ApplicationApiError ? caught.status : 500,
            code: caught instanceof ApplicationApiError ? caught.code : null,
          },
        };
      }
    };
    const bridge: FeedfoldDesktopBridge = {
      platform: "desktop",
      invoke,
      exportOpml: () => invoke({ operation: "exportOpml" }),
      onDataChanged: (listener) => {
        dataChangedListeners.add(listener);
        return () => dataChangedListeners.delete(listener);
      },
    };

    const dom = new JSDOM('<div id="app"></div>', {
      pretendToBeVisual: true,
      url: "https://feedfold.test/articles/unread",
    });
    Object.defineProperty(dom.window, "feedfoldDesktop", { configurable: true, value: bridge });
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }),
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
    dom.window.document.documentElement.dataset.inputModality = "keyboard";
    const restoreBrowserGlobals = exposeBrowserGlobals(dom.window);
    const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = dom.window.document.querySelector<HTMLElement>("#app");
    if (!container) throw new Error("The app fixture is incomplete");
    const root = createRoot(container);

    try {
      const appModulePath: string = "../../src/client/App.js";
      const { App } = await import(appModulePath);
      await act(async () => root.render(createElement(App)));
      await waitFor(
        "the initial unread articles",
        () => container.querySelectorAll(".article-open-button").length === 2,
      );
      expect(dataChangedListeners.size).toBe(1);

      await act(async () => openArticleButton(container, "Starting article").click());
      await waitFor(
        "the first article to open",
        () => articleHeading(container) === "Starting article",
      );
      expect(nextArticleButton(container).disabled).toBe(false);

      await act(async () => nextArticleButton(container).click());
      await waitFor(
        "the end of the initially loaded sequence",
        () => articleHeading(container) === "Last loaded article",
      );
      await waitFor(
        "the initial articles to be read",
        () =>
          database.articles.listArticlePage(TEST_USER_ID, { state: "unread" }).articles.length ===
          0,
      );
      expect(nextArticleButton(container).disabled).toBe(true);

      database.feeds.completeRefresh(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: {
          title: feed.title,
          siteUrl: null,
          articles: [
            parsedArticle("delivered", "Delivered while reading", "2026-08-11T12:00:00.000Z"),
          ],
        },
      });
      expect(
        database.articles
          .listArticlePage(TEST_USER_ID, { state: "unread" })
          .articles.map(({ title }) => title),
      ).toEqual(["Delivered while reading"]);

      await act(async () => {
        for (const listener of dataChangedListeners) listener();
      });
      await waitFor(
        "the delivered article to become reachable",
        () => !nextArticleButton(container).disabled,
      );
      expect(articleHeading(container)).toBe("Last loaded article");

      await act(async () => nextArticleButton(container).click());
      await waitFor(
        "navigation into the delivered article",
        () => articleHeading(container) === "Delivered while reading",
      );
      const delivered = database.articles
        .listArticlePage(TEST_USER_ID, { state: "all" })
        .articles.find(({ title }) => title === "Delivered while reading");
      expect(delivered).toBeDefined();
      expect(dom.window.location.pathname).toBe(`/articles/${delivered?.id}`);
    } finally {
      await act(async () => root.unmount());
      await Promise.all([refresh.stop(), extraction.stop()]);
      await webFeeds.close();
      database.close();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      restoreBrowserGlobals();
      dom.window.close();
    }
  });
});
