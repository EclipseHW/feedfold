import { Buffer } from "node:buffer";
import sanitizeHtml from "sanitize-html";

const blockedBadgeHosts = new Set(["img.shields.io", "api.star-history.com"]);

function hasBadgePathToken(pathname: string): boolean {
  return pathname.split("/").some((segment) => /(?:^|[-_.])badge(?:$|[-_.])/i.test(segment));
}

function isDirectBadgeUrl(url: URL): boolean {
  if (blockedBadgeHosts.has(url.hostname)) return true;
  return hasBadgePathToken(url.pathname);
}

function isBlockedBadgeUrl(url: URL): boolean {
  if (isDirectBadgeUrl(url)) return true;
  if (url.hostname !== "camo.githubusercontent.com") return false;

  const encodedTarget = url.pathname.split("/").at(-1);
  if (!encodedTarget || encodedTarget.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encodedTarget)) {
    return false;
  }
  try {
    return isDirectBadgeUrl(new URL(Buffer.from(encodedTarget, "hex").toString("utf8")));
  } catch {
    return false;
  }
}

function safeHttpUrl(value: string, baseUrl?: string): string | null {
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (isBlockedBadgeUrl(parsed)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function firstSafeImageUrl(html: string | null, baseUrl?: string): string | null {
  if (!html) return null;
  let imageUrl: string | null = null;
  sanitizeHtml(html, {
    allowedTags: ["img"],
    allowedAttributes: { img: ["src"] },
    transformTags: {
      img: (_tagName, attributes) => {
        if (!imageUrl && attributes.src) imageUrl = safeHttpUrl(attributes.src, baseUrl);
        return { tagName: "img", attribs: {} };
      },
    },
  });
  return imageUrl;
}
