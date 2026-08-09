import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ArticleHtml } from "../../src/client/article-html.js";

describe("article HTML", () => {
  it("opens article images in a keyboard-accessible lightbox", async () => {
    const dom = new JSDOM('<div id="app"></div>', { url: "https://echovale.test/" });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    let articleEscapeCount = 0;
    let articleNavigationCount = 0;
    const handleArticleShortcuts = (event: KeyboardEvent) => {
      if (event.key === "Escape") articleEscapeCount += 1;
      if (["arrowleft", "arrowright", "j", "k"].includes(event.key.toLowerCase())) {
        articleNavigationCount += 1;
      }
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: dom.window.document,
    });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    dom.window.addEventListener("keydown", handleArticleShortcuts);
    Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
        this.dispatchEvent(new dom.window.Event("close"));
      },
    });
    Object.defineProperty(dom.window, "requestAnimationFrame", {
      configurable: true,
      value(callback: FrameRequestCallback) {
        callback(0);
        return 1;
      },
    });

    const container = dom.window.document.querySelector<HTMLElement>("#app");
    if (!container) throw new Error("Article fixture is incomplete");
    const root = createRoot(container);
    const html = `
      <figure>
        <img src="https://images.test/diagram.png" alt="Detailed diagram">
        <figcaption>Small labels</figcaption>
      </figure>
      <a href="https://example.test/source"><img src="https://images.test/chart.png" alt="Chart"></a>
    `;

    try {
      await act(async () => root.render(createElement(ArticleHtml, { sanitizedHtml: html })));

      const images = container.querySelectorAll<HTMLImageElement>(".article-content img");
      expect(images).toHaveLength(2);
      expect(images[0]?.tabIndex).toBe(0);
      expect(images[0]?.getAttribute("role")).toBe("button");
      expect(images[0]?.getAttribute("aria-label")).toContain("Detailed diagram");

      await act(async () => {
        images[0]?.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      const dialog = container.querySelector<HTMLDialogElement>("dialog.image-lightbox");
      const pressViewerKey = (key: string) =>
        act(async () => {
          dialog?.dispatchEvent(
            new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          );
        });
      expect(dialog?.hasAttribute("open")).toBe(true);
      expect(dialog?.textContent).toContain("Detailed diagram");
      expect(dialog?.textContent).toContain("1 of 2");
      expect(dialog?.querySelector<HTMLImageElement>(".image-lightbox-stage img")?.src).toBe(
        "https://images.test/diagram.png",
      );
      expect(container.querySelectorAll<HTMLImageElement>(".article-content img")[0]).toBe(
        images[0],
      );
      expect(images[0]?.getAttribute("role")).toBe("button");
      expect(dialog?.querySelector('[aria-label="View actual size"]')).toBeNull();
      expect(dialog?.querySelector('[aria-label="Fit image to window"]')).toBeNull();

      const zoomOut = dialog?.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]');
      const zoomIn = dialog?.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
      const stage = dialog?.querySelector<HTMLDivElement>(".image-lightbox-stage");
      const scrollViewer = (deltaY: number) =>
        act(async () => {
          const wheel = new dom.window.WheelEvent("wheel", {
            deltaY,
            bubbles: true,
            cancelable: true,
          });
          expect(stage?.dispatchEvent(wheel)).toBe(false);
        });
      expect(zoomOut?.disabled).toBe(true);
      await scrollViewer(-100);
      expect(dialog?.textContent).toContain("100%");
      expect(zoomOut?.disabled).toBe(false);
      await scrollViewer(100);
      expect(dialog?.textContent).not.toContain("%");
      expect(zoomOut?.disabled).toBe(true);
      await act(async () => zoomIn?.click());
      expect(dialog?.textContent).toContain("100%");
      await act(async () => zoomOut?.click());
      expect(dialog?.textContent).not.toContain("%");
      expect(zoomOut?.disabled).toBe(true);

      await pressViewerKey("ArrowRight");
      expect(dialog?.textContent).toContain("Chart");
      expect(dialog?.textContent).toContain("2 of 2");
      expect(articleNavigationCount).toBe(0);
      expect(dialog?.querySelector<HTMLAnchorElement>("a")?.href).toBe(
        "https://images.test/chart.png",
      );
      await pressViewerKey("k");
      expect(dialog?.textContent).toContain("Detailed diagram");
      expect(dialog?.textContent).toContain("1 of 2");
      await pressViewerKey("j");
      expect(dialog?.textContent).toContain("Chart");
      expect(dialog?.textContent).toContain("2 of 2");
      expect(articleNavigationCount).toBe(0);
      expect(dialog?.querySelectorAll("a")).toHaveLength(1);
      expect(dialog?.textContent).toContain("Open image");
      expect(dialog?.textContent).not.toContain("Open link");

      dom.window.document.documentElement.dataset.inputModality = "keyboard";
      await pressViewerKey("Escape");
      expect(container.querySelector("dialog.image-lightbox")).toBeNull();
      expect(articleEscapeCount).toBe(0);
      expect(dom.window.document.activeElement).toBe(images[0]);
    } finally {
      dom.window.removeEventListener("keydown", handleArticleShortcuts);
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
