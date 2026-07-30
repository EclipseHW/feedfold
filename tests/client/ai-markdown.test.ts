import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiMarkdown } from "../../src/client/ai-markdown.js";

function renderMarkdown(text: string): DocumentFragment {
  return JSDOM.fragment(renderToStaticMarkup(createElement(AiMarkdown, { text })));
}

describe("AI Markdown", () => {
  it("renders formatted LLM output without changing its block order", () => {
    const fragment = renderMarkdown(`Here is the result:

• **Core technology:** Uses \`pread\`.
• **Value:** Runs locally.

Closing note.`);

    expect([...fragment.children].map((element) => element.tagName)).toEqual(["P", "UL", "P"]);
    expect(fragment.querySelectorAll("li")).toHaveLength(2);
    expect(fragment.querySelector("li strong")?.textContent).toBe("Core technology:");
    expect(fragment.querySelector("li code")?.textContent).toBe("pread");
    expect(fragment.textContent).not.toContain("**");
  });

  it("supports headings and GitHub-flavored result structures", () => {
    const fragment = renderMarkdown(`# Recommendation

~~Discarded~~ Current

| Model | Status |
| --- | --- |
| Local | Ready |

- [x] Verified`);

    expect(fragment.querySelector("h4")?.textContent).toBe("Recommendation");
    expect(fragment.querySelector("del")?.textContent).toBe("Discarded");
    expect(fragment.querySelector("table")?.textContent).toContain("LocalReady");
    expect(fragment.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  });

  it("keeps generated HTML, unsafe links, and remote images inert", () => {
    const fragment = renderMarkdown(`
[Safe](https://example.test/path)
[Unsafe](javascript:alert(1))
![Tracking pixel](https://tracker.example.test/pixel.png)
<strong>Raw HTML</strong>
`);
    const links = [...fragment.querySelectorAll("a")];

    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.test/path");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(fragment.querySelector("img")).toBeNull();
    expect(fragment.querySelector("strong")).toBeNull();
  });
});
