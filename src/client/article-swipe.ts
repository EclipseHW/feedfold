const MINIMUM_SWIPE_DISTANCE = 64;
const MAXIMUM_SWIPE_DURATION = 700;
const HORIZONTAL_DOMINANCE = 1.25;

export type ArticleSwipeDirection = "previous" | "next";

interface ArticleSwipeGesture {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs: number;
}

export function articleSwipeDirection({
  startX,
  startY,
  endX,
  endY,
  durationMs,
}: ArticleSwipeGesture): ArticleSwipeDirection | null {
  const horizontalDistance = endX - startX;
  const verticalDistance = endY - startY;

  if (
    durationMs < 0 ||
    durationMs > MAXIMUM_SWIPE_DURATION ||
    Math.abs(horizontalDistance) < MINIMUM_SWIPE_DISTANCE ||
    Math.abs(horizontalDistance) < Math.abs(verticalDistance) * HORIZONTAL_DOMINANCE
  ) {
    return null;
  }

  return horizontalDistance < 0 ? "next" : "previous";
}
