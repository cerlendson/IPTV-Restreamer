const express = require("express");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const {
  rootDir,
  hlsRoot,
  ensureRuntimeDirs,
  loadSettings,
  saveSettings,
  normalizeSettings,
  verifyPassword
} = require("./config");
const { createEmptyCatalog, importCatalog, getSchedule } = require("./iptv");
const { StreamManager } = require("./stream-manager");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const AUTH_COOKIE = "iptv_auth";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CATALOG_REFRESH_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const AUTO_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

let settings = null;
let catalog = createEmptyCatalog();
let importState = { status: "idle", message: "", updatedAt: null };
let refreshPromise = null;
const sessions = new Map();

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(rootDir, "public")));

app.get("/api/auth/status", (req, res) => {
  const passwordRequired = isPasswordRequired();
  res.json({
    passwordRequired,
    authenticated: !passwordRequired || isAuthenticated(req)
  });
});

app.post("/api/auth/login", (req, res) => {
  if (!isPasswordRequired()) {
    res.json({ ok: true });
    return;
  }

  if (!verifyPassword(req.body?.password, settings.websitePasswordHash)) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }

  issueAuthSession(req, res);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req)[AUTH_COOKIE];
  if (token) sessions.delete(token);
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    importStatus: importState.status,
    activeStreams: streamManager.listActiveStreams().length
  });
});

app.get("/playlist.m3u", (req, res) => {
  const password = requireFeedPassword(req, res);
  if (password == null) return;

  res
    .type("application/x-mpegurl")
    .set("Cache-Control", "no-store")
    .send(buildM3uPlaylist(req, password));
});

app.get(["/xmltv.xml", "/epg.xml"], (req, res) => {
  const password = requireFeedPassword(req, res);
  if (password == null) return;

  res
    .type("application/xml")
    .set("Cache-Control", "no-store")
    .send(buildXmltvGuide());
});

app.get("/stream/:channelId/index.m3u8", async (req, res, next) => {
  try {
    const password = requireFeedPassword(req, res);
    if (password == null) return;

    const channelId = req.params.channelId;
    if (isChannelExcluded(channelId)) {
      res.status(404).send("Channel not found.");
      return;
    }

    const stream = await streamManager.startExternal(channelId);
    const playlist = await fs.readFile(stream.playlistPath, "utf8");
    res
      .type("application/vnd.apple.mpegurl")
      .set("Cache-Control", "no-store")
      .send(rewriteHlsPlaylist(req, channelId, password, playlist));
  } catch (error) {
    next(error);
  }
});

app.get("/stream/:channelId/:fileName", async (req, res, next) => {
  try {
    const password = requireFeedPassword(req, res);
    if (password == null) return;

    const channelId = req.params.channelId;
    const fileName = req.params.fileName;
    if (isChannelExcluded(channelId) || !isSafeHlsFileName(fileName)) {
      res.status(404).send("File not found.");
      return;
    }

    const stream = await streamManager.startExternal(channelId);
    const filePath = path.join(stream.outputDir, fileName);
    await fs.access(filePath);
    res.set("Cache-Control", "no-store").sendFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.status(404).send("File not found.");
      return;
    }
    next(error);
  }
});

app.use(requireAuth);

app.use(
  "/hls",
  express.static(hlsRoot, {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
  })
);

const streamManager = new StreamManager({
  hlsRoot,
  getSettings: () => settings,
  getChannel: (channelId) => catalog.channels.find((channel) => channel.id === channelId)
});

app.get("/api/settings", (req, res) => {
  res.json(publicSettings(settings));
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const previousSettings = settings;
    const nextSettings = normalizeSettings({ ...settings, ...req.body });
    const streamsRestarted = transcodingSettingsChanged(previousSettings, nextSettings);
    const passwordChanged =
      previousSettings.websitePasswordHash !== nextSettings.websitePasswordHash;

    settings = await saveSettings(nextSettings);
    if (passwordChanged) {
      sessions.clear();
      issueAuthSession(req, res);
    }
    if (streamsRestarted) {
      await streamManager.stopAll();
    }

    res.json({ settings: publicSettings(settings), streamsRestarted });
  } catch (error) {
    next(error);
  }
});

app.post("/api/refresh", async (req, res, next) => {
  try {
    await refreshCatalog();
    res.json({ importState, stats: catalog.stats });
  } catch (error) {
    next(error);
  }
});

app.get("/api/status", (req, res) => {
  const channels = visibleChannels();
  const groups = visibleGroups(channels);
  res.json({
    importState,
    stats: {
      ...catalog.stats,
      channelCount: channels.length,
      groupCount: groups.length
    },
    activeStreams: streamManager.listActiveStreams(),
    maxUpstreamConnections: settings.maxUpstreamConnections
  });
});

