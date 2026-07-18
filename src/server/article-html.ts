import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";

const TABLE_SCROLL_CLASS = "article-table-scroll";
const QUOTE_FIGURE_CLASS = "article-quote";
const SCROLLABLE_TABLE_LABEL = "Scrollable table";

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
    "kbd",
    "samp",
    "var",
    "cite",
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
    div: ["class"],
    a: ["href", "title", "target", "rel"],
    img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
    source: ["src", "srcset", "type", "media", "sizes"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    time: ["datetime"],
  },
  allowedClasses: {
    div: [TABLE_SCROLL_CLASS],
    figure: [QUOTE_FIGURE_CLASS],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"], source: ["http", "https"] },
  allowProtocolRelative: false,
};

function enrichArticleStructure(html: string): string {
  if (!/<(?:blockquote|table)\b/i.test(html)) return html;

  const fragment = JSDOM.fragment(html);
  for (const blockquote of fragment.querySelectorAll("blockquote")) {
    const attribution = blockquote.nextElementSibling;
    if (
      attribution?.tagName !== "P" ||
      !/^[—–]\s+/.test(attribution.textContent?.trimStart() ?? "")
    ) {
      continue;
    }

    const figure = fragment.ownerDocument.createElement("figure");
    figure.className = QUOTE_FIGURE_CLASS;
    const caption = fragment.ownerDocument.createElement("figcaption");
    while (attribution.firstChild) caption.append(attribution.firstChild);
    blockquote.before(figure);
    figure.append(blockquote, caption);
    attribution.remove();
  }

  for (const table of fragment.querySelectorAll("table")) {
    const rows = [...table.querySelectorAll("tr")]
      .filter((row) => row.closest("table") === table)
      .map((row) => [...row.children].filter((cell) => /^(?:TH|TD)$/.test(cell.tagName)));
    if (!rows.some((row) => row.length > 1)) continue;

    const caption = [...table.children].find((child) => child.tagName === "CAPTION");
    const hasTableHeading =
      [...table.querySelectorAll("th")].some((heading) => heading.closest("table") === table) ||
      Boolean(caption);
    const cells = rows.flat();
    const imageCellCount = cells.filter((cell) => cell.querySelector("img, picture")).length;
    const columnCount = Math.max(...rows.map((row) => row.length));
    const hasEmptyColumn = Array.from({ length: columnCount }, (_, index) =>
      rows.every((row) => !row[index]?.textContent?.trim()),
    ).some(Boolean);
    const linkedOrMediaOnlyCellCount = cells.filter((cell) => {
      const remainingContent = cell.cloneNode(true) as Element;
      for (const element of remainingContent.querySelectorAll("a, img, picture")) element.remove();
      return !remainingContent.textContent?.trim();
    }).length;
    const isHeaderlessDataTable =
      rows.length > 1 &&
      !table.querySelector("pre, code") &&
      !hasEmptyColumn &&
      Boolean(table.textContent?.trim()) &&
      imageCellCount < cells.length / 2 &&
      linkedOrMediaOnlyCellCount <= cells.length / 2;
    if (!hasTableHeading && !isHeaderlessDataTable) continue;

    const ancestorTable = table.parentElement?.closest("table");
    if (ancestorTable?.parentElement?.classList.contains(TABLE_SCROLL_CLASS)) continue;

    let wrapper = table.parentElement;
    if (!wrapper?.classList.contains(TABLE_SCROLL_CLASS)) {
      wrapper = fragment.ownerDocument.createElement("div");
      wrapper.className = TABLE_SCROLL_CLASS;
      table.before(wrapper);
      wrapper.append(table);
    }
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", caption?.textContent?.trim() || SCROLLABLE_TABLE_LABEL);
  }

  const container = fragment.ownerDocument.createElement("div");
  container.append(fragment);
  return container.innerHTML.trim();
}

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
  const sanitized = sanitizeHtml(html, { ...sanitizeOptions, transformTags }).trim();
  return enrichArticleStructure(sanitized);
}
