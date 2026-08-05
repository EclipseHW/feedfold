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

createRoot(root).render(
  <StrictMode>
    <App />
    {isDesktopApp() ? null : <PwaUpdate />}
  </StrictMode>,
);
