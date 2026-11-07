import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = new URL("public/", root);
const output = new URL("dist/", root);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("index.html", source), new URL("index.html", output));
await cp(new URL("assets/", source), new URL("assets/", output), { recursive: true });
await cp(new URL("scripts/", source), new URL("scripts/", output), { recursive: true });
console.log("Prepared the static Sites bundle in dist/.");
