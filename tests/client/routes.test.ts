import { describe, expect, it } from "vitest";
import {
  type AppRoute,
  appRoutePath,
  appRouteUrl,
  DEFAULT_READER_ROUTE,
  parseAppRoute,
  routeAfterFeedDeletion,
} from "../../src/client/routes.js";

const BASE_PATH = "/echovale/";

describe("application routes", () => {
  it.each([
    [{ kind: "feeds" }, "/feeds"],
    [{ kind: "add-feed", sourceUrl: "" }, "/feeds/add"],
    [
      { kind: "add-feed", sourceUrl: "https://example.com/feed.xml?format=rss#latest" },
      "/feeds/add/https%3A%2F%2Fexample.com%2Ffeed.xml%3Fformat%3Drss%23latest",
    ],
    [{ kind: "rules" }, "/rules"],
    [{ kind: "settings" }, "/settings"],
    [
      { kind: "reader", scope: "all", scopeId: null, state: "starred", search: "" },
      "/articles/starred",
    ],
    [
      { kind: "reader", scope: "folder", scopeId: 42, state: "read", search: "sqlite wal" },
      "/folders/42/read?q=sqlite+wal",
    ],
    [{ kind: "reader", scope: "feed", scopeId: 7, state: "all", search: "" }, "/feeds/7/all"],
    [{ kind: "article", articleId: 123 }, "/articles/123"],
  ] satisfies Array<[AppRoute, string]>)("round-trips %#", (route, path) => {
    expect(appRoutePath(route)).toBe(path);
    const url = new URL(appRouteUrl(route, BASE_PATH), "https://example.test");
    expect(parseAppRoute(url.pathname, url.search, BASE_PATH)).toEqual(route);
  });

  it("uses the canonical unread page for the app root and malformed paths", () => {
    expect(parseAppRoute("/echovale/", "", BASE_PATH)).toEqual(DEFAULT_READER_ROUTE);
    expect(parseAppRoute("/echovale/articles/0", "", BASE_PATH)).toEqual(DEFAULT_READER_ROUTE);
    expect(parseAppRoute("/echovale/folders/nope/all", "", BASE_PATH)).toEqual(
      DEFAULT_READER_ROUTE,
    );
    expect(parseAppRoute("/another-app/settings", "", BASE_PATH)).toEqual(DEFAULT_READER_ROUTE);
  });

  it("keeps submitted search only on collection routes", () => {
    expect(parseAppRoute("/echovale/feeds/9/unread", "?q=%20AI%20agents%20", BASE_PATH)).toEqual({
      kind: "reader",
      scope: "feed",
      scopeId: 9,
      state: "unread",
      search: "AI agents",
    });
    expect(parseAppRoute("/echovale/settings", "?q=ignored", BASE_PATH)).toEqual({
      kind: "settings",
    });
    expect(parseAppRoute("/echovale/articles/8", "?q=ignored", BASE_PATH)).toEqual({
      kind: "article",
      articleId: 8,
    });
  });

  it("accepts an unescaped feed URL across the remaining path", () => {
    expect(
      parseAppRoute("/echovale/feeds/add/https://example.com/news/feed.xml", "", BASE_PATH),
    ).toEqual({
      kind: "add-feed",
      sourceUrl: "https://example.com/news/feed.xml",
    });
  });

  it("keeps the feeds management page open after deleting a subscription", () => {
    expect(routeAfterFeedDeletion({ kind: "feeds" }, DEFAULT_READER_ROUTE, 7)).toBeNull();
  });

  it("leaves reader routes only when the deleted feed invalidates the page", () => {
    const selectedFeedRoute = {
      kind: "reader",
      scope: "feed",
      scopeId: 7,
      state: "starred",
      search: "sqlite",
    } satisfies AppRoute;

    expect(routeAfterFeedDeletion(selectedFeedRoute, selectedFeedRoute, 7)).toEqual({
      kind: "reader",
      scope: "all",
      scopeId: null,
      state: "starred",
      search: "sqlite",
    });
    expect(routeAfterFeedDeletion(DEFAULT_READER_ROUTE, DEFAULT_READER_ROUTE, 7)).toBeNull();
  });
});
