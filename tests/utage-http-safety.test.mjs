import test from "node:test";
import assert from "node:assert/strict";
import { redactUtageEndpoint, retryDelayMs } from "../scripts/utage-http-safety.mjs";

test("UTAGE error paths redact account, common reader and friend identifiers", () => {
  const raw = "/accounts/account-secret/common-readers/person-secret/labels?friend=unchanged";
  assert.equal(
    redactUtageEndpoint(raw),
    "/accounts/[account]/common-readers/[common-reader]/labels?friend=unchanged"
  );
  assert.equal(
    redactUtageEndpoint("/accounts/account-secret/line/friends/friend-secret"),
    "/accounts/[account]/line/friends/[friend]"
  );
  assert.doesNotMatch(redactUtageEndpoint(raw), /account-secret|person-secret/);
});

test("429 wait uses reset, then Retry-After, then a safe fallback", () => {
  const nowMs = 1_000_000;
  assert.equal(retryDelayMs({ rateReset: "1061", retryAfter: null, nowMs }), 61_000);
  assert.equal(retryDelayMs({ rateReset: null, retryAfter: "7", nowMs }), 7_000);
  assert.equal(retryDelayMs({ rateReset: null, retryAfter: null, nowMs }), 61_000);
  assert.equal(retryDelayMs({ rateReset: "", retryAfter: "", nowMs }), 61_000);
  assert.equal(retryDelayMs({ rateReset: "999", retryAfter: null, nowMs }), 61_000);
  assert.equal(retryDelayMs({ rateReset: "9999999", retryAfter: null, nowMs }), 900_000);
});
