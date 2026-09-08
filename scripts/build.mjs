import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, createWriteStream } from "node:fs";
import { ZipArchive } from "archiver";

const watch = process.argv.includes("--watch");
const dist = "dist";

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    background: "src/background.js",
    popup: "src/popup.js",
    options: "src/options.js",
    offscreen: "src/offscreen.js",
    extract: "src/extract.js",
  },
  bundle: true,
  format: "iife",
  target: "chrome116",
  outdir: dist,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
});

cpSync("static", dist, { recursive: true });
cpSync("manifest.json", `${dist}/manifest.json`);

if (!watch) {
  const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
  mkdirSync("release", { recursive: true });
  const out = createWriteStream(`release/copy-for-ai-v${version}.zip`);
  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.pipe(out);
  zip.directory(dist, false);
  await zip.finalize();
  await new Promise((r) => out.on("close", r));
  console.log(`release/copy-for-ai-v${version}.zip written`);
}
