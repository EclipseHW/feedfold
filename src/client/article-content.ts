import type { Article } from "../shared/types.js";

export type ArticleContentView = "feed" | "summary" | "empty" | "loading" | "full" | "failed";

function feedContentView(article: Article): ArticleContentView {
  if (article.feedContentHtml) return "feed";
  if (article.summary) return "summary";
  return "empty";
}

export function articleContentView(
  article: Article,
  fullContentVisible: boolean,
): ArticleContentView {
  if (!fullContentVisible) return feedContentView(article);
  if (article.extractionStatus === "pending" || article.extractionStatus === "processing") {
    return "loading";
  }
  if (article.extractionStatus === "complete" && article.contentHtml) return "full";
  if (article.extractionStatus === "failed") return "failed";
  return feedContentView(article);
}
