import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("UTAGE collector is explicitly read-only", async () => {
  const source = await readFile(new URL("../scripts/sync-dashboard.mjs", import.meta.url), "utf8");
  const utageFetch = /fetch\(`\$\{UTAGE_BASE\}\$\{endpoint\}`,[\s\S]*?method:\s*["']GET["']/;

  assert.match(source, utageFetch);
  assert.doesNotMatch(source, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
});
