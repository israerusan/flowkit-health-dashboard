// Bundles the scoring tests with the `obsidian` import aliased to a Node-safe
// stub, then executes them. Keeps the tests running the real src/scoring.ts.
import esbuild from "esbuild";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "test", ".build", "scoring.test.cjs");

await esbuild.build({
  entryPoints: [path.join(root, "test", "scoring.test.ts")],
  bundle: true,
  outfile,
  format: "cjs",
  platform: "node",
  target: "node18",
  logLevel: "warning",
  alias: {
    obsidian: path.join(root, "test", "obsidian-stub.ts"),
  },
});

await import(pathToFileURL(outfile).href);

// Plain-Node contract tests (no `obsidian` import, so no bundling needed).
await import(pathToFileURL(path.join(root, "test", "manifest-contract.test.mjs")).href);
