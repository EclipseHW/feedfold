import { describe, expect, it } from "vitest";
import { articleSwipeDirection } from "../../src/client/article-swipe.js";

describe("article swipe navigation", () => {
  it("commits a normal 100px swipe in either direction", () => {
    expect(
      articleSwipeDirection({
        startX: 280,
        startY: 360,
        endX: 180,
        endY: 370,
        horizontalVelocity: -0.08,
      }),
    ).toBe("next");
    expect(
      articleSwipeDirection({
        startX: 110,
        startY: 360,
        endX: 210,
        endY: 350,
        horizontalVelocity: 0.08,
      }),
    ).toBe("previous");
  });

  it("commits a 52px flick from its recent release velocity", () => {
    expect(
      articleSwipeDirection({
        startX: 280,
        startY: 360,
        endX: 228,
        endY: 364,
        horizontalVelocity: -52 / 110,
      }),
    ).toBe("next");
  });

  it("uses recent velocity when a short flick reverses near its release point", () => {
    expect(
      articleSwipeDirection({
        startX: 200,
        startY: 360,
        endX: 204,
        endY: 362,
        horizontalVelocity: -0.4,
      }),
    ).toBe("next");
  });

  it("commits a deliberate 100px drag even after 850ms", () => {
    expect(
      articleSwipeDirection({
        startX: 280,
        startY: 360,
        endX: 180,
        endY: 370,
        horizontalVelocity: -100 / 850,
      }),
    ).toBe("next");
  });

  it("leaves short slow and vertically dominant movement alone", () => {
    expect(
      articleSwipeDirection({
        startX: 230,
        startY: 360,
        endX: 180,
        endY: 365,
        horizontalVelocity: -0.08,
      }),
    ).toBeNull();
    expect(
      articleSwipeDirection({
        startX: 200,
        startY: 500,
        endX: 135,
        endY: 420,
        horizontalVelocity: -0.8,
      }),
    ).toBeNull();
  });
});
