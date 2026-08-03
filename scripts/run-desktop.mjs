import { spawn } from "node:child_process";
import { join } from "node:path";
import { rebuildSqliteForElectron, rebuildSqliteForNode } from "./native-sqlite.mjs";

const projectPath = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const electronExecutable = join(
  projectPath,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectPath, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped with ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
    });
  });
}

await run(npm, ["run", "desktop:prepare-browser"]);
try {
  await rebuildSqliteForElectron(projectPath);
  await run(electronExecutable, ["."], { env: process.env });
} finally {
  await rebuildSqliteForNode(projectPath);
}
