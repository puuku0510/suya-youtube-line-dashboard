import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFunnelAnalytics, toCsv } from "../scripts/funnel-analytics.mjs";

const config = JSON.parse(await readFile(new URL("../funnel-analytics-config.json", import.meta.url), "utf8"));
const tokyoDate = (value) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

test("stage and handling status are independent and each reader is counted once", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-11T03:00:00.000Z",
    tokyoDate,
    readers: [
      { accountName: "こすもす【公式】", uniqueId: "u1", createdAt: "2026-08-10T01:00:00Z", trackingName: "Instagram", reader: { labels: ["src_instagram_10benefits", "vsl_main_started", "manual_handling"] } },
      { accountName: "こすもす【公式】", uniqueId: "u2", createdAt: "2026-08-10T02:00:00Z", trackingName: "Instagram", reader: { labels: ["src_instagram_10benefits", "openchat_link_clicked"] } }
    ]
  });
  assert.equal(result.current.reduce((sum, row) => sum + row.count, 0), 2);
  assert.equal(result.current.find((row) => row.stage_id === "vsl_in_progress").status_id, "manual");
  assert.equal(result.current.find((row) => row.stage_id === "openchat_clicked").count, 1);
});

test("cohort events are aggregated by LINE registration date", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-11T03:00:00.000Z",
    tokyoDate,
    readers: [{ accountName: "AIでひとり起業（広告）", uniqueId: "m1", createdAt: "2026-08-01T16:00:00Z", trackingName: "meta seminar", reader: { labels: ["src_meta_seminar", "evt_seminar_applied", "evt_vsl_started", "evt_vsl_completed", "evt_meeting_from_vsl", "evt_meeting_applied"] } }]
  });
  assert.equal(result.cohort[0].registration_date, "2026-08-02");
  assert.equal(result.cohort[0].seminar_applied, 1);
  assert.equal(result.cohort[0].meeting_from_vsl, 1);
});

test("legacy YouTube LINE accounts are included and old scenario names recover events", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-11T03:00:00.000Z",
    tokyoDate,
    readers: [{
      accountName: "ゆるAI",
      uniqueId: "legacy-1",
      createdAt: "2026-07-01T01:00:00Z",
      trackingName: "旧ルート",
      reader: {
        labels: ["benefit_delivered"],
        scenarios: ["Zoomサポート会リマインダ", "セミナー募集_未申込者", "09 申込者LINE（k6x新規）", "VSL_一部視聴", "05 面談予約リマインド（vVq新規）"]
      }
    }]
  });
  assert.equal(result.current[0].funnel_id, "youtube-yuru-legacy");
  assert.equal(result.cohort[0].zoom_applied, 1);
  assert.equal(result.cohort[0].seminar_offered, 1);
  assert.equal(result.cohort[0].seminar_applied, 1);
  assert.equal(result.cohort[0].vsl_offered, 1);
  assert.equal(result.cohort[0].vsl_started, 1);
  assert.equal(result.cohort[0].meeting_applied, 1);
  assert.equal(result.cohort[0].meeting_from_vsl, 1);
});

test("multiple scenario records are unioned per reader without losing the entry cohort", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-11T03:00:00.000Z",
    tokyoDate,
    readers: [
      { accountName: "AI×一人起業【YouTube統合】", uniqueId: "same-reader", createdAt: "2026-08-01T23:30:00Z", trackingName: "YouTube統合", channel: "UC-entry", channelName: "ゆるAI", videoId: "entry-video", videoTitle: "入口動画", reader: { labels: ["src_youtube", "evt_zoom_applied"] } },
      { accountName: "AI×一人起業【YouTube統合】", uniqueId: "same-reader", createdAt: "2026-08-05T01:00:00Z", trackingName: "VSL", reader: { labels: ["evt_vsl_started", "evt_vsl_completed"] } },
      { accountName: "AI×一人起業【YouTube統合】", uniqueId: "same-reader", createdAt: "2026-08-06T01:00:00Z", trackingName: "個別面談", reader: { labels: ["evt_meeting_applied", "evt_meeting_from_vsl"] } }
    ]
  });
  assert.equal(result.current.reduce((sum, row) => sum + row.count, 0), 1);
  assert.equal(result.current[0].stage_id, "meeting_booked");
  assert.equal(result.cohort[0].registration_date, "2026-08-02");
  assert.equal(result.cohort[0].channel_id, "UC-entry");
  assert.equal(result.cohort[0].video_id, "entry-video");
  assert.equal(result.cohort[0].zoom_applied, 1);
  assert.equal(result.cohort[0].vsl_started, 1);
  assert.equal(result.cohort[0].vsl_completed, 1);
  assert.equal(result.cohort[0].meeting_applied, 1);
  assert.equal(result.cohort[0].meeting_from_vsl, 1);
  assert.equal(result.health[0].configured_reader_records, 3);
  assert.equal(result.health[0].unique_readers, 1);
  assert.equal(result.health[0].labels_available_readers, 1);
  assert.equal(result.health[0].label_coverage_rate, 1);
});

