const express = require("express");
const crypto = require("crypto");
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

let settings = null;
let catalog = createEmptyCatalog();
let importState = { status: "idle", message: "", updatedAt: null };
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
  res.json({
    importState,
    stats: catalog.stats,
    activeStreams: streamManager.listActiveStreams(),
    maxUpstreamConnections: settings.maxUpstreamConnections
  });
});

app.get("/api/groups", (req, res) => {
  res.json(catalog.groups);
});

app.get("/api/channels", (req, res) => {
  const group = String(req.query.group || "");
  const channels = catalog.channels
    .filter((channel) => !group || channel.group === group)
    .map((channel) => ({
      ...channel,
      streamUrl: undefined,
      schedule: getSchedule(catalog, channel.id)
    }));

  res.json(channels);
});

app.get("/api/channels/:channelId", (req, res) => {
  const channel = catalog.channels.find((entry) => entry.id === req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  res.json({
    ...channel,
    streamUrl: undefined,
    schedule: getSchedule(catalog, channel.id)
  });
});

app.post("/api/streams/:channelId/start", async (req, res, next) => {
  try {
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

  refreshCatalog().catch((error) => {
    console.error(`Startup import failed: ${error.message}`);
  });

  const server = app.listen(PORT, () => {
    console.log(`IPTV Restreamer listening at http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    console.log("Shutting down...");
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
