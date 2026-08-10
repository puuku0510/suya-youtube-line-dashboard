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

export function extractReaderSignals(reader) {
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
    labelsAvailable: labelValues.length > 0
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

function eventFlags(signals, config) {
  const flags = Object.fromEntries(
    Object.entries(config.events).map(([key, aliases]) => [key, includesAny(signals, aliases) ? 1 : 0])
  );
  // Old UTAGE routes did not preserve path-specific evt_* labels. Infer the
  // VSL path only when the same deduplicated reader has both a meeting booking
  // and a VSL-offer history. Explicit path labels still take precedence.
  if (flags.meeting_applied && flags.vsl_offered && !flags.meeting_from_vsl) {
    flags.meeting_from_vsl = 1;
  }
  return flags;
}

function mergeSignals(target, incoming) {
  for (const value of incoming.labels) target.labels.add(value);
  for (const value of incoming.context) target.context.add(value);
  target.labelsAvailable ||= incoming.labelsAvailable;
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
        signals: { labels: new Set(signals.labels), context: new Set(signals.context), labelsAvailable: signals.labelsAvailable },
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

    const events = eventFlags(item.signals, config);
    const registrationDate = tokyoDate(item.createdAt);
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
      quality
    }, { registered: 1, ...events });
  }

  return {
    current: [...current.values()],
    cohort: [...cohort.values()].sort((a, b) => a.registration_date.localeCompare(b.registration_date)),
    health: [{
      snapshot_at: snapshotAt,
      configured_reader_records: configuredReaderCount,
      unique_readers: unique.size,
      labels_available_readers: labelsAvailableCount,
      unclassified_readers: unclassifiedCount,
      label_coverage_rate: unique.size ? labelsAvailableCount / unique.size : 0,
      status: configuredReaderCount === 0 ? "no_configured_accounts" : labelsAvailableCount === 0 ? "labels_unavailable" : unclassifiedCount ? "partial" : "ok",
      note: "オプチャ反応は実参加ではなくリンククリック。実参加は手動補助指標。"
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
