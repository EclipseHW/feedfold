import type { JSX } from "react";
import Markdown, { type Components, type ExtraProps, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const allowedElements = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "strong",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

const safeUrl: UrlTransform = (value) => {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: JSX.IntrinsicElements["a"] & ExtraProps) {
  if (!href) return children;
  if (href.startsWith("#")) {
    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  }
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

const components: Components = {
  a: MarkdownLink,
  h1: ({ node: _node, ...props }) => <h4 {...props} />,
  h2: ({ node: _node, ...props }) => <h5 {...props} />,
  h3: ({ node: _node, ...props }) => <h6 {...props} />,
  h4: ({ node: _node, ...props }) => <h6 {...props} />,
  h5: ({ node: _node, ...props }) => <h6 {...props} />,
  h6: ({ node: _node, ...props }) => <h6 {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="article-summary-table-scroll">
      <table {...props} />
    </div>
  ),
};

function normalizeAiMarkdown(text: string): string {
  return text.replace(/^([ \t]{0,3})•(?=[ \t]|$)/gmu, "$1-");
}

export function AiMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      allowedElements={allowedElements}
      components={components}
      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
      skipHtml
      urlTransform={safeUrl}
    >
      {normalizeAiMarkdown(text)}
    </Markdown>
  );
}
