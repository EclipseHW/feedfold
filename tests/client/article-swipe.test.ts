import { describe, expect, it } from "vitest";
import { articleSwipeDirection } from "../../src/client/article-swipe.js";

describe("article swipe navigation", () => {
  it("moves forward after a left swipe and backward after a right swipe", () => {
    expect(
      articleSwipeDirection({
        startX: 280,
        startY: 360,
        endX: 180,
        endY: 370,
        durationMs: 240,
      }),
    ).toBe("next");
    expect(
      articleSwipeDirection({
        startX: 110,
        startY: 360,
        endX: 210,
        endY: 350,
        durationMs: 240,
      }),
    ).toBe("previous");
  });

  it("leaves vertical reading and ambiguous horizontal movement alone", () => {
    expect(
      articleSwipeDirection({
        startX: 200,
        startY: 500,
        endX: 180,
        endY: 350,
        durationMs: 240,
      }),
    ).toBeNull();
    expect(
      articleSwipeDirection({
        startX: 230,
        startY: 360,
        endX: 180,
        endY: 365,
        durationMs: 240,
      }),
    ).toBeNull();
    expect(
      articleSwipeDirection({
        startX: 280,
        startY: 360,
        endX: 180,
        endY: 370,
        durationMs: 900,
      }),
    ).toBeNull();
  });
});
