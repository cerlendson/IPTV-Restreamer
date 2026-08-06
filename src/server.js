const express = require("express");
const path = require("path");
const {
  rootDir,
  hlsRoot,
  ensureRuntimeDirs,
  loadSettings,
  saveSettings,
  normalizeSettings
} = require("./config");
const { createEmptyCatalog, importCatalog, getSchedule } = require("./iptv");
const { StreamManager } = require("./stream-manager");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);

let settings = null;
let catalog = createEmptyCatalog();
let importState = { status: "idle", message: "", updatedAt: null };

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(rootDir, "public")));
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
  res.json(settings);
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const previousSettings = settings;
    const nextSettings = normalizeSettings(req.body);
    const streamsRestarted = transcodingSettingsChanged(previousSettings, nextSettings);

    settings = await saveSettings(nextSettings);
    if (streamsRestarted) {
      await streamManager.stopAll();
    }

    res.json({ settings, streamsRestarted });
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    importStatus: importState.status,
    activeStreams: streamManager.listActiveStreams().length
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
