// Writes each production TypeScript module under the frontend to the output
// directory, at the same path, as the JavaScript the browser loads: the module
// with its type syntax replaced by spaces, so every line and column stays
// where the source has it. Node applies the same transform when tests import
// the module.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

const [sourceRoot, outputRoot] = process.argv.slice(2);

for (const module of productionTypeScriptModules(sourceRoot)) {
  const output = path.join(outputRoot, module);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, stripTypeScriptTypes(readFileSync(path.join(sourceRoot, module), "utf8")));
}

function productionTypeScriptModules(root, prefix = "") {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "tests"
        ? []
        : productionTypeScriptModules(root, relative);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")
      ? [relative]
      : [];
  });
}
