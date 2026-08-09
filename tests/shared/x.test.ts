import { describe, expect, it } from "vitest";
import { nitterPostId, nitterVideoPostId, withoutNitterVideoPreview } from "../../src/shared/x.js";

const VIDEO_POST_ID = "2086315104472383847";
const OUTER_POST_ID = "2086315619226681697";
const CONTENT = `<p>Thank you for understanding 🙏</p>
<a href="https://nitter.net/marclou/status/${VIDEO_POST_ID}#m"><br>Video<br>
<img src="https://nitter.net/pic/amplify_video_thumb%2F2086314948196765696%2Fimg%2Fposter.jpg"></a>
<p>— <a href="https://nitter.net/marclou/status/${OUTER_POST_ID}#m">source post</a></p>`;

describe("Nitter X video helpers", () => {
  it("extracts post IDs from Nitter status URLs", () => {
    expect(nitterPostId(`https://nitter.net/marclou/status/${VIDEO_POST_ID}#m`)).toBe(
      VIDEO_POST_ID,
    );
    expect(nitterPostId(`https://x.com/marclou/status/${VIDEO_POST_ID}`)).toBeNull();
  });

  it("uses the linked video post ID when an outer post quotes native video", () => {
    expect(nitterVideoPostId(`https://nitter.net/marclou/status/${OUTER_POST_ID}#m`, CONTENT)).toBe(
      VIDEO_POST_ID,
    );
  });

  it("removes only the stale poster link after a native player is available", () => {
    const cleaned = withoutNitterVideoPreview(CONTENT, VIDEO_POST_ID);
    expect(cleaned).not.toContain("amplify_video_thumb");
    expect(cleaned).toContain("Thank you for understanding");
    expect(cleaned).toContain(`status/${OUTER_POST_ID}#m`);
  });

  it("recognizes standard X uploads as well as amplified videos", () => {
    const html = `<a href="https://nitter.net/marclou/status/${VIDEO_POST_ID}#m">Video<img src="https://nitter.net/pic/ext_tw_video_thumb%2Ffixture.jpg"></a>`;
    expect(nitterVideoPostId(null, html)).toBe(VIDEO_POST_ID);
  });
});
