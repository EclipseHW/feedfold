import {
  createElement,
  Fragment,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ImageLightbox,
  type ImageLightboxItem,
  type ImageLightboxState,
} from "./image-lightbox.js";

function eventElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function" ? (target as Element) : null;
}

function imageLabel(image: HTMLImageElement): string {
  return (
    image.alt.trim() ||
    image.closest("figure")?.querySelector("figcaption")?.textContent?.trim() ||
    "Article image"
  );
}

function imageItem(image: HTMLImageElement): ImageLightboxItem {
  return {
    src: image.currentSrc || image.src,
    alt: imageLabel(image),
  };
}

function imageTrigger(image: HTMLImageElement, container: HTMLElement): HTMLElement {
  const link = image.closest<HTMLAnchorElement>("a[href]");
  return link && container.contains(link) ? link : image;
}

// Replacing unchanged inner HTML collapses any native text range inside it.
export const ArticleHtml = memo(function ArticleHtml({
  sanitizedHtml,
  className = "article-content",
}: {
  sanitizedHtml: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<ImageLightboxState | null>(null);

  useEffect(() => {
    if (!sanitizedHtml.includes("<img")) return;
    const container = containerRef.current;
    if (!container) return;
    for (const image of container.querySelectorAll<HTMLImageElement>("img[src]")) {
      image.dataset.imageLightboxTrigger = "";
      const trigger = imageTrigger(image, container);
      trigger.dataset.imageLightboxTrigger = "";
      const label = `Enlarge image: ${imageLabel(image)}`;
      if (trigger === image) {
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.setAttribute("aria-label", label);
      } else if (!trigger.getAttribute("aria-label") && !trigger.textContent?.trim()) {
        trigger.setAttribute("aria-label", label);
      }
    }
  }, [sanitizedHtml]);

  const openImage = useCallback((image: HTMLImageElement) => {
    const container = containerRef.current;
    if (!container) return;
    const imageElements = Array.from(container.querySelectorAll<HTMLImageElement>("img[src]"));
    const index = imageElements.indexOf(image);
    if (index < 0) return;
    setLightbox({
      images: imageElements.map(imageItem),
      index,
      returnFocus: imageTrigger(image, container),
    });
  }, []);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const image = eventElement(event.target)?.closest<HTMLImageElement>("img[src]");
      if (!image || !event.currentTarget.contains(image)) return;
      event.preventDefault();
      event.stopPropagation();
      openImage(image);
    },
    [openImage],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = eventElement(event.target);
      if (!target) return;
      const image = target.matches("img[src]")
        ? (target as HTMLImageElement)
        : target.matches("a[data-image-lightbox-trigger]")
          ? target.querySelector<HTMLImageElement>("img[src]")
          : null;
      if (!image || !event.currentTarget.contains(image)) return;
      event.preventDefault();
      event.stopPropagation();
      openImage(image);
    },
    [openImage],
  );

  const article = useMemo(
    () =>
      createElement("div", {
        ref: containerRef,
        className,
        onClick: handleClick,
        onKeyDown: handleKeyDown,
        dangerouslySetInnerHTML: { __html: sanitizedHtml },
      }),
    [className, handleClick, handleKeyDown, sanitizedHtml],
  );

  return createElement(
    Fragment,
    null,
    article,
    lightbox
      ? createElement(ImageLightbox, {
          state: lightbox,
          onClose: () => setLightbox(null),
        })
      : null,
  );
});
