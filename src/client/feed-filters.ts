import type { Feed, FeedSourceKind } from "../shared/types.js";

export type FeedTypeFilter = "all" | FeedSourceKind;
export type FeedStatusFilter = "all" | "healthy" | "needs_attention" | "paused" | "refreshing";

export type VisibleFeedStatus = Exclude<FeedStatusFilter, "all">;

export function visibleFeedStatus(
  feed: Pick<Feed, "healthStatus" | "paused" | "refreshing">,
): VisibleFeedStatus {
  if (feed.healthStatus !== "healthy") return "needs_attention";
  if (feed.paused) return "paused";
  if (feed.refreshing) return "refreshing";
  return "healthy";
}

export function filterFeeds(feeds: Feed[], type: FeedTypeFilter, status: FeedStatusFilter): Feed[] {
  return feeds.filter(
    (feed) =>
      (type === "all" || feed.sourceKind === type) &&
      (status === "all" || visibleFeedStatus(feed) === status),
  );
}
