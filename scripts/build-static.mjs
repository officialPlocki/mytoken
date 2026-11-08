import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = new URL("target/dx/mytoken/release/web/public/", root);
const output = new URL("dist/", root);

execFileSync("dx", ["bundle", "--web", "--release"], {
  cwd: fileURLToPath(root),
  stdio: "inherit",
});

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await cp(new URL("assets/scripts/", root), new URL("dist/scripts/", root), { recursive: true });
console.log("Built the Dioxus web bundle in dist/.");
