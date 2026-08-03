// Manifest/versions contract — the checks Obsidian's review runs on manifest.json
// that eslint-plugin-obsidianmd's `validate-manifest` can't (eslint doesn't lint the
// JSON file without a JSON language plugin). Locks the class of issues that delist a
// plugin (redundant words in the metadata) plus release-version consistency.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));

// --- Redundant words the review rejects -------------------------------------
// The review bot's validate-manifest rule does a blunt case-insensitive SUBSTRING
// check for "obsidian" and "plugin" in name/description/id — with NO exception for a
// plugin that is *about* plugins. (An earlier version of this test wrongly exempted
// "plugin" here on the theory that a "Plugin Health Dashboard" earned it; the bot
// rejected that. Mirror the bot exactly instead.)
for (const key of ["name", "description", "id"]) {
	for (const word of ["obsidian", "plugin"]) {
		assert.ok(!new RegExp(word, "i").test(manifest[key]), `manifest.${key} must not contain "${word}" (the Obsidian review bot rejects it)`);
	}
}

// --- Shape -------------------------------------------------------------------
assert.ok(/^[a-z0-9-]+$/.test(manifest.id), "manifest.id must be lowercase letters/digits/hyphens");
assert.ok(manifest.minAppVersion && /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), "manifest.minAppVersion must be set (x.y.z)");
assert.ok(manifest.author, "manifest.author must be set");
assert.equal(typeof manifest.isDesktopOnly, "boolean", "manifest.isDesktopOnly must be a boolean");

// --- Release consistency (tag == manifest version, listed in versions.json) --
assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.version must be x.y.z");
assert.equal(manifest.version, pkg.version, "manifest.json and package.json versions must match");
assert.ok(versions[manifest.version], `versions.json must contain an entry for ${manifest.version}`);

// --- PRODUCT_ID is also the plugin's own id ----------------------------------
// `PRODUCT_ID` in src/product.ts is the licence-signing identity, and it is ALSO
// the sole source of the "skip FlowKit's own frames" set in both watchers
// (runtimeWatcher.ts, errorWatcher.ts) — while the same concept everywhere else
// reads `this.manifest.id`. They are identical today and nothing is broken.
//
// But rotating a signed product id is a real operation in this portfolio (it has
// been done once already, to move one plugin off another's key), and if these two
// ever diverge the failure is silent and total: `attributeStack` stops skipping
// FlowKit's own frames, so every timer and every logged error in the vault is
// attributed to FlowKit and no other plugin is ever measured again. Two lines to
// make that a failed build instead.
const product = fs.readFileSync(path.join(root, "src", "product.ts"), "utf8");
const declared = /export const PRODUCT_ID = "([^"]+)"/.exec(product);
assert.ok(declared, "src/product.ts must declare PRODUCT_ID as a string literal");
assert.equal(
	declared[1],
	manifest.id,
	"PRODUCT_ID must equal manifest.id — both watchers use it to recognise FlowKit's own stack frames"
);

console.log("manifest contract tests passed");
