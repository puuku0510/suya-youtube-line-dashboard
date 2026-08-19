const normalize = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();

function valuesFrom(items) {
  const values = [];
  for (const item of items || []) {
    if (typeof item === "string" || typeof item === "number") values.push(String(item));
    else if (item && typeof item === "object") {
      for (const key of ["name", "title", "label_name", "scenario_name", "status"]) {
        if (item[key]) values.push(String(item[key]));
      }
    }
  }
  return values;
}

function labelAssignmentsFrom(items) {
  const assignments = new Map();
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const label = [item.name, item.title, item.label_name].find(Boolean);
    const assignedAt = item.assigned_at || item.assignedAt || null;
    if (!label || !assignedAt) continue;
    const key = normalize(label);
    const previous = assignments.get(key);
    if (!previous || String(assignedAt) < String(previous)) assignments.set(key, String(assignedAt));
  }
  return assignments;
}

export function extractReaderSignals(reader) {
  const labelCollections = [reader.labels, reader.label_names, reader.tags, reader.tag_names];
  const labelAssignments = new Map();
  for (const items of labelCollections) {
    for (const [label, assignedAt] of labelAssignmentsFrom(items)) {
      const previous = labelAssignments.get(label);
      if (!previous || String(assignedAt) < String(previous)) labelAssignments.set(label, assignedAt);
    }
  }
  const labelValues = [
    ...valuesFrom(reader.labels),
    ...valuesFrom(reader.label_names),
    ...valuesFrom(reader.tags),
    ...valuesFrom(reader.tag_names)
  ];
  const contextValues = [
    ...valuesFrom(reader.scenarios),
    ...valuesFrom(reader.subscriptions),
    reader.scenario_name,
    reader.current_scenario_name,
    reader.funnel_tracking_name,
    reader.message_tracking_name,
    reader.status
  ].filter(Boolean);
  return {
    labels: new Set(labelValues.map(normalize).filter(Boolean)),
    context: new Set(contextValues.map(normalize).filter(Boolean)),
    labelsAvailable: labelValues.length > 0,
    labelAssignments
  };
}

function includesAny(signals, values) {
  const needles = (values || []).map(normalize).filter(Boolean);
  if (!needles.length) return false;
  const haystack = [...signals.labels, ...signals.context];
  return needles.some((needle) => haystack.some((value) => value === needle || value.includes(needle)));
}

function lineDefinition(accountName, config) {
  const name = normalize(accountName);
  return config.officialLines.find((line) =>
    [line.name, ...(line.aliases || [])].map(normalize).includes(name)
  );
}

function funnelDefinition(line, signals, trackingName, config) {
  const candidates = config.funnels.filter((funnel) => funnel.lineKey === line.key);
  const tracking = normalize(trackingName);
  return candidates.find((funnel) =>
    includesAny(signals, funnel.matchAny) ||
    (funnel.trackingIncludes || []).some((value) => tracking.includes(normalize(value)))
  ) || candidates.find((funnel) => funnel.default) || null;
}

function stageDefinition(signals, config) {
  return config.stages.find((stage) => includesAny(signals, stage.matchAny)) ||
    config.stages.find((stage) => stage.id === (signals.labelsAvailable ? "line_registered" : "unclassified"));
}

function statusDefinition(reader, signals, stage, config) {
  if (reader.is_blocked === true || reader.blocked === true || reader.is_exclusion === true || reader.excluded === true) {
    return config.statuses.find((status) => status.id === "stopped");
  }
  const liveStatus = config.statuses.find((status) => ["error", "manual", "stopped"].includes(status.id) && includesAny(signals, status.matchAny));
  if (liveStatus) return liveStatus;
  if (stage?.id === "completed") return config.statuses.find((status) => status.id === "completed");
  return config.statuses.find((status) => status.id === "automatic");
}

function eventEvidence(signals, config) {
  const flags = Object.fromEntries(
    Object.entries(config.events).map(([key, aliases]) => [key, includesAny(signals, aliases) ? 1 : 0])
  );
  const timestamped = Object.fromEntries(
    Object.entries(config.events).map(([key, aliases]) => {
      const needles = aliases.map(normalize).filter(Boolean);
      const hasAssignedAt = [...signals.labelAssignments.keys()].some((label) =>
        needles.some((needle) => label === needle || label.includes(needle))
      );
      return [`${key}_timestamped`, hasAssignedAt ? 1 : 0];
    })
  );
  // Old UTAGE routes did not preserve path-specific evt_* labels. Infer the
  // VSL path only when the same deduplicated reader has both a meeting booking
  // and a VSL-offer history. Explicit path labels still take precedence.
  if (flags.meeting_applied && flags.vsl_offered && !flags.meeting_from_vsl) {
    flags.meeting_from_vsl = 1;
  }
  return { ...flags, ...timestamped };
}

