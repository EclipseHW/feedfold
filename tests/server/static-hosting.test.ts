import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

describe("production app hosting", () => {
  it("serves navigation, assets, and APIs from the application base path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "echovale-static-hosting-test-"));
    const staticDirectory = join(directory, "client");
    await mkdir(join(staticDirectory, "assets"), { recursive: true });
    await Promise.all([
      writeFile(join(staticDirectory, "index.html"), "<main>echovale shell</main>"),
      writeFile(join(staticDirectory, "assets", "app.css"), "body { color: green; }"),
    ]);

    const database = new AppDatabase(join(directory, "echovale.db"), 20);
    const authService = new AuthService(database.auth, 20);
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000);
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
      staticDir: staticDirectory,
    });

    try {
      const navigation = await app.inject({ method: "GET", url: "/echovale/feeds/all" });
      expect(navigation.statusCode).toBe(200);
      expect(navigation.body).toBe("<main>echovale shell</main>");

      const asset = await app.inject({ method: "GET", url: "/echovale/assets/app.css" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("text/css");
      expect(asset.body).toBe("body { color: green; }");

      const api = await app.inject({ method: "GET", url: "/echovale/api/auth/session" });
      expect(api.statusCode).toBe(401);
      expect(api.json()).toEqual({ error: "Sign in to continue." });
    } finally {
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
