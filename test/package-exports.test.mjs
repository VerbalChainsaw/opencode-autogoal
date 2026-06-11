/**
 * Tests for the `exports` field in package.json.
 *
 * Each subpath with a `types` field MUST point at a `.d.ts` file. The
 * `./schema` subpath was accidentally pointing at `./dist/goal-state.js`
 * (the runtime), which broke TS consumers of the schema subpath.
 *
 * Run from the repo root: `node --test test/package-exports.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));

test("package.json: every exports[*].types ends with .d.ts", () => {
  const exports = pkg.exports ?? {};
  const subpaths = Object.keys(exports);
  assert.ok(subpaths.length > 0, "package.json has no exports field");
  for (const subpath of subpaths) {
    const entry = exports[subpath];
    // Each export can be a string or an object. We only care about
    // objects with a `types` field.
    if (typeof entry !== "object" || entry === null) continue;
    if (typeof entry.types !== "string") continue;
    assert.ok(
      entry.types.endsWith(".d.ts"),
      `exports[${JSON.stringify(subpath)}].types = ${JSON.stringify(entry.types)} should end with .d.ts`,
    );
  }
});

test("package.json: ./schema subpath points to the .d.ts (not the .js)", () => {
  // Pin the original bug: the previous code had:
  //   "./schema": { "types": "./dist/goal-state.js", "import": "./dist/goal-state.js" }
  // Both fields pointed at the runtime. TS consumers importing from
  // "opencode-autogoal/schema" got the JS, not the type declarations.
  const schema = pkg.exports?.["./schema"];
  assert.ok(schema && typeof schema === "object", "exports[./schema] is missing or not an object");
  assert.equal(schema.types, "./dist/goal-state.d.ts",
    `exports[./schema].types should be './dist/goal-state.d.ts', got: ${schema.types}`);
  assert.equal(schema.import, "./dist/goal-state.js",
    `exports[./schema].import should be './dist/goal-state.js', got: ${schema.import}`);
});
