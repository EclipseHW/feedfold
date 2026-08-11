import { spawn } from "node:child_process";
import { join } from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped with ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
    });
  });
}

export default async function signLocalMacBuild(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const localIdentity = process.env.FEEDFOLD_LOCAL_SIGNING_IDENTITY;
  if (localIdentity) {
    console.log(`Signing the local macOS build with ${localIdentity}.`);
    await run("codesign", ["--force", "--deep", "--sign", localIdentity, appPath]);
    return;
  }

  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  console.log("Applying an ad-hoc signature for the local macOS build.");
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
}
