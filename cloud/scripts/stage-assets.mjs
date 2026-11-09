// Copies the compiled game and test pages into cloud/dist for Cloudflare to serve.
// Runs automatically before `wrangler dev` and `wrangler deploy` (see wrangler.jsonc "build").
// index.html is committed, so this never needs Tweego.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cloudDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(cloudDir, "..");
const dist = join(cloudDir, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const copies = [
    [join(repoRoot, "index.html"), join(dist, "index.html")],
    [join(repoRoot, "Media"), join(dist, "Media")],
    [join(cloudDir, "public"), dist],
];
for (const [from, to] of copies) {
    if (!existsSync(from)) {
        console.error(`stage-assets: missing ${from}`);
        process.exit(1);
    }
    cpSync(from, to, { recursive: true });
}
console.log(`stage-assets: staged game + test pages into ${dist}`);
