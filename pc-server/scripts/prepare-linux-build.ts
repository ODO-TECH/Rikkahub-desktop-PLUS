import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// Bun 1.4.2 on Linux could not load these optional ssh2 N-API accelerators
// (uv_version_string). Keep their exclusion for the 1.4.5 upgrade: the isolated
// Debian check imported ssh2 successfully, but had no accelerator binaries to
// verify native loading. That checks the JavaScript fallback, not N-API support.
const optionalBindings = [
  resolve(import.meta.dir, "../node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node"),
  resolve(import.meta.dir, "../node_modules/cpu-features/build/Release/cpufeatures.node"),
];

if (process.platform !== "linux") {
  console.log(`Keeping local optional SSH accelerators for ${process.platform}; the Linux Bun bundle externalizes them.`);
  process.exit(0);
}

for (const binding of optionalBindings) {
  if (!existsSync(binding)) continue;
  rmSync(binding);
  console.log(`Removed optional Linux-incompatible SSH accelerator: ${binding}`);
}