app.get("/api/filter-options", (req, res) => {
  res.json({
    groups: catalog.groups,
    channels: catalog.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      group: channel.group
    }))
  });
});

app.get("/api/groups", (req, res) => {
  res.json(visibleGroups());
});

app.get("/api/channels", (req, res) => {
  const group = String(req.query.group || "");
  const channels = visibleChannels()
    .filter((channel) => !group || channel.group === group)
    .map((channel) => ({
      ...channel,
      streamUrl: undefined,
      schedule: getSchedule(catalog, channel.id)
    }));

  res.json(channels);
});

app.get("/api/channels/:channelId", (req, res) => {
  const channel = visibleChannels().find((entry) => entry.id === req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  res.json({
    ...channel,
    streamUrl: undefined,
    schedule: getSchedule(catalog, channel.id)
  });
});

app.post("/api/streams/:channelId/start", async (req, res, next) => {
  try {
    if (isChannelExcluded(req.params.channelId)) {
      res.status(404).json({ error: "Channel not found." });
      return;
    }

    const stream = await streamManager.start(req.params.channelId);
    res.json(stream);
  } catch (error) {
    next(error);
  }
});

app.post("/api/viewers/:viewerId/heartbeat", (req, res) => {
  res.json({ ok: streamManager.heartbeat(req.params.viewerId) });
});

app.post("/api/viewers/:viewerId/release", (req, res) => {
  res.json({ ok: streamManager.release(req.params.viewerId) });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({
    error: error.message || "Unexpected server error."
  });
});

async function refreshCatalog() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = runCatalogRefresh().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function runCatalogRefresh() {
  importState = {
    status: "running",
    message: "Importing playlist and EPG...",
    updatedAt: new Date().toISOString()
  };

  try {
    catalog = await importCatalog(settings);
    importState = {
      status: catalog.stats.errors.length ? "warning" : "ready",
      message: catalog.stats.errors.length
        ? catalog.stats.errors.join(" ")
        : `Imported ${catalog.stats.channelCount} channels.`,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    catalog = createEmptyCatalog();
    importState = {
      status: "error",
      message: error.message,
      updatedAt: new Date().toISOString()
    };
    throw error;
  }
}

function startAutoRefreshTimer() {
  const timer = setInterval(() => {
    refreshCatalogIfStale().catch((error) => {
      console.error(`Automatic IPTV refresh failed: ${error.message}`);
    });
  }, AUTO_REFRESH_CHECK_INTERVAL_MS);

  timer.unref?.();
  return timer;
}

async function refreshCatalogIfStale() {
  if (!isCatalogStale()) return false;
  await refreshCatalog();
  return true;
}

function isCatalogStale() {
  if (refreshPromise) return false;
  if (!catalog.importedAt) return true;

  const importedAt = new Date(catalog.importedAt).getTime();
  if (!Number.isFinite(importedAt)) return true;

  return Date.now() - importedAt >= CATALOG_REFRESH_MAX_AGE_MS;
}

function buildM3uPlaylist(req, password) {
  const encodedPassword = encodeURIComponent(password);
  const baseUrl = requestBaseUrl(req);
  const lines = [`#EXTM3U x-tvg-url="${baseUrl}/xmltv.xml?password=${encodedPassword}"`];

  for (const channel of visibleChannels()) {
    const streamUrl = `${baseUrl}/stream/${encodeURIComponent(channel.id)}/index.m3u8?password=${encodedPassword}`;
    lines.push(
      `#EXTINF:-1 tvg-id="${m3uAttr(channel.id)}" tvg-name="${m3uAttr(channel.name)}" tvg-logo="${m3uAttr(channel.logo)}" group-title="${m3uAttr(channel.group)}",${m3uName(channel.name)}`,
      streamUrl
    );
  }

  return `${lines.join("\n")}\n`;
}

function buildXmltvGuide() {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="IPTV Restreamer">'
  ];

  for (const channel of visibleChannels()) {
    lines.push(`  <channel id="${xmlAttr(channel.id)}">`);
    lines.push(`    <display-name>${xmlText(channel.name)}</display-name>`);
    if (channel.logo) {
      lines.push(`    <icon src="${xmlAttr(channel.logo)}" />`);
    }
    lines.push("  </channel>");
  }

  for (const channel of visibleChannels()) {
    for (const programme of catalog.epgByChannelId[channel.id] || []) {
      const start = formatXmltvDate(programme.start);
      const stop = formatXmltvDate(programme.stop);
      if (!start || !stop) continue;

      lines.push(
        `  <programme start="${start}" stop="${stop}" channel="${xmlAttr(channel.id)}">`,
        `    <title>${xmlText(programme.title || "Untitled")}</title>`
      );
      if (programme.subTitle) {
        lines.push(`    <sub-title>${xmlText(programme.subTitle)}</sub-title>`);
      }
      if (programme.description) {
        lines.push(`    <desc>${xmlText(programme.description)}</desc>`);
      }
      lines.push("  </programme>");
    }
  }

  lines.push("</tv>");
  return `${lines.join("\n")}\n`;
}

function rewriteHlsPlaylist(req, channelId, password, playlist) {
  const baseUrl = requestBaseUrl(req);
  const encodedChannelId = encodeURIComponent(channelId);
  const encodedPassword = encodeURIComponent(password);

  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return line;
      const fileName = path.basename(trimmed);
      return `${baseUrl}/stream/${encodedChannelId}/${encodeURIComponent(fileName)}?password=${encodedPassword}`;
    })
    .join("\n");
}

