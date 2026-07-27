import { describe, expect, it } from "vitest";
import {
  parseWebFeedSelectionMessage,
  WEB_FEED_HIGHLIGHT_MESSAGE,
  WEB_FEED_SELECT_MESSAGE,
  webFeedHighlightMessage,
} from "../../src/client/web-feed-selection.js";

const MESSAGE_TOKEN = "snapshot-message-token";
const CANDIDATE_IDS = new Set(["articles", "releases"]);

describe("web feed selection messages", () => {
  it("accepts a known candidate from the active snapshot", () => {
    expect(
      parseWebFeedSelectionMessage(
        {
          type: WEB_FEED_SELECT_MESSAGE,
          messageToken: MESSAGE_TOKEN,
          candidateId: "articles",
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toEqual({ kind: "select", candidateId: "articles" });
  });

  it("turns the snapshot Escape message into a cleared selection", () => {
    expect(
      parseWebFeedSelectionMessage(
        {
          type: WEB_FEED_SELECT_MESSAGE,
          messageToken: MESSAGE_TOKEN,
          candidateId: null,
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toEqual({ kind: "select", candidateId: null });
  });

  it("rejects stale, unknown, and unrelated messages", () => {
    expect(
      parseWebFeedSelectionMessage(
        {
          type: WEB_FEED_SELECT_MESSAGE,
          messageToken: "stale-token",
          candidateId: "articles",
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toBeNull();
    expect(
      parseWebFeedSelectionMessage(
        {
          type: WEB_FEED_SELECT_MESSAGE,
          messageToken: MESSAGE_TOKEN,
          candidateId: "products",
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toBeNull();
    expect(
      parseWebFeedSelectionMessage(
        {
          type: "echovale:unrelated",
          messageToken: MESSAGE_TOKEN,
          candidateId: "articles",
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toBeNull();
  });

  it("creates the exact highlight message expected by the snapshot", () => {
    expect(webFeedHighlightMessage(MESSAGE_TOKEN, "releases")).toEqual({
      type: WEB_FEED_HIGHLIGHT_MESSAGE,
      messageToken: MESSAGE_TOKEN,
      candidateId: "releases",
    });
    expect(webFeedHighlightMessage(MESSAGE_TOKEN, null)).toEqual({
      type: WEB_FEED_HIGHLIGHT_MESSAGE,
      messageToken: MESSAGE_TOKEN,
      candidateId: null,
    });
  });
});
