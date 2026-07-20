import type { IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";

const NITTER_HOST = "nitter.net";
const NITTER_USERNAME = /^[a-zA-Z0-9_]{1,15}$/;
const NITTER_TIMELINE_TABS = new Set(["media", "search", "with_replies"]);

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

function isNitterUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === NITTER_HOST;
  } catch {
    return false;
  }
}

function outgoingHeaders(value: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(value).entries());
}

function incomingHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name && value) headers.append(name, value);
  }
  return headers;
}

function fetchNitter(value: string, options: RequestInit): Promise<Response> {
  const url = new URL(value);
  url.protocol = "https:";

  return new Promise((resolve, reject) => {
    const handleResponse = (response: IncomingMessage): void => {
      const status = response.statusCode;
      if (!status) {
        reject(new Error("Nitter response did not include an HTTP status"));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once("aborted", () => reject(new Error("Feed response was aborted")));
      response.once("error", reject);
      response.once("end", () => {
        const body =
          status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
        resolve(
          new Response(body, {
            headers: incomingHeaders(response),
            status,
            statusText: response.statusMessage,
          }),
        );
      });
    };
    const requestOptions = {
      headers: outgoingHeaders(options.headers),
      method: options.method ?? "GET",
      signal: options.signal ?? undefined,
    };
    const request = requestHttps(url, requestOptions, handleResponse);
    request.once("error", reject);
    request.end();
  });
}

export function fetchFeed(value: string, options: RequestInit): Promise<Response> {
  return isNitterUrl(value) ? fetchNitter(value, options) : fetch(value, options);
}
