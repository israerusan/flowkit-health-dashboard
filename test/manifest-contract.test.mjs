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

console.log("manifest contract tests passed");
