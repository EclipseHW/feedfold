import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isDesktopApp } from "./desktop";
import { PwaUpdate } from "./pwa-update";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The echovale root element is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
    {isDesktopApp() ? null : <PwaUpdate />}
  </StrictMode>,
);
