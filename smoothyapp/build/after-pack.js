const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const entitlements = path.join(
    context.packager.info.projectDir,
    "build",
    "entitlements.mac.plist"
  );

  const signArgs = ["--force", "--deep", "--sign", "-", "--timestamp=none"];
  if (fs.existsSync(entitlements)) {
    signArgs.push("--options", "runtime", "--entitlements", entitlements);
  }
  signArgs.push(appPath);

  console.log(`[after-pack] ad-hoc signing ${appPath}`);
  execFileSync("codesign", signArgs, { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("[after-pack] ad-hoc signature valid");
};