test("sales_stop is a stopped handling status, not a completed stage", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-11T03:00:00.000Z",
    tokyoDate,
    readers: [{
      accountName: "AIでひとり起業（広告）",
      uniqueId: "stopped-reader",
      createdAt: "2026-08-10T01:00:00Z",
      trackingName: "meta seminar",
      reader: { labels: ["src_meta_seminar", "evt_seminar_applied", "sales_stop"] }
    }]
  });
  assert.equal(result.current[0].stage_id, "seminar_booked");
  assert.equal(result.current[0].status_id, "stopped");
});

test("handling status precedence is error over manual over stopped over automatic", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-11T03:00:00.000Z",
    tokyoDate,
    readers: [{
      accountName: "こすもす【公式】",
      uniqueId: "multi-state-reader",
      createdAt: "2026-08-10T01:00:00Z",
      trackingName: "Instagram",
      reader: { labels: ["src_instagram_10benefits", "evt_vsl_started", "sales_stop", "manual_in_funnel", "transition_error"] }
    }]
  });
  assert.equal(result.current[0].stage_id, "vsl_in_progress");
  assert.equal(result.current[0].status_id, "error");
});

test("label assigned_at is preserved as timestamp coverage without claiming exact D+7", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-19T03:00:00.000Z",
    tokyoDate,
    readers: [{
      accountName: "こすもす【公式】",
      uniqueId: "timestamped-reader",
      createdAt: "2026-08-10T01:00:00Z",
      createdAtBasis: "proxy_reader_created_at",
      timezoneStatus: "unverified",
      trackingName: "Instagram",
      reader: {
        labels: [
          { name: "src_instagram_10benefits", assigned_at: "2026-08-10 10:00:00" },
          { name: "evt_seminar_applied", assigned_at: "2026-08-12 11:00:00" }
        ]
      }
    }]
  });

  assert.equal(result.cohort[0].seminar_applied, 1);
  assert.equal(result.cohort[0].seminar_applied_timestamped, 1);
  assert.equal(result.cohortQuality[0].acquisition_timestamp_basis, "proxy_reader_created_at");
  assert.equal(result.cohortQuality[0].d7_denominator_eligible_proxy, 1);
  assert.equal(result.cohortQuality[0].d7_outcome_exact, 0);
  assert.equal(result.cohortQuality[0].event_timestamp_completeness, "complete");
});

test("context-only historical evidence remains untimestamped and partial", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-19T03:00:00.000Z",
    tokyoDate,
    readers: [{
      accountName: "ゆるAI",
      uniqueId: "context-reader",
      createdAt: "2026-08-01T01:00:00Z",
      trackingName: "旧ルート",
      reader: {
        labels: ["src_youtube_yuru"],
        scenarios: ["09 申込者LINE（k6x新規）"]
      }
    }]
  });

  assert.equal(result.cohort[0].seminar_applied, 1);
  assert.equal(result.cohort[0].seminar_applied_timestamped, 0);
  assert.equal(result.cohortQuality[0].event_timestamp_completeness, "partial");
  assert.equal(result.cohortQuality[0].d7_outcome_exact, 0);
});

test("missing acquisition timestamp stays in current state but is excluded from cohorts", () => {
  const result = buildFunnelAnalytics({
    config,
    snapshotAt: "2026-08-19T03:00:00.000Z",
    tokyoDate,
    readers: [{
      accountName: "こすもす【公式】",
      uniqueId: "missing-time",
      createdAt: null,
      trackingName: "Instagram",
      reader: { labels: ["src_instagram_10benefits", "evt_seminar_applied"] }
    }]
  });

  assert.equal(result.current.reduce((sum, row) => sum + row.count, 0), 1);
  assert.equal(result.cohort.length, 0);
  assert.equal(result.health[0].missing_acquisition_timestamp_readers, 1);
  assert.equal(result.health[0].status, "partial");
});

test("CSV escapes commas and line breaks", () => {
  assert.equal(toCsv([{ a: "x,y", b: "line\n2" }], ["a", "b"]), 'a,b\n"x,y","line\n2"\n');
});
