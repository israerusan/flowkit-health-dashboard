// Bundles and runs the network probe. Separate from run.mjs on purpose: this
// one talks to GitHub, so it must never be part of `npm test`.
import esbuild from "esbuild";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "test", ".build", "network-probe.mjs");

await esbuild.build({
  entryPoints: [path.join(root, "test", "network-probe.ts")],
  bundle: true,
  outfile,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "warning",
  alias: {
    // The one stub with a real requestUrl behind it.
    obsidian: path.join(root, "test", "obsidian-net-stub.ts"),
  },
});

await import(pathToFileURL(outfile).href);
