import assert from "node:assert/strict";
import { dirname, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// A custom event that carries a detail is declared once: its entry in the DOM
// event map and its detail type live in the module this rule picks.
// 1. One module dispatches it: that module.
// 2. Several dispatch it and one listens: the listening module.
// 3. Several on both sides: `<name>-event.ts` in the nearest directory holding
//    every dispatching module, past any `components/` directory, which also
//    exports the name as `<NAME>_EVENT`.

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
const config = ts.getParsedCommandLineOfConfigFile(
  `${frontendRoot}tsconfig.json`,
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} },
);
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();
const modulePath = (file) => relative(frontendRoot, file.fileName).split("\\").join("/");
const sources = program
  .getSourceFiles()
  .filter((file) => !file.isDeclarationFile && !relative(frontendRoot, file.fileName).startsWith(".."));

const dispatches = new Map();
const listeners = new Map();
const declarations = new Map();
const unnamed = [];
const casts = [];

for (const file of sources) {
  const path = modulePath(file);
  const visit = (node) => {
    if (ts.isNewExpression(node) && node.expression.getText() === "CustomEvent" && node.arguments?.length) {
      const init = node.arguments[1];
      const carries = Boolean(
        init && ts.isObjectLiteralExpression(init) && init.properties.some((p) => p.name?.getText() === "detail"),
      );
      const names = eventNames(node.arguments[0]);
      if (!names) {
        if (carries) unnamed.push(`${path}: ${node.arguments[0].getText()}`);
      } else {
        for (const name of names) record(dispatches, name, { path, carries });
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "addEventListener" && node.arguments.length) {
      for (const name of eventNames(node.arguments[0]) ?? []) record(listeners, name, path);
    }
    if (ts.isTemplateExpression(node)) {
      const texts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      for (const text of texts.slice(0, -1)) {
        const binding = text.match(/@([a-z][a-z0-9:-]*)=$/);
        if (binding) record(listeners, binding[1], path);
      }
    }
    if (ts.isInterfaceDeclaration(node) && ["HTMLElementEventMap", "WindowEventMap"].includes(node.name.text) &&
        ts.isModuleBlock(node.parent) && node.parent.parent.name.getText() === "global") {
      for (const member of node.members) {
        const key = ts.isComputedPropertyName(member.name)
          ? eventNames(member.name.expression)?.[0]
          : member.name.text;
        record(declarations, key ?? member.name.getText(), path);
      }
    }
    if (ts.isAsExpression(node) && /^CustomEvent\b/.test(node.type.getText())) {
      casts.push(`${path}: ${node.getText().slice(0, 60)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

const carried = [...dispatches].filter(([, sends]) => sends.some((send) => send.carries));

test("a dispatch that carries a detail names its event with a literal or a constant", () => {
  assert.deepEqual(unnamed, []);
});

test("each custom event that carries a detail is declared once, in the module its senders and listeners pick", () => {
  assert.ok(carried.length > 0);
  const misplaced = [];
  for (const [name, sends] of carried) {
    const owner = ownerOf(name, [...new Set(sends.map((send) => send.path))], [...new Set(listeners.get(name) ?? [])]);
    const declared = declarations.get(name) ?? [];
    if (declared.length !== 1 || declared[0] !== owner) {
      misplaced.push(`${name}: declared in [${declared.join(", ")}], belongs in ${owner}`);
    }
  }
  assert.deepEqual(misplaced, []);
});

test("an event module named for its event exports the name as its constant", () => {
  const modules = sources.filter((file) => modulePath(file).endsWith("-event.ts"));
  assert.ok(modules.length > 0);
  for (const file of modules) {
    const path = modulePath(file);
    const name = `caffold:${path.split("/").at(-1).slice(0, -".ts".length)}`.replace(/-event$/, "");
    const constant = `${name.slice("caffold:".length).replaceAll("-", "_").toUpperCase()}_EVENT`;
    assert.match(file.text, new RegExp(`export const ${constant} =\\s*"${name}";`), `${path} names ${name}`);
    assert.deepEqual(declarations.get(name), [path], `${path} declares ${name}`);
  }
});

test("the event maps declare only events that carry a detail", () => {
  const stale = [...declarations.keys()].filter((name) => !carried.some(([sent]) => sent === name));
  assert.deepEqual(stale, []);
});

test("listeners take the declared detail rather than casting the event", () => {
  assert.deepEqual(casts, []);
});

function ownerOf(name, senders, hearers) {
  if (senders.length === 1) return senders[0];
  if (hearers.length === 1) return hearers[0];
  const directories = senders.map((path) => dirname(path).split("/"));
  const common = [];
  for (let index = 0; directories.every((parts) => index < parts.length); index += 1) {
    const part = directories[0][index];
    if (!directories.every((parts) => parts[index] === part)) break;
    common.push(part);
  }
  while (common.at(-1) === "components") common.pop();
  return [...common, `${name.slice("caffold:".length)}-event.ts`].join("/");
}

function eventNames(node) {
  const type = checker.getTypeAtLocation(node);
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((part) => part.isStringLiteral()) ? parts.map((part) => part.value) : null;
}

function record(map, key, value) {
  map.set(key, [...(map.get(key) ?? []), value]);
}
