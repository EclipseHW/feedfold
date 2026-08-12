import { fetchPublic } from "./public-network.js";

const NITTER_HOST = "nitter.net";
const NITTER_USERNAME = /^[a-zA-Z0-9_]{1,15}$/;
const NITTER_TIMELINE_TABS = new Set(["media", "search", "with_replies"]);
const GITHUB_HOST = "github.com";
const GITHUB_GIST_HOST = "gist.github.com";

export function githubFeedUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const isProfile =
    parts.length === 1 &&
    (url.hostname.toLowerCase() === GITHUB_HOST || url.hostname.toLowerCase() === GITHUB_GIST_HOST);
  const isRepositoryFeed =
    url.hostname.toLowerCase() === GITHUB_HOST &&
    parts.length >= 3 &&
    (parts[2] === "commits" ||
      (parts.length === 3 && (parts[2] === "releases" || parts[2] === "tags")));
  if ((!isProfile && !isRepositoryFeed) || url.pathname.endsWith(".atom")) return null;

  url.pathname = `${url.pathname.replace(/\/+$/, "")}.atom`;
  url.hash = "";
  return url.toString();
}

export function nitterFeedUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== NITTER_HOST) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const username = parts[0];
  if (!username || !NITTER_USERNAME.test(username)) return null;

  let feedParts: string[];
  if (parts.length === 1) {
    feedParts = [...parts, "rss"];
  } else if (parts.length === 2 && parts[1] === "rss") {
    feedParts = parts;
  } else if (parts.length === 2 && NITTER_TIMELINE_TABS.has(parts[1] ?? "")) {
    feedParts = [...parts, "rss"];
  } else if (parts.length === 3 && NITTER_TIMELINE_TABS.has(parts[1] ?? "") && parts[2] === "rss") {
    feedParts = parts;
  } else {
    return null;
  }

  url.protocol = "https:";
  url.pathname = `/${feedParts.join("/")}`;
  url.hash = "";
  return url.toString();
}

export function fetchFeed(value: string, options: RequestInit): Promise<Response> {
  return fetchPublic(value, options);
}
