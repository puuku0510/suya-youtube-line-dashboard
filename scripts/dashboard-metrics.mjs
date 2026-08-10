const ALL = "すべて";

const within = (value, start, end) => (!start || value >= start) && (!end || value <= end);
const matches = (value, selected) => !selected || selected === ALL || value === selected;
const number = (value) => Number(value || 0);
const ratio = (numerator, denominator) => denominator ? numerator / denominator : 0;

export function filterCohortRows(rows, filters = {}) {
  return rows.filter((row) =>
    within(row.registration_date, filters.registrationStart, filters.registrationEnd) &&
    matches(row.source, filters.source) &&
    matches(row.funnel_name, filters.funnel) &&
    matches(row.line_name, filters.line) &&
    matches(row.channel_name, filters.channel)
  );
}

function totals(rows) {
  const fields = [
    "registered", "zoom_applied", "seminar_applied", "vsl_started", "vsl_completed",
    "meeting_from_vsl", "openchat_offered", "openchat_clicked"
  ];
  return Object.fromEntries(fields.map((field) => [field, rows.reduce((sum, row) => sum + number(row[field]), 0)]));
}

export function summarizeCohortRows(rows, filters = {}) {
  const selected = filterCohortRows(rows, filters);
  const all = totals(selected);
  const youtube = totals(selected.filter((row) => row.source === "YouTube"));
  const youtubeApplicable = !filters.source || filters.source === ALL || filters.source === "YouTube";
  return {
    totals: all,
    rates: {
      youtube_line_to_zoom: youtubeApplicable ? ratio(youtube.zoom_applied, youtube.registered) : null,
      youtube_zoom_to_seminar: youtubeApplicable ? ratio(youtube.seminar_applied, youtube.zoom_applied) : null,
      line_to_seminar: ratio(all.seminar_applied, all.registered),
      vsl_started_to_meeting: ratio(all.meeting_from_vsl, all.vsl_started),
      vsl_completed_to_meeting: ratio(all.meeting_from_vsl, all.vsl_completed),
      openchat_offered_to_clicked: ratio(all.openchat_clicked, all.openchat_offered)
    }
  };
}
