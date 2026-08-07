import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource-variable/ibm-plex-sans/wght-italic.css";
import { App } from "./App";
import { isDesktopApp } from "./desktop";
import { PwaUpdate } from "./pwa-update";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The echovale root element is missing.");

const POINTER_MOVE_THRESHOLD = 4;
let lastMousePosition: { x: number; y: number } | null = null;

window.addEventListener(
  "keydown",
  () => {
    document.documentElement.dataset.inputModality = "keyboard";
  },
  { capture: true },
);
window.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.inputModality = "pointer";
  },
  { capture: true },
);
window.addEventListener(
  "pointermove",
  (event) => {
    if (event.pointerType !== "mouse") return;
    const previousPosition = lastMousePosition;
    const deltaX = previousPosition ? event.clientX - previousPosition.x : event.movementX;
    const deltaY = previousPosition ? event.clientY - previousPosition.y : event.movementY;
    lastMousePosition = { x: event.clientX, y: event.clientY };
    if (
      document.documentElement.dataset.inputModality === "keyboard" &&
      Math.hypot(deltaX, deltaY) >= POINTER_MOVE_THRESHOLD
    ) {
      document.documentElement.dataset.inputModality = "pointer";
    }
  },
  { capture: true, passive: true },
);

createRoot(root).render(
  <StrictMode>
    <App />
    {isDesktopApp() ? null : <PwaUpdate />}
  </StrictMode>,
);