function mergeSignals(target, incoming) {
  for (const value of incoming.labels) target.labels.add(value);
  for (const value of incoming.context) target.context.add(value);
  target.labelsAvailable ||= incoming.labelsAvailable;
  for (const [label, assignedAt] of incoming.labelAssignments) {
    const previous = target.labelAssignments.get(label);
    if (!previous || String(assignedAt) < String(previous)) target.labelAssignments.set(label, assignedAt);
  }
  return target;
}

function mergeReaderFlags(target, incoming) {
  for (const key of ["is_blocked", "blocked", "is_exclusion", "excluded"]) {
    target[key] ||= incoming?.[key] === true;
  }
  return target;
}

function earlierThan(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  if (!Number.isFinite(rightTime)) return Number.isFinite(leftTime);
  return Number.isFinite(leftTime) && leftTime < rightTime;
}

function groupIncrement(map, key, base, fields) {
  const row = map.get(key) || { ...base };
  for (const [field, value] of Object.entries(fields)) row[field] = Number(row[field] || 0) + Number(value || 0);
  map.set(key, row);
}

function dateAgeDays(snapshotDate, cohortDate) {
  const [sy, sm, sd] = String(snapshotDate).split("-").map(Number);
  const [cy, cm, cd] = String(cohortDate).split("-").map(Number);
  if (![sy, sm, sd, cy, cm, cd].every(Number.isFinite)) return null;
  return Math.max(0, Math.floor((Date.UTC(sy, sm - 1, sd) - Date.UTC(cy, cm - 1, cd)) / 86_400_000));
}

function qualityRows(cohortRows, snapshotAt, tokyoDate) {
  const snapshotDate = tokyoDate(snapshotAt);
  return cohortRows.map((row) => {
    const eventKeys = [
      "zoom_applied", "seminar_offered", "seminar_applied", "vsl_offered", "vsl_started",
      "vsl_completed", "meeting_applied", "meeting_from_vsl", "meeting_from_seminar",
      "openchat_offered", "openchat_clicked"
    ];
    const observed = eventKeys.reduce((sum, key) => sum + Number(row[key] || 0), 0);
    const timestamped = eventKeys.reduce((sum, key) => sum + Number(row[`${key}_timestamped`] || 0), 0);
    const cohortAgeDays = dateAgeDays(snapshotDate, row.registration_date);
    return {
      cohort_date_proxy: row.registration_date,
      acquisition_timestamp_basis: row.acquisition_timestamp_basis || "proxy_reader_created_at",
      timezone_status: row.timezone_status || "unverified",
      line_id: row.line_id,
      line_name: row.line_name,
      source: row.source,
      funnel_id: row.funnel_id,
      funnel_name: row.funnel_name,
      channel_id: row.channel_id,
      channel_name: row.channel_name,
      video_id: row.video_id,
      video_title: row.video_title,
      acquired_observed: row.registered,
      seminar_applied_observed: row.seminar_applied,
      seminar_applied_timestamped: row.seminar_applied_timestamped,
      meeting_applied_observed: row.meeting_applied,
      meeting_applied_timestamped: row.meeting_applied_timestamped,
      observed_event_flags: observed,
      timestamped_event_flags: timestamped,
      event_timestamp_coverage_rate: observed ? timestamped / observed : "",
      event_timestamp_completeness: observed === 0 ? "unknown" : timestamped === observed ? "complete" : "partial",
      cohort_age_days: cohortAgeDays,
      d7_denominator_eligible_proxy: cohortAgeDays == null ? "" : cohortAgeDays >= 7 ? 1 : 0,
      d7_outcome_exact: 0,
      snapshot_at: row.snapshot_at,
      quality: row.quality
    };
  });
}

