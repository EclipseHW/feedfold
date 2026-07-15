import { generateOpml, parseOpml } from "feedsmith";
import type { Opml } from "feedsmith/types";
import type { ImportResult } from "../shared/types.js";
import type { AppDatabase } from "./db.js";

type ParsedOutline = Opml.Outline<string>;

export interface OpmlImportOutcome extends ImportResult {
  feedIds: number[];
}

function validateFeedUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Feed URL must use HTTP or HTTPS");
  }
  return parsed.toString();
}

export function importOpml(
  database: AppDatabase,
  userId: number,
  source: string,
): OpmlImportOutcome {
  const document = parseOpml(source);
  const result: OpmlImportOutcome = { imported: 0, duplicates: 0, failed: [], feedIds: [] };
  const existingUrls = new Set(database.listOpmlFeeds(userId).map((feed) => feed.feedUrl));

  const visit = (outlines: ParsedOutline[], parentId: number | null): void => {
    for (const outline of outlines) {
      if (outline.xmlUrl) {
        const title = outline.title?.trim() || outline.text.trim() || outline.xmlUrl;
        try {
          const feedUrl = validateFeedUrl(outline.xmlUrl);
          if (existingUrls.has(feedUrl)) {
            result.duplicates += 1;
          } else {
            const feed = database.createFeed(userId, {
              title,
              feedUrl,
              siteUrl: outline.htmlUrl ?? null,
              folderId: parentId,
            });
            existingUrls.add(feedUrl);
            result.imported += 1;
            result.feedIds.push(feed.id);
          }
        } catch (error) {
          result.failed.push({
            title,
            url: outline.xmlUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (outline.outlines?.length) visit(outline.outlines, parentId);
        continue;
      }

      const name = outline.text.trim() || outline.title?.trim() || "Imported";
      let folder = database
        .listOpmlFolders(userId)
        .find((candidate) => candidate.name === name && candidate.parentId === parentId);
      if (!folder) folder = database.createFolder(userId, { name, parentId });
      if (outline.outlines?.length) visit(outline.outlines, folder.id);
    }
  };

  visit((document.body?.outlines ?? []) as ParsedOutline[], null);
  return result;
}

export function exportOpml(database: AppDatabase, userId: number): string {
  const folders = database.listOpmlFolders(userId);
  const feeds = database.listOpmlFeeds(userId);
  const outlinesByFolder = new Map<number | null, Opml.Outline<Date>[]>();
  const children = (folderId: number | null): Opml.Outline<Date>[] => {
    const existing = outlinesByFolder.get(folderId);
    if (existing) return existing;
    const created: Opml.Outline<Date>[] = [];
    outlinesByFolder.set(folderId, created);
    return created;
  };

  for (const feed of feeds) {
    children(feed.folderId).push({
      text: feed.title,
      title: feed.title,
      type: "rss",
      xmlUrl: feed.feedUrl,
      ...(feed.siteUrl ? { htmlUrl: feed.siteUrl } : {}),
    });
  }

  const buildFolder = (folder: (typeof folders)[number]): Opml.Outline<Date> => ({
    text: folder.name,
    title: folder.name,
    outlines: [
      ...folders.filter((candidate) => candidate.parentId === folder.id).map(buildFolder),
      ...children(folder.id),
    ],
  });

  const document: Opml.Document<Date> = {
    head: { title: "Echovale subscriptions", dateCreated: new Date() },
    body: {
      outlines: [
        ...folders.filter((folder) => folder.parentId === null).map(buildFolder),
        ...children(null),
      ],
    },
  };
  return generateOpml(document);
}
