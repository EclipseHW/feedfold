import sanitizeHtml from "sanitize-html";

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

function absoluteSrcset(value: string, baseUrl: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const [candidateUrl, ...descriptor] = candidate.trim().split(/\s+/);
      return [absoluteUrl(candidateUrl, baseUrl), ...descriptor].join(" ");
    })
    .join(", ");
}

export function cleanArticleHtml(html: string, baseUrl?: string): string {
  const transformTags: sanitizeHtml.IOptions["transformTags"] = baseUrl
    ? {
        a: (tagName, attributes) => ({
          tagName,
          attribs: {
            ...attributes,
            ...(attributes.href
              ? {
                  href: absoluteUrl(attributes.href, baseUrl),
                  target: "_blank",
                  rel: "noopener noreferrer",
                }
              : {}),
          },
        }),
        img: (tagName, attributes) => ({
          tagName,
          attribs: {
            ...attributes,
            ...(attributes.src ? { src: absoluteUrl(attributes.src, baseUrl) } : {}),
            ...(attributes.srcset ? { srcset: absoluteSrcset(attributes.srcset, baseUrl) } : {}),
          },
        }),
        source: (tagName, attributes) => ({
          tagName,
          attribs: {
            ...attributes,
            ...(attributes.src ? { src: absoluteUrl(attributes.src, baseUrl) } : {}),
            ...(attributes.srcset ? { srcset: absoluteSrcset(attributes.srcset, baseUrl) } : {}),
          },
        }),
      }
    : undefined;
  return sanitizeHtml(html, { ...sanitizeOptions, transformTags }).trim();
}
