import { JSDOM, VirtualConsole } from "jsdom";
import sanitizeHtml from "sanitize-html";

const articleVirtualConsole = new VirtualConsole().forwardTo(console, {
  jsdomErrors: ["not-implemented", "resource-loading", "unhandled-exception"],
});

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
  const dom = new JSDOM(`<body>${html}</body>`, {
    url: baseUrl,
    virtualConsole: articleVirtualConsole,
  });
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
