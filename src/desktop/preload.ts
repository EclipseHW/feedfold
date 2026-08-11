import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_DATA_CHANGED_CHANNEL,
  type DesktopRequest,
  type DesktopResponse,
  type FeedfoldDesktopBridge,
} from "../shared/desktop.js";

const bridge: FeedfoldDesktopBridge = Object.freeze({
  platform: "desktop" as const,
  invoke: (request: DesktopRequest) =>
    ipcRenderer.invoke("feedfold:invoke", request) as Promise<DesktopResponse>,
  exportOpml: () => ipcRenderer.invoke("feedfold:export-opml") as Promise<DesktopResponse>,
  onDataChanged: (listener: () => void) => {
    const handleDataChanged = () => listener();
    ipcRenderer.on(DESKTOP_DATA_CHANGED_CHANNEL, handleDataChanged);
    return () => ipcRenderer.removeListener(DESKTOP_DATA_CHANGED_CHANNEL, handleDataChanged);
  },
});

contextBridge.exposeInMainWorld("feedfoldDesktop", bridge);
