import { readFile } from "node:fs/promises";

const [manifestText, packageText, versionsText] = await Promise.all([
  readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../versions.json", import.meta.url), "utf8"),
]);

const manifest = JSON.parse(manifestText);
const packageJson = JSON.parse(packageText);
const versions = JSON.parse(versionsText);
const requestedVersion = process.argv[2];

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

console.log(`Release metadata is valid for ${manifest.version}.`);
