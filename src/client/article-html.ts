import { createElement, memo } from "react";

// Replacing unchanged inner HTML collapses any native text range inside it.
export const ArticleHtml = memo(function ArticleHtml({
  sanitizedHtml,
  className = "article-content",
}: {
  sanitizedHtml: string;
  className?: string;
}) {
  return createElement("div", {
    className,
    dangerouslySetInnerHTML: { __html: sanitizedHtml },
  });
});
