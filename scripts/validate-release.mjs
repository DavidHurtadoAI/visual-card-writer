import { access, readFile } from "node:fs/promises";

const [manifestText, packageText, versionsText] = await Promise.all([
  readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../versions.json", import.meta.url), "utf8"),
]);

const manifest = JSON.parse(manifestText);
const packageJson = JSON.parse(packageText);
const versions = JSON.parse(versionsText);
const requestedVersion = process.argv.slice(2).find((argument) => argument !== "--");
const exactVersionPattern = /^\d+\.\d+\.\d+$/;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

if (!exactVersionPattern.test(manifest.version)) {
  throw new Error(`manifest.json version must use the exact x.y.z format: ${manifest.version}.`);
}

if (!pluginIdPattern.test(manifest.id) || manifest.id.includes("obsidian")) {
  throw new Error(
    `manifest.json id must be unique, lowercase, hyphenated, and must not contain "obsidian": ${manifest.id}.`,
  );
}

if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
  throw new Error("manifest.json must include a non-empty plugin name.");
}

if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
  throw new Error("manifest.json must include a non-empty plugin description.");
}

if (!exactVersionPattern.test(manifest.minAppVersion)) {
  throw new Error(`manifest.json minAppVersion must use the x.y.z format: ${manifest.minAppVersion}.`);
}

if (typeof manifest.isDesktopOnly !== "boolean") {
  throw new Error("manifest.json isDesktopOnly must be a boolean.");
}

if (manifest.version !== packageJson.version) {
  throw new Error(
    `Version mismatch: manifest.json is ${manifest.version}, package.json is ${packageJson.version}.`,
  );
}

if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error(
    `versions.json must map ${manifest.version} to ${manifest.minAppVersion}.`,
  );
}

if (requestedVersion && requestedVersion !== manifest.version) {
  throw new Error(
    `Release tag ${requestedVersion} must exactly match manifest version ${manifest.version}.`,
  );
}

await Promise.all(
  ["README.md", "LICENSE", "main.js", "manifest.json", "styles.css"].map(async (path) => {
    try {
      await access(new URL(`../${path}`, import.meta.url));
    } catch {
      throw new Error(`Required release file is missing: ${path}.`);
    }
  }),
);

console.log(`Release metadata is valid for ${manifest.version}.`);
