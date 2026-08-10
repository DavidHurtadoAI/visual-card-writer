import esbuild from "esbuild";
import process from "node:process";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

const context = await esbuild.context({
  absWorkingDir: projectDirectory,
  entryPoints: [path.join(projectDirectory, "main.ts")],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2018",
  platform: "browser",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: path.join(projectDirectory, "main.js"),
  logLevel: "info"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
