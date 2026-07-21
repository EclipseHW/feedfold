const MINIMUM_SWIPE_DISTANCE = 64;
const MINIMUM_SWIPE_VELOCITY = 0.11;
const HORIZONTAL_DOMINANCE = 1.25;

export type ArticleSwipeDirection = "previous" | "next";

interface ArticleSwipeGesture {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  horizontalVelocity: number;
}

export function articleSwipeDirection({
  startX,
  startY,
  endX,
  endY,
  horizontalVelocity,
}: ArticleSwipeGesture): ArticleSwipeDirection | null {
  const horizontalDistance = endX - startX;
  const verticalDistance = endY - startY;
  const distanceCommits = Math.abs(horizontalDistance) >= MINIMUM_SWIPE_DISTANCE;
  const velocityCommits = Math.abs(horizontalVelocity) > MINIMUM_SWIPE_VELOCITY;

  if (
    (!distanceCommits && !velocityCommits) ||
    Math.abs(horizontalDistance) < Math.abs(verticalDistance) * HORIZONTAL_DOMINANCE
  ) {
    return null;
  }

  const committedDirection = distanceCommits ? horizontalDistance : horizontalVelocity;
  return committedDirection < 0 ? "next" : "previous";
}
