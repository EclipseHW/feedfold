import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ArticleHtml } from "../../src/client/article-html.js";

describe("article HTML", () => {
  it("keeps selected text visible when an article action renders", async () => {
    const dom = new JSDOM('<div id="app"></div>');
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: dom.window.document,
    });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    const container = dom.window.document.querySelector<HTMLElement>("#app");
    if (!container) throw new Error("Article fixture is incomplete");
    const root = createRoot(container);
    const html = "<p>Readers should retain this selection.</p>";

    try {
      await act(async () => root.render(createElement(ArticleHtml, { sanitizedHtml: html })));

      const textNode = container.querySelector("p")?.firstChild;
      if (!textNode) throw new Error("Article fixture is incomplete");
      const range = dom.window.document.createRange();
      range.setStart(textNode, 8);
      range.setEnd(textNode, 21);
      const selection = dom.window.document.getSelection();
      selection?.addRange(range);
      expect(selection?.toString()).toBe("should retain");

      await act(async () => root.render(createElement(ArticleHtml, { sanitizedHtml: html })));

      expect(selection?.toString()).toBe("should retain");
      expect(selection?.isCollapsed).toBe(false);
    } finally {
      await act(async () => root.unmount());
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      dom.window.close();
    }
  });
});
