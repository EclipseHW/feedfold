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
  const stageRef = useRef<HTMLDivElement>(null);
  const wheelDelta = useRef(0);
  const titleId = useId();
  const finishClose = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => state.returnFocus?.focus());
  }, [onClose, state.returnFocus]);
  const dialog = useAnimatedDialog(finishClose);
  const image = state.images[index] ?? state.images[0];
  const multiple = state.images.length > 1;

  const resetView = useCallback(() => {
    setZoom(null);
    setNaturalSize(null);
    wheelDelta.current = 0;
    if (typeof stageRef.current?.scrollTo === "function") {
      stageRef.current.scrollTo({ top: 0, left: 0 });
    }
  }, []);

  const showImage = useCallback(
    (nextIndex: number) => {
      const count = state.images.length;
      if (count < 1) return;
      setIndex((nextIndex + count) % count);
      resetView();
    },
    [resetView, state.images.length],
  );

  const zoomIn = useCallback(() => {
    setZoom((current) => {
      if (current === null) return 1;
      return ZOOM_STEPS.find((step) => step > current) ?? ZOOM_STEPS.at(-1) ?? 4;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((current) => {
      if (current === null) return null;
      return [...ZOOM_STEPS].reverse().find((step) => step < current) ?? null;
    });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.deltaY === 0) return;
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

  return (
    <dialog
      ref={dialog.dialogRef}
      className="image-lightbox"
      data-state={dialog.closing ? "closing" : "open"}
      aria-labelledby={titleId}
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
      <div className="image-lightbox-shell">
        <header className="image-lightbox-toolbar">
          <div className="image-lightbox-title">
            <strong id={titleId}>{image.alt || "Article image"}</strong>
            {multiple || zoom !== null ? (
              <span aria-live="polite">
                {multiple ? `${index + 1} of ${state.images.length}` : ""}
                {zoom !== null ? `${multiple ? " · " : ""}${Math.round(zoom * 100)}%` : ""}
              </span>
            ) : null}
          </div>
          <div className="image-lightbox-actions">
            <button
              type="button"
              onClick={zoomOut}
              aria-label="Zoom out"
              title="Zoom out (−)"
              disabled={zoom === null}
            >
              <Minus aria-hidden="true" size={18} />
            </button>
            <button type="button" onClick={zoomIn} aria-label="Zoom in" title="Zoom in (+)">
              <Plus aria-hidden="true" size={18} />
            </button>
            {imageUrl ? (
              <a href={imageUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" size={16} />
                <span>Open image</span>
              </a>
            ) : null}
            <button
              type="button"
              onClick={dialog.close}
              aria-label="Close image viewer"
              title="Close (Esc)"
            >
              <X aria-hidden="true" size={20} />
            </button>
          </div>
        </header>

        <div ref={stageRef} className="image-lightbox-stage">
          <img
            key={image.src}
            className={zoom === null ? "is-fit" : "is-zoomed"}
            src={image.src}
            alt={image.alt}
            style={imageStyle}
            draggable={false}
            onLoad={(event) =>
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        </div>

        {multiple ? (
          <>
            <button
              className="image-lightbox-navigation is-previous"
              type="button"
              onClick={() => showImage(index - 1)}
              aria-label="Previous image"
            >
              <ChevronLeft aria-hidden="true" size={26} />
            </button>
            <button
              className="image-lightbox-navigation is-next"
              type="button"
              onClick={() => showImage(index + 1)}
              aria-label="Next image"
            >
              <ChevronRight aria-hidden="true" size={26} />
            </button>
          </>
        ) : null}
      </div>
    </dialog>
  );
}