export function buildFunnelAnalytics({ readers, config, snapshotAt, tokyoDate }) {
  const unique = new Map();
  let configuredReaderCount = 0;

  for (const item of readers) {
    const line = lineDefinition(item.accountName, config);
    if (!line) continue;
    configuredReaderCount += 1;
    const signals = extractReaderSignals(item.reader);
    const key = `${line.key}|${item.uniqueId}`;
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, {
        ...item,
        line,
        signals: {
          labels: new Set(signals.labels),
          context: new Set(signals.context),
          labelsAvailable: signals.labelsAvailable,
          labelAssignments: new Map(signals.labelAssignments)
        },
        reader: mergeReaderFlags({}, item.reader)
      });
      continue;
    }

    mergeSignals(previous.signals, signals);
    mergeReaderFlags(previous.reader, item.reader);
    if (earlierThan(item.createdAt, previous.createdAt)) {
      previous.createdAt = item.createdAt;
      previous.trackingName = item.trackingName;
      previous.channel = item.channel;
      previous.channelName = item.channelName;
      previous.videoId = item.videoId;
      previous.videoTitle = item.videoTitle;
    } else {
      previous.trackingName ||= item.trackingName;
      previous.channel ||= item.channel;
      previous.channelName ||= item.channelName;
      previous.videoId ||= item.videoId;
      previous.videoTitle ||= item.videoTitle;
    }
  }

  const current = new Map();
  const cohort = new Map();
  let unclassifiedCount = 0;
  let labelsAvailableCount = 0;
  let missingAcquisitionTimestampCount = 0;

  for (const item of unique.values()) {
    if (item.signals.labelsAvailable) labelsAvailableCount += 1;
    const funnel = funnelDefinition(item.line, item.signals, item.trackingName, config);
    if (!funnel) continue;
    item.funnel = funnel;
    const stage = stageDefinition(item.signals, config);
    const status = statusDefinition(item.reader, item.signals, stage, config);
    if (stage.id === "unclassified") unclassifiedCount += 1;
    const quality = item.signals.labelsAvailable ? "ok" : "labels_unavailable";
    const currentKey = [item.line.key, item.funnel.id, stage.id, status.id, quality].join("|");
    groupIncrement(current, currentKey, {
      snapshot_at: snapshotAt,
      line_id: item.line.key,
      line_name: item.line.name,
      source: item.funnel.source,
      funnel_id: item.funnel.id,
      funnel_name: item.funnel.name,
      stage_id: stage.id,
      stage_name: stage.name,
      status_id: status.id,
      status_name: status.name,
      quality,
      source_system: "UTAGE"
    }, { count: 1 });

    if (!item.createdAt) {
      missingAcquisitionTimestampCount += 1;
      continue;
    }
    let registrationDate;
    try {
      registrationDate = tokyoDate(item.createdAt);
    } catch {
      missingAcquisitionTimestampCount += 1;
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(registrationDate)) {
      missingAcquisitionTimestampCount += 1;
      continue;
    }
    const events = eventEvidence(item.signals, config);
    const channelId = item.channel || "";
    const channelName = item.channelName || "";
    const videoId = item.videoId || "";
    const videoTitle = item.videoTitle || "";
    const cohortKey = [registrationDate, item.line.key, item.funnel.id, channelId, videoId, quality].join("|");
    groupIncrement(cohort, cohortKey, {
      registration_date: registrationDate,
      line_id: item.line.key,
      line_name: item.line.name,
      source: item.funnel.source,
      funnel_id: item.funnel.id,
      funnel_name: item.funnel.name,
      channel_id: channelId,
      channel_name: channelName,
      video_id: videoId,
      video_title: videoTitle,
      snapshot_at: snapshotAt,
      quality,
      acquisition_timestamp_basis: item.createdAtBasis || "proxy_reader_created_at",
      timezone_status: item.timezoneStatus || "unverified"
    }, { registered: 1, ...events });
  }

  const cohortRows = [...cohort.values()].sort((a, b) => a.registration_date.localeCompare(b.registration_date));
  const cohortQuality = qualityRows(cohortRows, snapshotAt, tokyoDate);
  const observedEventFlags = cohortQuality.reduce((sum, row) => sum + Number(row.observed_event_flags || 0), 0);
  const timestampedEventFlags = cohortQuality.reduce((sum, row) => sum + Number(row.timestamped_event_flags || 0), 0);

  return {
    current: [...current.values()],
    cohort: cohortRows,
    cohortQuality,
    health: [{
      snapshot_at: snapshotAt,
      configured_reader_records: configuredReaderCount,
      unique_readers: unique.size,
      labels_available_readers: labelsAvailableCount,
      unclassified_readers: unclassifiedCount,
      label_coverage_rate: unique.size ? labelsAvailableCount / unique.size : 0,
      observed_event_flags: observedEventFlags,
      timestamped_event_flags: timestampedEventFlags,
      event_timestamp_coverage_rate: observedEventFlags ? timestampedEventFlags / observedEventFlags : null,
      registration_timestamp_basis: "proxy_reader_created_at",
      missing_acquisition_timestamp_readers: missingAcquisitionTimestampCount,
      status: configuredReaderCount === 0
        ? "no_configured_accounts"
        : labelsAvailableCount === 0
          ? "labels_unavailable"
          : unclassifiedCount || missingAcquisitionTimestampCount
            ? "partial"
            : "ok",
      note: "created_atはシナリオ読者登録proxy。オプチャ反応は実参加ではなくリンククリック。"
    }]
  };
}

export function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n") + "\n";
}
