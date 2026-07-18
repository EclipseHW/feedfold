import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { cleanArticleHtml } from "../../src/server/article-html.js";

function articleBody(html: string): HTMLElement {
  return new JSDOM(`<body>${html}</body>`).window.document.body;
}

describe("article HTML rendering", () => {
  it("preserves starred code and distinguishes their data and layout tables", () => {
    const html = cleanArticleHtml(
      `<p>Views are declarative markup in <code>.native</code> files.</p>
       <pre><code>native init my_app
cd my_app
native dev
</code></pre>
       <table><tbody><tr><td><img src="/notes.png" alt="Notes"></td><td><img src="/calculator.png" alt="Calculator"></td></tr></tbody></table>
       <table><thead><tr><th>Got a tip?</th></tr></thead><tbody><tr><td>Send it to WIRED.</td></tr></tbody></table>
       <table><thead><tr><th>Example</th><th>What it shows</th></tr></thead><tbody><tr><td>calculator</td><td>A complete small app.</td></tr></tbody></table>`,
      "https://github.com/vercel-labs/native",
    );
    const body = articleBody(html);
    const tables = body.querySelectorAll("table");

    expect(body.querySelector("pre code")?.textContent).toBe(
      "native init my_app\ncd my_app\nnative dev\n",
    );
    expect(body.querySelector("p code")?.textContent).toBe(".native");
    expect(tables).toHaveLength(3);
    expect(tables[0]?.closest(".article-table-scroll")).toBeNull();
    expect(tables[1]?.closest(".article-table-scroll")).toBeNull();
    expect(tables[2]?.parentElement).toMatchObject({
      className: "article-table-scroll",
      tabIndex: 0,
    });
    expect(tables[2]?.parentElement?.getAttribute("role")).toBe("region");
    expect(tables[2]?.parentElement?.getAttribute("aria-label")).toBe("Scrollable table");

    const cleanedAgain = articleBody(cleanArticleHtml(html));
    expect(cleanedAgain.querySelectorAll(".article-table-scroll")).toHaveLength(1);
  });

  it("associates the starred Torvalds attribution without absorbing Daring Fireball commentary", () => {
    const html = cleanArticleHtml(
      `<blockquote><p>I realize that some people really dislike AI, but this is an area where I'm willing to absolutely put my foot down as the top-level maintainer.</p></blockquote>
       <p>— <a href="https://lore.kernel.org/example">Linus Torvalds</a>, Linux Media Mailing List</p>
       <blockquote><p>OpenAI says it’s folding ChatGPT, Codex, and its developer-facing API into one core product team.</p></blockquote>
       <p>I’ll give them credit for sticking with a plan for two whole months to get this out the door.</p>`,
    );
    const body = articleBody(html);
    const quotes = body.querySelectorAll("blockquote");

    expect(quotes).toHaveLength(2);
    const attributedQuote = quotes[0]?.closest("figure.article-quote");
    expect(attributedQuote?.querySelector("figcaption")?.textContent).toContain(
      "Linus Torvalds, Linux Media Mailing List",
    );
    expect(attributedQuote?.nextElementSibling?.tagName).toBe("BLOCKQUOTE");
    expect(quotes[1]?.closest("figure")).toBeNull();
    expect(quotes[1]?.nextElementSibling?.textContent).toContain(
      "I’ll give them credit for sticking with a plan",
    );

    const cleanedAgain = articleBody(cleanArticleHtml(html));
    expect(cleanedAgain.querySelectorAll("figure.article-quote")).toHaveLength(1);
  });
});
