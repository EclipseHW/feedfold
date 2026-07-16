export interface TextLink {
  href: string;
  label: string;
  start: number;
  end: number;
  text: string;
}

function normalizedHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function extractHttpLinks(text: string): TextLink[] {
  const links: TextLink[] = [];
  const pattern = /https?:\/\/[^\s<>"']+/giu;
  let previousMatchEnd = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const rawText = match[0];
    const linkText = rawText.replace(/[.,;!?]+$/u, "");
    const href = normalizedHttpUrl(linkText);
    const context = text.slice(previousMatchEnd, start).trim();
    const explicitLabel = /(?:^|[.!?]\s+)([\p{L}\p{N}][\p{L}\p{N} _+#&/-]{0,39}):$/u.exec(
      context,
    )?.[1];

    if (href) {
      const hostname = new URL(href).hostname.replace(/^www\./, "");
      links.push({
        href,
        label: explicitLabel ?? hostname,
        start,
        end: start + linkText.length,
        text: linkText,
      });
    }
    previousMatchEnd = start + rawText.length;
  }

  return links;
}

export function supplementalHttpLinks(summary: string, articleUrl: string | null): TextLink[] {
  const seen = new Set<string>();
  const primaryUrl = normalizedHttpUrl(articleUrl);
  if (primaryUrl) seen.add(primaryUrl);

  return extractHttpLinks(summary).filter((link) => {
    if (seen.has(link.href)) return false;
    seen.add(link.href);
    return true;
  });
}
