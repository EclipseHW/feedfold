import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const application = join(
  process.cwd(),
  "release",
  `mac-${process.arch}`,
  "echovale.app",
  "Contents",
  "MacOS",
  "echovale",
);
const userData = await mkdtemp(join(tmpdir(), "echovale-packaged-smoke-"));
const page = `<!doctype html>
<html>
  <head><title>Rendered reading list</title></head>
  <body>
    <main id="entries"></main>
    <script>
      setTimeout(() => {
        document.querySelector('#entries').innerHTML = [1, 2, 3]
          .map((id) => '<article><a href="/story-' + id + '"><h2>Story ' + id + '</h2><p>Summary ' + id + '</p></a></article>')
          .join('');
      }, 100);
    </script>
  </body>
</html>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(page);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("The smoke server did not start.");

try {
  await new Promise((resolve, reject) => {
    const child = spawn(application, [], {
      env: {
        ...process.env,
        ECHOVALE_DESKTOP_SMOKE: "1",
        ECHOVALE_DESKTOP_SMOKE_ALLOW_PRIVATE_NETWORKS: "1",
        ECHOVALE_DESKTOP_SMOKE_WEB_FEED_URL: `http://127.0.0.1:${address.port}/`,
        ECHOVALE_DESKTOP_USER_DATA: userData,
      },
      stdio: "inherit",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The packaged desktop smoke test timed out."));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`The packaged app stopped with ${signal}.`));
      else if (code === 0) resolve();
      else reject(new Error(`The packaged app exited with status ${code ?? "unknown"}.`));
    });
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(userData, { recursive: true, force: true });
}
