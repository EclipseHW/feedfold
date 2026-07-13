import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { AppDatabase } from "./db.js";
import { ExtractionQueue } from "./extraction.js";
import { FeedRefreshService } from "./refresh.js";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const host = process.env.HOST ?? "127.0.0.1";
const port = positiveInteger(process.env.PORT, 3000, "PORT");
const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/echovale.db");
const pollIntervalMinutes = positiveInteger(
  process.env.POLL_INTERVAL_MINUTES,
  20,
  "POLL_INTERVAL_MINUTES",
);
const feedFetchTimeoutMs = positiveInteger(
  process.env.FEED_FETCH_TIMEOUT_MS,
  15_000,
  "FEED_FETCH_TIMEOUT_MS",
);
const articleFetchTimeoutMs = positiveInteger(
  process.env.ARTICLE_FETCH_TIMEOUT_MS,
  20_000,
  "ARTICLE_FETCH_TIMEOUT_MS",
);
const staticDir = fileURLToPath(new URL("../client", import.meta.url));

mkdirSync(dirname(databasePath), { recursive: true });
const database = new AppDatabase(databasePath, pollIntervalMinutes);
const extractionQueue = new ExtractionQueue(database, 2, articleFetchTimeoutMs);
const refreshService = new FeedRefreshService(database, extractionQueue, 3, feedFetchTimeoutMs);
const app = await createApp({
  database,
  extractionQueue,
  refreshService,
  staticDir,
  logger: process.env.NODE_ENV === "production",
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Stopping Echovale");
  try {
    await app.close();
    await Promise.all([refreshService.stop(), extractionQueue.stop()]);
    database.close();
  } catch (error) {
    app.log.error(error, "Shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  extractionQueue.start();
  refreshService.start();
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await Promise.all([refreshService.stop(), extractionQueue.stop()]);
  database.close();
  process.exitCode = 1;
}
