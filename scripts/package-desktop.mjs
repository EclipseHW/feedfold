import { spawn } from "node:child_process";
import { join } from "node:path";
import { rebuildSqliteForElectron, rebuildSqliteForNode } from "./native-sqlite.mjs";

const projectPath = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const electronBuilderCli = join(
  projectPath,
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
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
await run(npm, ["run", "build:desktop"]);
try {
  await rebuildSqliteForElectron(projectPath);
  const builderArguments = [electronBuilderCli, "--mac"];
  if (process.env.ECHOVALE_LOCAL_SIGNING_IDENTITY) {
    builderArguments.push("-c.mac.identity=null");
  }
  if (process.argv.includes("--dir")) builderArguments.push("--dir");
  const configuredIdentity = process.env.CSC_LINK || process.env.CSC_NAME;
  const builderEnvironment = {
    ...process.env,
    npm_config_ignore_scripts: "false",
    ...(process.platform === "darwin" && !configuredIdentity
      ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" }
      : {}),
  };
  await run(process.execPath, builderArguments, { env: builderEnvironment });
} finally {
  await rebuildSqliteForNode(projectPath);
}
