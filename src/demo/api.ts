import { createApiClient } from "../client/api-client.js";
import type { DesktopOperation } from "../shared/desktop.js";
import { DemoStore } from "./store.js";

export type {
  FeedInput,
  FeedUpdateInput,
  FolderInput,
  RuleInput,
} from "../client/api-contract.js";
export { ApiError, AUTH_REQUIRED_EVENT, appUrl, errorMessage } from "../client/api-contract.js";

const demoStore = new DemoStore();

export async function demoRequest<T>(operation: DesktopOperation, payload: unknown): Promise<T> {
  return demoStore.invoke(operation, payload) as T;
}

function request<T>(
  operation: DesktopOperation,
  payload: unknown,
  _path: string,
  init?: RequestInit,
): Promise<T> {
  if (init?.signal?.aborted) {
    return Promise.reject(new DOMException("The request was aborted.", "AbortError"));
  }
  const result = Promise.resolve().then(() => demoStore.invoke(operation, payload) as T);
  if (!init?.signal) return result;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The request was aborted.", "AbortError"));
    init.signal?.addEventListener("abort", abort, { once: true });
    void result
      .then(resolve, reject)
      .finally(() => init.signal?.removeEventListener("abort", abort));
  });
}

function subscribeReaderDataInvalidations(): () => void {
  return () => {};
}

async function exportOpml(): Promise<void> {
  const opml = await demoRequest<string>("exportOpml", undefined);
  const url = URL.createObjectURL(new Blob([opml], { type: "application/xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "feedfold-demo.opml";
  link.click();
  URL.revokeObjectURL(url);
}

export const api = createApiClient({
  request,
  subscribeReaderDataInvalidations,
  exportOpml,
});
