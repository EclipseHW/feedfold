import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { type WebFeedError, WebFeedService } from "../../src/server/web-feed.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fixturePage(broken: boolean): string {
  const renderedContent = broken
    ? `<ul id="new-layout">
        <li><a href="/elsewhere/one">Unrelated one</a></li>
        <li><a href="/elsewhere/two">Unrelated two</a></li>
      </ul>`
    : `<section id="openings" aria-label="Latest openings">
        <article class="job-card">
          <h2><a href="/jobs/alpha#overview">Alpha engineer</a></h2>
          <time datetime="2026-07-20T10:00:00Z">20 July</time>
          <span class="byline">Ada</span>
          <p class="summary">Build careful tools.</p>
          <img src="/images/alpha.jpg" alt="">
        </article>
        <article class="job-card">
          <h2><a href="/jobs/beta">Beta designer</a></h2>
          <time datetime="2026-07-21T11:30:00Z">21 July</time>
          <span class="byline">Grace</span>
          <p class="summary">Shape a calmer reader.</p>
          <img src="/images/beta.jpg" alt="">
        </article>
        <article class="job-card">
          <h2><a href="/jobs/gamma">Gamma researcher</a></h2>
          <span class="byline">Lin</span>
          <p class="summary">Explore useful signals.</p>
          <img src="/images/gamma.jpg" alt="">
        </article>
        <article class="job-card duplicate">
          <h2><a href="/jobs/alpha#apply">Alpha engineer application</a></h2>
          <p class="summary">The same role linked twice.</p>
        </article>
      </section>`;
  return `<!doctype html>
    <html>
      <head>
        <title>Echovale fixture</title>
        <link rel="stylesheet" href="/fixture.css">
      </head>
      <body>
        <nav><a href="/account">Account</a><a href="/settings">Settings</a></nav>
        <main>
          <h1>Careers</h1>
          <p>Our security team researches CAPTCHA accessibility and bot verification UX.</p>
          <div id="app"></div>
        </main>
        <form action="/subscribe"><input name="email"><button>Subscribe</button></form>
        <script>
          window.__fixtureScriptRan = true;
          setTimeout(() => {
            document.querySelector("#app").innerHTML = ${JSON.stringify(renderedContent)};
          }, 80);
        </script>
      </body>
    </html>`;
}

