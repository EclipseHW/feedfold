import { describe, expect, it } from "vitest";
import { parseAndNormalizeFeed } from "../../src/server/feed-parser.js";

describe("feed normalization", () => {
  it("normalizes RSS, Atom, and JSON Feed into the same article contract", () => {
    const rss = parseAndNormalizeFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel>
        <title>RSS</title><link>https://example.test/</link><description>RSS feed</description>
        <item><guid>rss-1</guid><title>RSS article</title><link>/rss-article</link>
          <author>Ada</author><pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          <description><![CDATA[<p>RSS summary</p>]]></description></item>
      </channel></rss>`,
      "https://example.test/rss.xml",
    );
    expect(rss).toMatchObject({
      title: "RSS",
      siteUrl: "https://example.test/",
      articles: [
        {
          externalId: "rss-1",
          title: "RSS article",
          url: "https://example.test/rss-article",
          author: "Ada",
          summary: "RSS summary",
          publishedAt: "2026-07-13T12:00:00.000Z",
        },
      ],
    });

    const atom = parseAndNormalizeFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom</title><id>atom-feed</id><updated>2026-07-13T12:00:00Z</updated>
        <link rel="alternate" href="https://example.test/atom-home"/>
        <entry><title>Atom article</title><id>atom-1</id><updated>2026-07-13T13:00:00Z</updated>
          <link rel="alternate" href="/atom-article"/><author><name>Grace</name></author>
          <content type="html">&lt;p&gt;Atom full content&lt;/p&gt;</content></entry>
      </feed>`,
      "https://example.test/atom.xml",
    );
    expect(atom.articles[0]).toMatchObject({
      externalId: "atom-1",
      title: "Atom article",
      url: "https://example.test/atom-article",
      author: "Grace",
      summary: "Atom full content",
      feedContentHtml: "<p>Atom full content</p>",
    });

    const json = parseAndNormalizeFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON",
        home_page_url: "https://example.test/json-home",
        items: [
          {
            id: "json-1",
            url: "/json-article",
            title: "JSON article",
            content_html: "<p>First line<br>Second &lt;unsafe&gt; line</p>",
            authors: [{ name: "Katherine" }],
            date_published: "2026-07-13T14:00:00Z",
          },
        ],
      }),
      "https://example.test/feed.json",
    );
    expect(json.articles[0]).toMatchObject({
      externalId: "json-1",
      title: "JSON article",
      url: "https://example.test/json-article",
      author: "Katherine",
      publishedAt: "2026-07-13T14:00:00.000Z",
      summary: "First line Second <unsafe> line",
    });
    expect(json.articles[0].feedContentHtml).toContain("Second &lt;unsafe&gt; line");
  });
});
