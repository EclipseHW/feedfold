import { JSDOM } from "jsdom";
import { firstSafeImageUrl } from "./article-image.js";
import type { ParsedArticle, ParsedFeed } from "./db.js";
import { plainText } from "./feed-parser.js";

const TELEGRAM_HOST = "t.me";
const CHANNEL_NAME = /^[a-zA-Z0-9_]{5,32}$/;
const POST_ID = /^\d+$/;

export interface TelegramChannelUrls {
  channelUrl: string;
  previewUrl: string;
}

function telegramPath(value: string): string[] | null {
  try {
    const url = new URL(value);
    if (url.hostname !== TELEGRAM_HOST) return null;
    return url.pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
}

export function telegramChannelUrls(value: string): TelegramChannelUrls | null {
  const path = telegramPath(value);
  if (!path) return null;
  const channel =
    path.length === 1 ? path[0] : path.length === 2 && path[0] === "s" ? path[1] : null;
  if (!channel || !CHANNEL_NAME.test(channel)) return null;
  return {
    channelUrl: `https://${TELEGRAM_HOST}/${channel}`,
    previewUrl: `https://${TELEGRAM_HOST}/s/${channel}`,
  };
}

export function isTelegramPostUrl(value: string): boolean {
  const path = telegramPath(value);
  return Boolean(
    path && path.length === 2 && CHANNEL_NAME.test(path[0] ?? "") && POST_ID.test(path[1] ?? ""),
  );
}

function text(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function date(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function messageImageUrl(message: Element, baseUrl: string): string | null {
  for (const photo of message.querySelectorAll<HTMLElement>(
    ".tgme_widget_message_photo_wrap[style]",
  )) {
    const style = photo.getAttribute("style") ?? "";
    const match = /background-image\s*:\s*url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/i.exec(style);
    const candidate = match?.[1] ?? match?.[2] ?? match?.[3]?.trim();
    if (!candidate) continue;
    const image = message.ownerDocument.createElement("img");
    image.setAttribute("src", candidate);
    const result = firstSafeImageUrl(image.outerHTML, baseUrl);
    if (result) return result;
  }
  return null;
}

function article(
  message: Element,
  channel: string,
  channelTitle: string,
  channelUrl: string,
): ParsedArticle | null {
  const externalId = message.getAttribute("data-post");
  if (!externalId) return null;
  const [postChannel, postId, ...rest] = externalId.split("/");
  if (
    rest.length > 0 ||
    postChannel?.toLowerCase() !== channel.toLowerCase() ||
    !postId ||
    !POST_ID.test(postId)
  ) {
    return null;
  }

  const postUrl = `${channelUrl}/${postId}`;
  const messageText = message.querySelector<HTMLElement>(".js-message_text");
  const summary = plainText(messageText?.innerHTML ?? null);
  const imageUrl = messageImageUrl(message, channelUrl);
  const content = message.ownerDocument.createElement("div");
  if (messageText) content.innerHTML = messageText.innerHTML.trim();
  if (imageUrl) {
    const image = message.ownerDocument.createElement("img");
    image.src = imageUrl;
    image.alt = `${channelTitle} post image`;
    content.append(image);
  }
  if (!content.innerHTML.trim()) {
    const link = message.ownerDocument.createElement("a");
    link.href = postUrl;
    link.textContent = "View this post on Telegram";
    content.append(link);
  }

  return {
    externalId,
    title: summary.slice(0, 160) || `${channelTitle} post ${postId}`,
    url: postUrl,
    author: channelTitle,
    publishedAt: date(message.querySelector("time[datetime]")?.getAttribute("datetime") ?? null),
    summary,
    imageUrl,
    feedContentHtml: content.innerHTML,
  };
}

export function parseAndNormalizeTelegramFeed(source: string, channelUrl: string): ParsedFeed {
  const urls = telegramChannelUrls(channelUrl);
  if (!urls) throw new Error("Invalid Telegram channel URL");
  const channel = new URL(urls.channelUrl).pathname.slice(1);
  const dom = new JSDOM(source, { url: urls.previewUrl });
  try {
    const title = text(
      dom.window.document.querySelector(".tgme_channel_info_header_title")?.textContent,
    );
    if (!title) throw new Error("Telegram channel preview was not found");
    const articles = Array.from(
      dom.window.document.querySelectorAll(".js-widget_message[data-post]"),
    )
      .map((message) => article(message, channel, title, urls.channelUrl))
      .filter((item): item is ParsedArticle => item !== null)
      .reverse();
    return { title, siteUrl: urls.channelUrl, articles };
  } finally {
    dom.window.close();
  }
}
