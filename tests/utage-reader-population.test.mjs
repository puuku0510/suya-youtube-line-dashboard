import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalyticsPopulation, explicitCommonReaderId } from "../scripts/utage-reader-population.mjs";

test("friend id is never treated as a common reader id", () => {
  assert.equal(explicitCommonReaderId({ id: "line-friend-id" }), null);
  assert.equal(explicitCommonReaderId({ id: "scenario-reader-id", common_reader_id: "common-id" }), "common-id");
});

test("analytics population is keyed by the readers endpoint common_reader_id", () => {
  const population = buildAnalyticsPopulation([
    { id: "scenario-1", common_reader_id: "common-1", scenario_title: "入口" },
    { id: "scenario-2", common_reader_id: "common-1", scenario_title: "VSL" }
  ], [
    { id: "friend-only-id", is_blocked: false }
  ]);

  assert.equal(population.length, 1);
  assert.equal(population[0].commonId, "common-1");
  assert.equal(population[0].scenarioReaders.length, 2);
  assert.deepEqual(population[0].friend, {});
});

test("friend detail is joined only when it exposes the same common_reader_id", () => {
  const population = buildAnalyticsPopulation([
    { id: "scenario-1", common_reader_id: "common-1" }
  ], [
    { id: "friend-1", common_reader_id: "common-1", is_blocked: true }
  ]);

  assert.equal(population[0].friend.is_blocked, true);
});
