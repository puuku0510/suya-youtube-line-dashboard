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
      throw new Error(`UTAGE ${endpoint} failed (${response.status}): ${body.slice(0, 240)}`);
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
  return { channels, videos };
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

async function fetchUtageData() {
  const accountsPayload = await utageGet("/accounts");
  const accounts = accountsPayload.data || [];
  const previousLines = new Map((previous.officialLines || []).map((line) => [line.id, line]));
  const lineRules = new Map(config.lineAccountRules.map((rule) => [rule.accountName, rule]));
  const routeRules = new Map(config.routeMappings.map((rule) => [rule.trackingName, rule]));
  const officialLines = [];
  const scopedReaderCandidates = [];

  for (const account of accounts) {
    if (account.type === "line" || account.type === "mail_line") {
      try {
        const allFriends = await utageGet(`/accounts/${account.id}/line/friends?per_page=1`);
        const activeFriends = await utageGet(
          `/accounts/${account.id}/line/friends?is_blocked=false&is_exclusion=false&per_page=1`
        );
        const rule = lineRules.get(account.name);
        officialLines.push({
          id: publicLineId(account.id),
          name: account.name,
          totalFriends: Number(allFriends.meta?.total || 0),
          activeFriends: Number(activeFriends.meta?.total || 0),
          channels: rule?.channels || [],
          status: "connected"
        });
      } catch (error) {
        const old = previousLines.get(publicLineId(account.id));
        const rule = lineRules.get(account.name);
        officialLines.push({
          id: publicLineId(account.id),
          name: account.name,
          totalFriends: old?.totalFriends ?? null,
          activeFriends: old?.activeFriends ?? null,
          channels: rule?.channels || old?.channels || [],
          status: old ? "stale" : "unavailable"
        });
        console.warn(`LINE aggregate unavailable for ${account.name}: ${error.message}`);
      }
    }

    const readers = await fetchAllReaders(account.id);
    const accountRule = lineRules.get(account.name);
    for (const reader of readers) {
      const trackingName = reader.message_tracking_name || reader.funnel_tracking_name || null;
      const routeRule = trackingName ? routeRules.get(trackingName) : null;
      const channel = routeRule?.channel || accountRule?.defaultChannel || null;
      if (!channel) continue;
      scopedReaderCandidates.push({
        uniqueId: reader.common_reader_id || reader.id,
        createdAt: reader.created_at,
        date: tokyoDate(reader.created_at),
        channel,
        videoId: routeRule?.videoId || null,
        line: publicLineId(account.id),
        trackingName
      });
    }
  }

  const firstRegistration = new Map();
  for (const candidate of scopedReaderCandidates) {
    const current = firstRegistration.get(candidate.uniqueId);
    if (!current || new Date(candidate.createdAt) < new Date(current.createdAt)) {
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
    accountCount: accounts.length
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

const [youtube, utage] = await Promise.all([fetchYouTubeData(), fetchUtageData()]);
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
    notice: "UTAGE全配信アカウントとYouTube Data APIを自動同期しています。公式LINEの有効友だち数は、ブロック・配信除外を除いた現在値です。"
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
