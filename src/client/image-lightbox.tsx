import { ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAnimatedDialog } from "./motion.js";

export interface ImageLightboxItem {
  src: string;
  alt: string;
}

export interface ImageLightboxState {
  images: ImageLightboxItem[];
  index: number;
  returnFocus: HTMLElement | null;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const WHEEL_ZOOM_THRESHOLD = 40;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

function externalHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function ImageLightbox({
  state,
  onClose,
}: {
  state: ImageLightboxState;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(state.index);
  const [zoom, setZoom] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const stageRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wheelDelta = useRef(0);
  const viewerTitleId = useId();
  const captionId = useId();
  const finishClose = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => state.returnFocus?.focus());
  }, [onClose, state.returnFocus]);
  const dialog = useAnimatedDialog(finishClose);
  const image = state.images[index] ?? state.images[0];
  const multiple = state.images.length > 1;
  const caption = image?.alt.trim() ?? "";

  const resetView = useCallback(() => {
    setZoom(null);
    wheelDelta.current = 0;
    if (typeof stageRef.current?.scrollTo === "function") {
      stageRef.current.scrollTo({ top: 0, left: 0 });
    }
  }, []);

  const showImage = useCallback(
    (nextIndex: number) => {
      const count = state.images.length;
      if (count < 1) return;
      const normalizedIndex = (nextIndex + count) % count;
      if (normalizedIndex !== index) {
        if (state.images[normalizedIndex]?.src !== state.images[index]?.src) {
          setLoadState("loading");
          setNaturalSize(null);
        }
        setIndex(normalizedIndex);
      }
      resetView();
    },
    [index, resetView, state.images],
  );

  const zoomIn = useCallback(() => {
    setZoom((current) => {
      if (current === null) return 1;
      return ZOOM_STEPS.find((step) => step > current) ?? ZOOM_STEPS.at(-1) ?? 4;
    });
  }, []);

  const zoomOut = useCallback(() => {
    const stage = stageRef.current;
    let fitZoom = 1;
    if (stage && naturalSize) {
      const styles = window.getComputedStyle(stage);
      const availableWidth =
        stage.clientWidth -
        Number.parseFloat(styles.paddingLeft) -
        Number.parseFloat(styles.paddingRight);
      const availableHeight =
        stage.clientHeight -
        Number.parseFloat(styles.paddingTop) -
        Number.parseFloat(styles.paddingBottom);
      fitZoom = Math.min(
        1,
        availableWidth / naturalSize.width,
        availableHeight / naturalSize.height,
      );
    }
    setZoom((current) => {
      if (current === null) return null;
      const next = [...ZOOM_STEPS].reverse().find((step) => step < current);
      return next !== undefined && next > fitZoom ? next : null;
    });
  }, [naturalSize]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const delta =
        event.deltaMode === WHEEL_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WHEEL_DELTA_PAGE
            ? event.deltaY * stage.clientHeight
            : event.deltaY;
      wheelDelta.current += delta;
      if (Math.abs(wheelDelta.current) < WHEEL_ZOOM_THRESHOLD) return;
      if (wheelDelta.current < 0) zoomIn();
      else zoomOut();
      wheelDelta.current = 0;
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [zoomIn, zoomOut]);

  useEffect(() => {
    thumbnailRefs.current[index]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [index]);

  useEffect(() => {
    dialog.dialogRef.current?.focus({ preventScroll: true });
  }, [dialog.dialogRef]);

  if (!image) return null;
  const imageUrl = externalHttpUrl(image.src);
  const imageStyle =
    zoom !== null && naturalSize
      ? {
          width: naturalSize.width * zoom,
          height: naturalSize.height * zoom,
          maxWidth: "none",
          maxHeight: "none",
        }
      : undefined;
  const thumbnailOccurrences = new Map<string, number>();
  const thumbnails = state.images.map((item) => {
    const occurrence = (thumbnailOccurrences.get(item.src) ?? 0) + 1;
    thumbnailOccurrences.set(item.src, occurrence);
    return { item, key: `${item.src}#${occurrence}` };
  });

  return (
    <dialog
      ref={dialog.dialogRef}
      className="image-lightbox"
      tabIndex={-1}
      data-state={dialog.closing ? "closing" : "open"}
      aria-labelledby={viewerTitleId}
      aria-describedby={caption ? captionId : undefined}
      onCancel={dialog.handleCancel}
      onClose={dialog.handleClose}
      onKeyDownCapture={(event) => {
        const key = event.key.toLowerCase();
        if (key === "escape") {
          event.preventDefault();
          event.stopPropagation();
          dialog.close();
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (key === "arrowleft" || key === "k") {
          if (multiple) showImage(index - 1);
        } else if (key === "arrowright" || key === "j") {
          if (multiple) showImage(index + 1);
        } else if (key === "+" || key === "=") {
          zoomIn();
        } else if (key === "-") {
          zoomOut();
        } else if (key === "0") {
          resetView();
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dialog.close();
      }}
    >
      <div className={`image-lightbox-shell${multiple ? "" : " is-single"}`}>
        <header className="image-lightbox-toolbar">
          <div className="image-lightbox-context">
            <strong id={viewerTitleId}>Article images</strong>
            <span>{multiple ? `${state.images.length} images` : "1 image"}</span>
          </div>
          <div className="image-lightbox-actions">
            {imageUrl ? (
              <a
                href={imageUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open original image in a new tab"
              >
                <ExternalLink aria-hidden="true" size={16} />
                <span>Open original</span>
              </a>
            ) : null}
            <button
              type="button"
              onClick={dialog.close}
              aria-label="Close image viewer"
              title="Close (Esc)"
              aria-keyshortcuts="Escape"
            >
              <X aria-hidden="true" size={20} />
            </button>
          </div>
        </header>

        {multiple ? (
          <nav className="image-lightbox-index" aria-label="Article images">
            <div className="image-lightbox-index-heading">
              <span>Images</span>
              <span>{state.images.length}</span>
            </div>
            <div className="image-lightbox-thumbnails">
              {thumbnails.map(({ item, key }, itemIndex) => (
                <button
                  key={key}
                  ref={(element) => {
                    thumbnailRefs.current[itemIndex] = element;
                  }}
                  type="button"
                  className="image-lightbox-thumbnail"
                  aria-current={itemIndex === index ? "true" : undefined}
                  aria-label={`View image ${itemIndex + 1}: ${item.alt || "Article image"}`}
                  onClick={() => showImage(itemIndex)}
                >
                  <img src={item.src} alt="" draggable={false} loading="lazy" />
                  <span>{itemIndex + 1}</span>
                </button>
              ))}
            </div>
          </nav>
        ) : null}

        <div ref={stageRef} className="image-lightbox-stage">
          {loadState === "loading" ? (
            <div className="image-lightbox-loading" role="status">
              Loading image…
            </div>
          ) : null}
          {loadState !== "error" ? (
            <img
              key={image.src}
              className={zoom === null ? "is-fit" : "is-zoomed"}
              data-loading={loadState === "loading" ? "true" : undefined}
              src={image.src}
              alt={image.alt}
              style={imageStyle}
              draggable={false}
              onLoad={(event) => {
                setLoadState("loaded");
                setNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
              onError={() => setLoadState("error")}
            />
          ) : (
            <div className="image-lightbox-error" role="alert">
              <strong>Image unavailable</strong>
              <span>The source may no longer be available.</span>
              {imageUrl ? (
                <a href={imageUrl} target="_blank" rel="noopener noreferrer">
                  Try the original image
                  <ExternalLink aria-hidden="true" size={15} />
                </a>
              ) : null}
            </div>
          )}

          {multiple ? (
            <>
              <button
                className="image-lightbox-navigation is-previous"
                type="button"
                onClick={() => showImage(index - 1)}
                aria-label="Previous image"
                title="Previous image (← or K)"
                aria-keyshortcuts="ArrowLeft K"
              >
                <ChevronLeft aria-hidden="true" size={22} />
              </button>
              <button
                className="image-lightbox-navigation is-next"
                type="button"
                onClick={() => showImage(index + 1)}
                aria-label="Next image"
                title="Next image (→ or J)"
                aria-keyshortcuts="ArrowRight J"
              >
                <ChevronRight aria-hidden="true" size={22} />
              </button>
            </>
          ) : null}
        </div>

        <footer className="image-lightbox-caption">
          <span className="image-lightbox-position" aria-live="polite">
            {multiple ? `${index + 1} of ${state.images.length}` : "Image"}
            {naturalSize ? ` · ${naturalSize.width} × ${naturalSize.height}` : ""}
          </span>
          {caption ? <p id={captionId}>{caption}</p> : null}
          <fieldset className="image-lightbox-zoom">
            <legend className="sr-only">Image zoom</legend>
            <button
              type="button"
              onClick={zoomOut}
              aria-label="Zoom out"
              title="Zoom out (−)"
              aria-keyshortcuts="-"
              disabled={zoom === null}
            >
              <Minus aria-hidden="true" size={17} />
            </button>
            <button
              type="button"
              className="image-lightbox-zoom-level"
              onClick={resetView}
              aria-label="Fit image to viewer"
              title="Fit image to viewer (0)"
              aria-keyshortcuts="0"
            >
              {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              type="button"
              onClick={zoomIn}
              aria-label="Zoom in"
              title="Zoom in (+)"
              aria-keyshortcuts="+"
              disabled={zoom === ZOOM_STEPS.at(-1)}
            >
              <Plus aria-hidden="true" size={17} />
            </button>
          </fieldset>
        </footer>
      </div>
    </dialog>
  );
}
