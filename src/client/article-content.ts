import type { Article } from "../shared/types.js";

export type ArticleContentView = "feed" | "summary" | "empty" | "loading" | "full" | "failed";
export type FullContentToggleAction = "hide" | "show" | "load" | "wait";

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

export function fullContentToggleAction(
  article: Article,
  fullContentVisible: boolean,
): FullContentToggleAction {
  if (fullContentVisible) {
    if (article.extractionStatus === "pending" || article.extractionStatus === "processing") {
      return "wait";
    }
    if (article.extractionStatus === "complete" && article.contentHtml) return "hide";
  }
  if (article.extractionStatus === "complete" && article.contentHtml) return "show";
  return "load";
}
