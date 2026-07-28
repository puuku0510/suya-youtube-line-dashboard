import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "sync-config.json");
const DATA_PATH = path.join(ROOT, "dashboard-data.json");
const UTAGE_BASE = "https://api.utage-system.com/v1";
const YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3";
const UTAGE_MIN_INTERVAL_MS = 1100;
const MAX_HISTORY_DAYS = 400;

const utageApiKey = process.env.UTAGE_API_KEY;
const youtubeApiKey = process.env.YOUTUBE_API_KEY;

if (!utageApiKey) throw new Error("UTAGE_API_KEY is not configured");
if (!youtubeApiKey) throw new Error("YOUTUBE_API_KEY is not configured");

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
let previous = {};
try {
  previous = JSON.parse(await readFile(DATA_PATH, "utf8"));
} catch {
  previous = {};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastUtageRequestAt = 0;

async function utageGet(endpoint) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const waitMs = Math.max(0, lastUtageRequestAt + UTAGE_MIN_INTERVAL_MS - Date.now());
    if (waitMs) await sleep(waitMs);
    lastUtageRequestAt = Date.now();

    const response = await fetch(`${UTAGE_BASE}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${utageApiKey}`,
        Accept: "application/json"
      }
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 61_000);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      const safeEndpoint = endpoint.replace(/\/accounts\/[^/]+/g, "/accounts/[redacted]");
      throw new Error(`UTAGE ${safeEndpoint} failed (${response.status}): ${body.slice(0, 240)}`);
    }

    return response.json();
  }
  throw new Error(`UTAGE ${endpoint} exceeded retry limit`);
}

