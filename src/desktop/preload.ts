import { contextBridge, ipcRenderer } from "electron";
import type { DesktopRequest, DesktopResponse, EchovaleDesktopBridge } from "../shared/desktop.js";

const bridge: EchovaleDesktopBridge = Object.freeze({
  platform: "desktop" as const,
  invoke: (request: DesktopRequest) =>
    ipcRenderer.invoke("echovale:invoke", request) as Promise<DesktopResponse>,
  exportOpml: () => ipcRenderer.invoke("echovale:export-opml") as Promise<DesktopResponse>,
});

contextBridge.exposeInMainWorld("echovaleDesktop", bridge);
