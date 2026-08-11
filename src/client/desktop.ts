import type { DesktopOperation, FeedfoldDesktopBridge } from "../shared/desktop.js";

declare global {
  interface Window {
    feedfoldDesktop?: FeedfoldDesktopBridge;
  }
}

export function isDesktopApp(): boolean {
  return window.feedfoldDesktop?.platform === "desktop";
}

export async function invokeDesktop<T>(operation: DesktopOperation, payload?: unknown): Promise<T> {
  const bridge = window.feedfoldDesktop;
  if (!bridge) throw new Error("The desktop bridge is unavailable.");
  const response = await bridge.invoke({ operation, payload });
  if (!response.ok) {
    const error = new Error(response.error.message) as Error & {
      status: number;
      code: string | null;
    };
    error.status = response.error.status;
    error.code = response.error.code;
    throw error;
  }
  return response.value as T;
}
