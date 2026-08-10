import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCohortRows } from "../scripts/dashboard-metrics.mjs";

const rows = [
  { registration_date: "2026-08-01", source: "YouTube", funnel_name: "YouTube統合", line_name: "AI×一人起業【YouTube統合】", channel_name: "ゆるAI", registered: 10, zoom_applied: 5, seminar_applied: 2, vsl_started: 4, vsl_completed: 2, meeting_from_vsl: 1, openchat_offered: 4, openchat_clicked: 2 },
  { registration_date: "2026-08-02", source: "YouTube", funnel_name: "YouTube統合", line_name: "AI×一人起業【YouTube統合】", channel_name: "ゆっくりAI", registered: 20, zoom_applied: 4, seminar_applied: 1, vsl_started: 2, vsl_completed: 1, meeting_from_vsl: 1, openchat_offered: 2, openchat_clicked: 1 },
  { registration_date: "2026-08-02", source: "Instagram", funnel_name: "Instagram｜10大特典", line_name: "こすもす【公式】", channel_name: "", registered: 8, zoom_applied: 0, seminar_applied: 4, vsl_started: 4, vsl_completed: 2, meeting_from_vsl: 2, openchat_offered: 2, openchat_clicked: 1 },
  { registration_date: "2026-08-03", source: "Meta広告", funnel_name: "Meta広告｜セミナー直行", line_name: "AIでひとり起業（広告）", channel_name: "", registered: 6, zoom_applied: 0, seminar_applied: 3, vsl_started: 3, vsl_completed: 1, meeting_from_vsl: 1, openchat_offered: 1, openchat_clicked: 0 }
];

test("all six main rates honor registration dates and every dashboard filter", () => {
  const result = summarizeCohortRows(rows, {
    registrationStart: "2026-08-02",
    registrationEnd: "2026-08-02",
    source: "YouTube",
    funnel: "YouTube統合",
    line: "AI×一人起業【YouTube統合】",
    channel: "ゆっくりAI"
  });
  assert.deepEqual(result.totals, {
    registered: 20,
    zoom_applied: 4,
    seminar_applied: 1,
    vsl_started: 2,
    vsl_completed: 1,
    meeting_from_vsl: 1,
    openchat_offered: 2,
    openchat_clicked: 1
  });
  assert.deepEqual(result.rates, {
    youtube_line_to_zoom: 0.2,
    youtube_zoom_to_seminar: 0.25,
    line_to_seminar: 0.05,
    vsl_started_to_meeting: 0.5,
    vsl_completed_to_meeting: 1,
    openchat_offered_to_clicked: 0.5
  });
});

test("Zoom KPIs are explicitly not applicable when Instagram or Meta is selected", () => {
  const result = summarizeCohortRows(rows, { source: "Instagram" });
  assert.equal(result.rates.youtube_line_to_zoom, null);
  assert.equal(result.rates.youtube_zoom_to_seminar, null);
  assert.equal(result.rates.line_to_seminar, 0.5);
});