function requireFeedPassword(req, res) {
  const password = String(req.query.password || "");
  if (!settings?.websitePasswordHash) {
    res.status(403).send("Set a website password before using playlist or EPG links.");
    return null;
  }

  if (!password || !verifyPassword(password, settings.websitePasswordHash)) {
    res.status(401).send("A valid password query parameter is required.");
    return null;
  }

  return password;
}

function requestBaseUrl(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function isSafeHlsFileName(fileName) {
  return /^[A-Za-z0-9._-]+$/.test(fileName) && fileName !== "index.m3u8";
}

function formatXmltvDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  const parts = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  ];
  const [year, ...rest] = parts;
  return `${year}${rest.map((part) => String(part).padStart(2, "0")).join("")} +0000`;
}

function m3uAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, " ");
}

function m3uName(value) {
  return String(value || "").replace(/\r?\n/g, " ").trim();
}

function xmlAttr(value) {
  return xmlText(value).replace(/"/g, "&quot;");
}

function xmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function transcodingSettingsChanged(previousSettings, nextSettings) {
  if (!previousSettings) return false;

  return [
    "ffmpegPath",
    "defaultTranscodingProfile",
    "outputResolution",
    "videoCodec",
    "videoBitrate",
    "enableHardwareAcceleration",
    "hlsSegmentDurationSeconds",
    "outputBufferSize"
  ].some((key) => previousSettings[key] !== nextSettings[key]);
}

function visibleChannels() {
  return catalog.channels.filter((channel) => !isChannelExcluded(channel.id));
}

function visibleGroups(channels = visibleChannels()) {
  const groupSet = new Set(channels.map((channel) => channel.group).filter(Boolean));
  return catalog.groups.filter((group) => groupSet.has(group) && !excludedGroupSet().has(group));
}

function isChannelExcluded(channelId) {
  const channel = catalog.channels.find((entry) => entry.id === channelId);
  if (!channel) return false;
  return excludedGroupSet().has(channel.group) || excludedChannelSet().has(channel.id);
}

function excludedGroupSet() {
  return new Set(settings?.excludedGroups || []);
}

function excludedChannelSet() {
  return new Set(settings?.excludedChannels || []);
}

function isPasswordRequired() {
  return Boolean(settings?.websitePasswordHash);
}

function requireAuth(req, res, next) {
  if (!isPasswordRequired() || isAuthenticated(req)) {
    next();
    return;
  }

  res.status(401).json({ error: "Enter the website password to continue." });
}

function isAuthenticated(req) {
  const token = parseCookies(req)[AUTH_COOKIE];
  const session = token ? sessions.get(token) : null;
  if (!session) return false;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function issueAuthSession(req, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  sessions.set(token, { expiresAt });

  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  const parts = [
    `${AUTH_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator === -1) return cookies;
      const key = decodeURIComponent(part.slice(0, separator));
      const value = decodeURIComponent(part.slice(separator + 1));
      cookies[key] = value;
      return cookies;
    }, {});
}

function publicSettings(settings) {
  const { websitePasswordHash, ...safeSettings } = settings;
  return {
    ...safeSettings,
    passwordEnabled: Boolean(websitePasswordHash)
  };
}

async function main() {
  await ensureRuntimeDirs();
  settings = await loadSettings();
  const autoRefreshTimer = startAutoRefreshTimer();

  refreshCatalog().catch((error) => {
    console.error(`Startup import failed: ${error.message}`);
  });

  const server = app.listen(PORT, () => {
    console.log(`IPTV Restreamer listening at http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    clearInterval(autoRefreshTimer);
    server.close();
    await streamManager.stopAll();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
