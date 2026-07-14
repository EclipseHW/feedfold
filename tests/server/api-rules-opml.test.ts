import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/db.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import type { Article, BootstrapData, ImportResult, Rule } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

describe("live API, OPML, and filtering rules", () => {
  it("imports nested folders, refreshes subscriptions, applies parent-folder rules, and exports OPML", async () => {
    let feedBase = "";
    const feedServer = createServer((request, response) => {
      if (request.url === "/feed") {
        response.writeHead(200, { "Content-Type": "application/rss+xml" });
        response.end(`<?xml version="1.0"?><rss version="2.0"><channel>
          <title>Remote feed title</title><link>${feedBase}</link><description>Example</description>
          <item><guid>noise</guid><title>Noisy weekly roundup</title><link>${feedBase}/missing-noise</link>
            <description><![CDATA[<p>Feed fallback for noise.</p>]]></description></item>
          <item><guid>keep</guid><title>Keep this story</title><link>${feedBase}/missing-keep</link>
            <description><![CDATA[<p>Feed fallback worth reading.</p><img src="/keep.jpg" alt="Keep">]]></description></item>
        </channel></rss>`);
        return;
      }
      response.writeHead(503).end("article unavailable");
    });
    feedBase = await listen(feedServer);

    const directory = await mkdtemp(join(tmpdir(), "echovale-api-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = new AppDatabase(join(directory, "echovale.db"));
    const extraction = new ExtractionQueue(database, 2, 2_000);
    const refresh = new FeedRefreshService(database, extraction, 2, 2_000);
    const app = await createApp({ database, extractionQueue: extraction, refreshService: refresh });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    cleanups.push(async () => {
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    expect(await json(`${apiBase}/health`)).toEqual({ status: "ok" });
    const opml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="Parent"><outline text="Child">
        <outline type="rss" text="My saved label" title="My saved label" xmlUrl="${feedBase}/feed" htmlUrl="${feedBase}"/>
      </outline></outline><outline text="Someday"/>
    </body></opml>`;
    const imported = await json<ImportResult>(`${apiBase}/api/opml/import`, {
      method: "POST",
      body: JSON.stringify({ opml }),
    });
    expect(imported).toEqual({ imported: 1, duplicates: 0, failed: [] });
    await refresh.waitForIdle();
    await extraction.waitForIdle();

    const duplicate = await json<ImportResult>(`${apiBase}/api/opml/import`, {
      method: "POST",
      body: JSON.stringify({ opml }),
    });
    expect(duplicate).toEqual({ imported: 0, duplicates: 1, failed: [] });

    const bootstrap = await json<BootstrapData>(`${apiBase}/api/bootstrap`);
    expect(bootstrap.settings.markReadOnScroll).toBe(true);
    expect(
      await json(`${apiBase}/api/settings`, {
        method: "PATCH",
        body: JSON.stringify({ markReadOnScroll: false }),
      }),
    ).toMatchObject({ markReadOnScroll: false });
    expect(await json(`${apiBase}/api/settings`)).toMatchObject({ markReadOnScroll: false });
    const parent = bootstrap.folders.find((folder) => folder.name === "Parent");
    const child = bootstrap.folders.find((folder) => folder.name === "Child");
    expect(child?.parentId).toBe(parent?.id);
    expect(bootstrap.folders.some((folder) => folder.name === "Someday")).toBe(true);
    expect(bootstrap.feeds[0]).toMatchObject({ title: "My saved label", folderId: child?.id });
    expect(bootstrap.counts).toMatchObject({ unread: 2, all: 2 });

    const rule = await json<Rule>(`${apiBase}/api/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "Remove roundups",
        feedId: null,
        folderId: parent?.id,
        field: "title",
        pattern: "weekly roundup",
        action: "hide",
        enabled: true,
      }),
    });
    expect(rule.matchedCount).toBe(1);
    database.recomputeRulesForArticle(
      database.sqlite
        .prepare("SELECT id FROM articles WHERE external_id = 'noise'")
        .pluck()
        .get() as number,
    );
    database.recomputeRulesForArticle(
      database.sqlite
        .prepare("SELECT id FROM articles WHERE external_id = 'noise'")
        .pluck()
        .get() as number,
    );
    const rules = await json<{ rules: Rule[] }>(`${apiBase}/api/rules`);
    expect(rules.rules[0].matchedCount).toBe(1);

    const disabledRule = await json<Rule>(`${apiBase}/api/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabledRule).toMatchObject({ enabled: false, matchedCount: 1 });
    const visibleWhileDisabled = await json<{ articles: Article[] }>(
      `${apiBase}/api/articles?state=all`,
    );
    expect(new Set(visibleWhileDisabled.articles.map((article) => article.title))).toEqual(
      new Set(["Noisy weekly roundup", "Keep this story"]),
    );

    const enabledRule = await json<Rule>(`${apiBase}/api/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabledRule).toMatchObject({ enabled: true, matchedCount: 1 });
    expect(
      (await json<{ articles: Article[] }>(`${apiBase}/api/articles?state=all`)).articles.map(
        (article) => article.title,
      ),
    ).toEqual(["Keep this story"]);

    await json(`${apiBase}/api/folders/${child?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: null }),
    });
    const movedOut = await json<{ articles: Article[] }>(`${apiBase}/api/articles?state=all`);
    expect(new Set(movedOut.articles.map((article) => article.title))).toEqual(
      new Set(["Noisy weekly roundup", "Keep this story"]),
    );
    expect((await json<{ rules: Rule[] }>(`${apiBase}/api/rules`)).rules[0].matchedCount).toBe(0);
    await json(`${apiBase}/api/folders/${child?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: parent?.id }),
    });

    const listed = await json<{ articles: Article[] }>(`${apiBase}/api/articles?state=all`);
    expect(listed.articles.map((article) => article.title)).toEqual(["Keep this story"]);
    const keep = listed.articles[0];
    expect(keep).toMatchObject({ contentHtml: null, imageUrl: `${feedBase}/keep.jpg` });
    const expanded = await json<{ articles: Article[] }>(
      `${apiBase}/api/articles?state=all&includeContent=true`,
    );
    expect(expanded.articles[0].contentHtml).toContain("Feed fallback worth reading");
    const updated = await json<Article>(`${apiBase}/api/articles/${keep.id}/state`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true, isStarred: true }),
    });
    expect(updated).toMatchObject({ isRead: true, isStarred: true });
    expect(await json<Article>(`${apiBase}/api/articles/${keep.id}`)).toMatchObject({
      id: keep.id,
      isRead: true,
      isStarred: true,
      imageUrl: `${feedBase}/keep.jpg`,
    });
    expect((await json<Article>(`${apiBase}/api/articles/${keep.id}`)).contentHtml).toContain(
      "Feed fallback worth reading",
    );

    const retry = await json<Article>(`${apiBase}/api/articles/${keep.id}/extract`, {
      method: "POST",
    });
    expect(["pending", "processing"]).toContain(retry.extractionStatus);
    await extraction.waitForIdle();
    expect((await json<Article>(`${apiBase}/api/articles/${keep.id}`)).extractionStatus).toBe(
      "feed",
    );

    const exported = await fetch(`${apiBase}/api/opml/export`);
    expect(exported.headers.get("content-disposition")).toContain("echovale-subscriptions.opml");
    const exportedText = await exported.text();
    expect(exportedText).toContain('text="Parent"');
    expect(exportedText).toContain('text="Child"');
    expect(exportedText).toContain('text="Someday"');
    expect(exportedText).toContain(`xmlUrl="${feedBase}/feed"`);
    expect(exportedText).not.toContain("Keep this story");
  });
});
