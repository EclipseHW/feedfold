import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_DATA_CHANGED_CHANNEL,
  type DesktopRequest,
  type DesktopResponse,
  type EchovaleDesktopBridge,
} from "../shared/desktop.js";

const bridge: EchovaleDesktopBridge = Object.freeze({
  platform: "desktop" as const,
  invoke: (request: DesktopRequest) =>
    ipcRenderer.invoke("echovale:invoke", request) as Promise<DesktopResponse>,
  exportOpml: () => ipcRenderer.invoke("echovale:export-opml") as Promise<DesktopResponse>,
  onDataChanged: (listener: () => void) => {
    const handleDataChanged = () => listener();
    ipcRenderer.on(DESKTOP_DATA_CHANGED_CHANNEL, handleDataChanged);
    return () => ipcRenderer.removeListener(DESKTOP_DATA_CHANGED_CHANNEL, handleDataChanged);
  },
});

contextBridge.exposeInMainWorld("echovaleDesktop", bridge);
