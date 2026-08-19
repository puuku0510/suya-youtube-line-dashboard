export function redactUtageEndpoint(endpoint) {
  return String(endpoint || "")
    .replace(/\/accounts\/[^/?]+/g, "/accounts/[account]")
    .replace(/\/common-readers\/[^/?]+/g, "/common-readers/[common-reader]")
    .replace(/\/line\/friends\/[^/?]+/g, "/line/friends/[friend]");
}

export function retryDelayMs({ rateReset, retryAfter, nowMs = Date.now(), fallbackMs = 61_000, maxMs = 900_000 }) {
  const resetNumber = rateReset == null || String(rateReset).trim() === "" ? NaN : Number(rateReset);
  const resetWaitMs = Number.isFinite(resetNumber) ? resetNumber * 1000 - nowMs : NaN;
  if (Number.isFinite(resetWaitMs) && resetWaitMs > 0) return Math.min(resetWaitMs, maxMs);

  const retryAfterNumber = retryAfter == null || String(retryAfter).trim() === "" ? NaN : Number(retryAfter);
  const retryAfterMs = Number.isFinite(retryAfterNumber) ? retryAfterNumber * 1000 : NaN;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, maxMs);

  return fallbackMs;
}