async function youtubeGet(resource, params) {
  const url = new URL(`${YOUTUBE_BASE}/${resource}`);
  Object.entries({ ...params, key: youtubeApiKey }).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube ${resource} failed (${response.status}): ${body.slice(0, 240)}`);
  }
  return response.json();
}

function tokyoDate(value = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function publicLineId(accountId) {
  return `line-${createHash("sha256").update(accountId).digest("hex").slice(0, 12)}`;
}

function normalizeTrackingName(value) {
  return String(value || "").normalize("NFKC").trim();
}

function publishedText(value) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days === 0) return "今日";
  if (days < 7) return `${days}日前`;
  if (days < 31) return `${Math.floor(days / 7)}週間前`;
  if (days < 365) return `${Math.floor(days / 30)}か月前`;
  return `${Math.floor(days / 365)}年前`;
}

async function fetchYouTubeData() {
  const ids = config.channels.map((channel) => channel.channelId).join(",");
  const channelResponse = await youtubeGet("channels", {
    part: "snippet,statistics,contentDetails",
    id: ids,
    maxResults: 50
  });
  const liveById = new Map(channelResponse.items.map((item) => [item.id, item]));
  const previousChannels = new Map((previous.channels || []).map((item) => [item.id, item]));
  const previousVideos = previous.videos || [];
  const channels = [];
  const videos = [];
  const descriptionSources = [];

  for (const configured of config.channels) {
    const live = liveById.get(configured.channelId);
    if (!live) {
      const fallback = previousChannels.get(configured.id);
      if (fallback) channels.push({ ...fallback, status: "unavailable" });
      videos.push(...previousVideos.filter((video) => video.channel === configured.id));
      continue;
    }

    const uploadPlaylistId = live.contentDetails?.relatedPlaylists?.uploads;
    const videoIds = [];
    let pageToken;
    do {
      const page = await youtubeGet("playlistItems", {
        part: "contentDetails",
        playlistId: uploadPlaylistId,
        maxResults: 50,
        pageToken
      });
      videoIds.push(...page.items.map((item) => item.contentDetails.videoId));
      pageToken = page.nextPageToken;
    } while (pageToken);

    let channelViewTotal = 0;
    for (let offset = 0; offset < videoIds.length; offset += 50) {
      const batchIds = videoIds.slice(offset, offset + 50);
      const page = await youtubeGet("videos", {
        part: "snippet,statistics,status",
        id: batchIds.join(","),
        maxResults: 50
      });
      for (const item of page.items) {
        if (item.status?.privacyStatus !== "public") continue;
        const views = Number(item.statistics?.viewCount || 0);
        channelViewTotal += views;
        videos.push({
          channel: configured.id,
          videoId: item.id,
          title: item.snippet.title,
          currentViews: views,
          publishedAt: item.snippet.publishedAt,
          publishedText: publishedText(item.snippet.publishedAt)
        });
        descriptionSources.push({
          channel: configured.id,
          videoId: item.id,
          description: item.snippet.description || ""
        });
      }
    }

    channels.push({
      id: configured.id,
      name: configured.name,
      handle: configured.handle,
      channelId: configured.channelId,
      subscribers: Number(live.statistics?.subscriberCount || 0),
      currentViews: channelViewTotal,
      status: configured.status || "active"
    });
  }

  videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const trackingById = await discoverYouTubeTrackingIds(descriptionSources);
  return { channels, videos, trackingById };
}

function extractDescriptionUrls(description) {
  return (String(description).match(/https?:\/\/[^\s\u3000<>()\]」]+/g) || [])
    .map((value) => value.replace(/[.,。、]+$/g, ""));
}

async function resolveUtageUrl(rawUrl) {
  const allowedHosts = new Set(["x.gd", "tinyurl.com", "utage-system.com"]);
  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    return null;
  }

  for (let redirect = 0; redirect < 6; redirect += 1) {
    if (!allowedHosts.has(current.hostname.toLowerCase())) return null;
    let response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "YouTube-LINE-Dashboard/1.0" },
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      return null;
    }

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    return current.hostname.toLowerCase() === "utage-system.com" ? current : null;
  }
  return null;
}

async function discoverYouTubeTrackingIds(descriptionSources) {
  const sourceByUrl = new Map();
  for (const source of descriptionSources) {
    for (const url of extractDescriptionUrls(source.description)) {
      let hostname;
      try {
        hostname = new URL(url).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!["x.gd", "tinyurl.com", "utage-system.com"].includes(hostname)) continue;
      const sources = sourceByUrl.get(url) || [];
      sources.push(source);
      sourceByUrl.set(url, sources);
    }
  }

  const trackingById = new Map();
  const ambiguousIds = new Set();
  for (const [url, sources] of sourceByUrl) {
    const resolved = await resolveUtageUrl(url);
    const trackingId = resolved?.searchParams.get("mtid");
    if (!trackingId) continue;
    for (const source of sources) {
      const existing = trackingById.get(trackingId);
      if (existing && existing.videoId !== source.videoId) {
        ambiguousIds.add(trackingId);
        trackingById.delete(trackingId);
        continue;
      }
      if (!ambiguousIds.has(trackingId)) {
        trackingById.set(trackingId, {
          channel: source.channel,
          videoId: source.videoId
        });
      }
    }
  }
  return trackingById;
}

async function fetchAllReaders(accountId) {
  const readers = [];
  let page = 1;
  while (true) {
    const payload = await utageGet(`/accounts/${accountId}/readers?per_page=100&page=${page}`);
    readers.push(...(payload.data || []));
    const total = Number(payload.meta?.total || 0);
    if (readers.length >= total || !(payload.data || []).length) break;
    page += 1;
  }
  return readers;
}

async function fetchUtageData(youtubeTrackingById) {
  const accountsPayload = await utageGet("/accounts");
  const accounts = accountsPayload.data || [];
  const lineAccounts = accounts.filter(
    (account) => account.type === "line" || account.type === "mail_line"
  );
  const previousLines = new Map((previous.officialLines || []).map((line) => [line.id, line]));
  const lineRules = new Map(config.lineAccountRules.map((rule) => [rule.accountName, rule]));
  const routeRules = new Map(
    config.routeMappings.map((rule) => [normalizeTrackingName(rule.trackingName), rule])
  );
  const officialLines = [];
  const scopedReaderCandidates = [];
  const discoveredLineChannels = new Map();

  for (const account of lineAccounts) {
    const readers = await fetchAllReaders(account.id);
    for (const reader of readers) {
      const trackingName = reader.message_tracking_name || reader.funnel_tracking_name || null;
      const routeRule = trackingName ? routeRules.get(normalizeTrackingName(trackingName)) : null;
      const videoRule = reader.message_tracking_id
        ? youtubeTrackingById.get(reader.message_tracking_id)
        : null;
      const channel = videoRule?.channel || routeRule?.channel || null;
      if (!channel) continue;
      const lineChannels = discoveredLineChannels.get(account.id) || new Set();
      lineChannels.add(channel);
      discoveredLineChannels.set(account.id, lineChannels);
      scopedReaderCandidates.push({
        uniqueId: reader.common_reader_id || reader.id,
        createdAt: reader.created_at,
        date: tokyoDate(reader.created_at),
        channel,
        videoId: videoRule?.videoId || routeRule?.videoId || null,
        line: publicLineId(account.id),
        trackingName,
        knownRoute: Boolean(videoRule || routeRule)
      });
    }
  }

  for (const account of lineAccounts) {
    const configuredRule = lineRules.get(account.name);
    const detectedChannels = discoveredLineChannels.get(account.id);
    if (!configuredRule && !detectedChannels?.size) continue;
    const channels = [
      ...new Set([...(configuredRule?.channels || []), ...(detectedChannels || [])])
    ];
    try {
      const allFriends = await utageGet(`/accounts/${account.id}/line/friends?per_page=1`);
      const activeFriends = await utageGet(
        `/accounts/${account.id}/line/friends?is_blocked=false&is_exclusion=false&per_page=1`
      );
      officialLines.push({
        id: publicLineId(account.id),
        name: account.name,
        totalFriends: Number(allFriends.meta?.total || 0),
        activeFriends: Number(activeFriends.meta?.total || 0),
        channels,
        status: "connected"
      });
    } catch (error) {
      const old = previousLines.get(publicLineId(account.id));
      officialLines.push({
        id: publicLineId(account.id),
        name: account.name,
        totalFriends: old?.totalFriends ?? null,
        activeFriends: old?.activeFriends ?? null,
        channels,
        status: old ? "stale" : "unavailable"
      });
      console.warn(`LINE aggregate unavailable for ${account.name}: ${error.message}`);
    }
  }

  const firstRegistration = new Map();
  for (const candidate of scopedReaderCandidates) {
    const current = firstRegistration.get(candidate.uniqueId);
    const isBetterAttribution =
      current &&
      ((!current.knownRoute && candidate.knownRoute) ||
        (!current.videoId && candidate.videoId));
    const isEarlierEquivalent =
      current &&
      current.knownRoute === candidate.knownRoute &&
      Boolean(current.videoId) === Boolean(candidate.videoId) &&
      new Date(candidate.createdAt) < new Date(current.createdAt);
    if (!current || isBetterAttribution || isEarlierEquivalent) {
      firstRegistration.set(candidate.uniqueId, candidate);
    }
  }

  const grouped = new Map();
  for (const reader of firstRegistration.values()) {
    const key = [reader.date, reader.channel, reader.videoId || "", reader.line].join("|");
    const current = grouped.get(key) || {
      date: reader.date,
      channel: reader.channel,
      videoId: reader.videoId,
      line: reader.line,
      leads: 0
    };
    current.leads += 1;
    grouped.set(key, current);
  }

  officialLines.sort((a, b) => {
    const aActive = a.activeFriends ?? -1;
    const bActive = b.activeFriends ?? -1;
    return bActive - aActive || a.name.localeCompare(b.name, "ja");
  });

  return {
    officialLines,
    records: [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date)),
    accountCount: accounts.length,
    youtubeTrackingCount: youtubeTrackingById.size
  };
}

function mergeHistory(previousHistory, rows, keyFields) {
  const today = tokyoDate();
  const cutoff = new Date(`${today}T00:00:00+09:00`);
  cutoff.setDate(cutoff.getDate() - MAX_HISTORY_DAYS);
  const cutoffDate = tokyoDate(cutoff);
  const byKey = new Map();
  for (const row of previousHistory || []) {
    if (row.date >= cutoffDate && row.date !== today) {
      byKey.set(keyFields.map((key) => row[key]).join("|"), row);
    }
  }
  for (const row of rows) {
    const snapshot = { date: today, ...row };
    byKey.set(keyFields.map((key) => snapshot[key]).join("|"), snapshot);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const youtube = await fetchYouTubeData();
const utage = await fetchUtageData(youtube.trackingById);
const youtubeHistory = mergeHistory(
  previous.youtubeHistory,
  youtube.channels.map((channel) => ({
    channel: channel.id,
    subscribers: channel.subscribers,
    views: channel.currentViews
  })),
  ["date", "channel"]
);
const youtubeVideoHistory = mergeHistory(
  previous.youtubeVideoHistory,
  youtube.videos.map((video) => ({
    videoId: video.videoId,
    views: video.currentViews
  })),
  ["date", "videoId"]
);

const now = new Date();
const output = {
  meta: {
    mode: "live-api",
    lastSync: now.toISOString(),
    youtubeSnapshotAt: now.toISOString(),
    timezone: config.timezone,
    utageAccountCount: utage.accountCount,
    youtubeTrackingCount: utage.youtubeTrackingCount,
    notice: "YouTube概要欄の登録用リンクとUTAGEを照合し、YouTube由来だけを表示しています。公式LINEの有効友だち数は、ブロック・配信除外を除いた現在値です。"
  },
  channels: youtube.channels,
  videos: youtube.videos,
  officialLines: utage.officialLines,
  records: utage.records,
  youtubeHistory,
  youtubeVideoHistory
};

await writeFile(DATA_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(
  `Synced ${output.channels.length} channels, ${output.videos.length} videos, ` +
  `${output.officialLines.length} LINE accounts, ${output.records.length} aggregate lead rows.`
);