describe("browser-backed web feeds", () => {
  it("discovers and extracts JavaScript-rendered repeated items without duplicate links", async () => {
    let broken = false;
    const server = createServer((request, response) => {
      if (request.url === "/fixture.css") {
        response.writeHead(200, { "Content-Type": "text/css" });
        response.end(`
          #openings { display: grid; grid-template-columns: 240px 240px; color: rgb(17, 34, 51); }
          .job-card { padding: 13px; background-color: rgb(231, 239, 247); border-radius: 7px; }
        `);
        return;
      }
      if (request.url?.startsWith("/images/")) {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fixturePage(broken));
    });
    const baseUrl = await listen(server);
    let now = Date.parse("2026-07-27T12:00:00Z");
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: process.platform === "linux",
    });
    const service = new WebFeedService({
      allowPrivateNetworks: true,
      browserFactory: async () => browser,
      now: () => now,
      settleQuietMs: 150,
      settleTimeoutMs: 3_000,
      snapshotTtlMs: 1_000,
    });
    cleanups.push(() => service.close());

    const analysis = await service.analyze("owner", baseUrl);
    expect(analysis).toMatchObject({
      pageUrl: `${baseUrl}/`,
      title: "Echovale fixture",
      savedSelectionMatched: false,
      selectedCandidateId: null,
    });
    expect(analysis.candidates.length).toBeGreaterThan(0);
    const candidate = analysis.candidates.find(
      (suggestion) => suggestion.label === "Latest openings",
    );
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      itemCount: 3,
      availableFields: ["title", "link", "date", "author", "summary", "image"],
    });
    expect(candidate?.articles.map((article) => article.title)).toEqual([
      "Alpha engineer",
      "Beta designer",
      "Gamma researcher",
    ]);

    const snapshot = service.snapshot("owner", analysis.snapshotId);
    expect(snapshot).toContain("data-echovale-candidates");
    expect(snapshot).toContain("echovale:web-feed-select");
    expect(snapshot).toContain("echovale:web-feed-highlight");
    expect(snapshot).toContain(analysis.messageToken);
    expect(snapshot).not.toContain("window.__fixtureScriptRan");
    expect(snapshot).not.toContain("/images/alpha.jpg");
    expect(snapshot).not.toMatch(/<link\b/i);
    expect(snapshot).not.toMatch(/<form[^>]+action=/i);
    expect(snapshot).not.toMatch(/<a[^>]+href=/i);
    expect(snapshot).toContain("style-src 'unsafe-inline'; img-src data: blob:; font-src data:");
    expect(() => service.snapshot("someone-else", analysis.snapshotId)).toThrowError(
      expect.objectContaining({ kind: "inaccessible" }),
    );

    const previewPage = await browser.newPage();
    const remoteRequests: string[] = [];
    previewPage.on("request", (request) => {
      if (/^https?:/.test(request.url())) remoteRequests.push(request.url());
    });
    await previewPage.setContent(snapshot, { waitUntil: "load" });
    await previewPage.evaluate(() => {
      Object.assign(window, { __pickerMessages: [] });
      window.addEventListener("message", (event) => {
        (window as unknown as Window & { __pickerMessages: unknown[] }).__pickerMessages.push(
          event.data,
        );
      });
    });
    const locationBeforeClick = previewPage.url();
    await previewPage.getByText("Account", { exact: true }).click();
    expect(previewPage.url()).toBe(locationBeforeClick);
    expect(remoteRequests).toEqual([]);
    expect(
      await previewPage
        .locator("#openings")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("grid");
    const firstSelectable = previewPage.locator("[data-echovale-candidates]").first();
    expect(
      await firstSelectable.evaluate((element) => ({
        backgroundColor: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        paddingLeft: getComputedStyle(element).paddingLeft,
      })),
    ).toEqual({
      backgroundColor: "rgb(231, 239, 247)",
      color: "rgb(17, 34, 51)",
      paddingLeft: "13px",
    });
    await expect(firstSelectable.getAttribute("aria-label")).resolves.toContain("Alpha engineer");
    await firstSelectable.click();
    await previewPage.waitForFunction(
      () =>
        (window as unknown as Window & { __pickerMessages: unknown[] }).__pickerMessages.length > 0,
    );
    await expect(
      previewPage.evaluate(() =>
        (window as unknown as Window & { __pickerMessages: unknown[] }).__pickerMessages.at(-1),
      ),
    ).resolves.toMatchObject({
      type: "echovale:web-feed-select",
      messageToken: analysis.messageToken,
      candidateId: candidate?.id,
    });

    if (!candidate) throw new Error("Expected the job-card suggestion");
    const extracted = await service.extract(candidate.config);
    expect(extracted.matchCount).toBe(3);
    expect(extracted.httpStatus).toBe(200);
    expect(extracted.parsed.articles.map((article) => article.externalId)).toEqual([
      `${baseUrl}/jobs/alpha`,
      `${baseUrl}/jobs/beta`,
      `${baseUrl}/jobs/gamma`,
    ]);
    expect(extracted.parsed.articles[0]).toMatchObject({
      title: "Alpha engineer",
      author: "Ada",
      publishedAt: "2026-07-20T10:00:00.000Z",
      summary: "Build careful tools.",
      imageUrl: `${baseUrl}/images/alpha.jpg`,
    });
    expect(extracted.parsed.articles[2]?.publishedAt).toBeNull();

    const repaired = await service.analyze("owner", baseUrl, candidate.config);
    expect(repaired.savedSelectionMatched).toBe(true);
    expect(repaired.selectedCandidateId).toBe(repaired.candidates[0]?.id);

    broken = true;
    await expect(service.extract(candidate.config)).rejects.toMatchObject({
      kind: "selection_broken",
      httpStatus: 200,
    });

    now += 1_001;
    expect(() => service.snapshot("owner", analysis.snapshotId)).toThrowError(
      expect.objectContaining({ kind: "inaccessible" }),
    );
  }, 30_000);

  it("rejects private-network pages before launching a browser", async () => {
    let launched = false;
    const service = new WebFeedService({
      browserFactory: async () => {
        launched = true;
        throw new Error("The browser should not launch");
      },
    });
    cleanups.push(() => service.close());

    await expect(service.analyze("owner", "http://127.0.0.1/private")).rejects.toMatchObject({
      kind: "inaccessible",
    } satisfies Partial<WebFeedError>);
    expect(launched).toBe(false);
  });

  it("distinguishes a specific bot-protection page from legitimate CAPTCHA content", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>Security check</title><main><h1>Verify you are human</h1></main>",
      );
    });
    const baseUrl = await listen(server);
    const service = new WebFeedService({
      allowPrivateNetworks: true,
      settleQuietMs: 100,
      settleTimeoutMs: 1_000,
    });
    cleanups.push(() => service.close());

    await expect(service.analyze("owner", baseUrl)).rejects.toMatchObject({
      kind: "access_blocked",
      httpStatus: 200,
    });
  });
});
