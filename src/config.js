const fs = require("fs/promises");
const crypto = require("crypto");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, "data"));
const storageDir = path.resolve(process.env.STORAGE_DIR || path.join(rootDir, "storage"));
const hlsRoot = path.resolve(process.env.HLS_DIR || path.join(storageDir, "hls"));
const settingsPath = path.join(dataDir, "settings.json");

const defaultSettings = {
  m3uSource: process.env.M3U_SOURCE || "",
  xmltvSource: process.env.XMLTV_SOURCE || "",
  maxUpstreamConnections: 2,
  ffmpegPath: process.env.FFMPEG_PATH || "",
  defaultTranscodingProfile: "balanced",
  outputResolution: "720p",
  videoCodec: "h264",
  videoBitrate: "3500k",
  enableHardwareAcceleration: false,
  streamIdleTimeoutSeconds: 30,
  hlsSegmentDurationSeconds: 4,
  outputBufferSize: "3000k",
  websitePasswordHash: process.env.WEBSITE_PASSWORD ? hashPassword(process.env.WEBSITE_PASSWORD) : ""
};

async function ensureRuntimeDirs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(hlsRoot, { recursive: true });
}

function normalizeSettings(input = {}) {
  const merged = { ...defaultSettings, ...input };
  const hasWebsitePassword = Object.prototype.hasOwnProperty.call(input, "websitePassword");
  const outputResolution = normalizeChoice(
    merged.outputResolution,
    ["480p", "720p", "1080p"],
    "720p"
  );
  const videoCodec = normalizeChoice(merged.videoCodec, ["h264", "h265"], "h264");
  const websitePassword = hasWebsitePassword ? String(input.websitePassword || "") : "";
  const websitePasswordHash = websitePassword
    ? hashPassword(websitePassword)
    : normalizePasswordHash(merged.websitePasswordHash);

  return {
    m3uSource: String(merged.m3uSource || defaultSettings.m3uSource).trim(),
    xmltvSource: String(merged.xmltvSource || defaultSettings.xmltvSource).trim(),
    maxUpstreamConnections: clampInteger(merged.maxUpstreamConnections, 1, 100, 2),
    ffmpegPath: normalizeFfmpegPath(merged.ffmpegPath),
    defaultTranscodingProfile: String(merged.defaultTranscodingProfile || "balanced").trim(),
    outputResolution,
    videoCodec,
    videoBitrate: normalizeBitrate(
      merged.videoBitrate,
      suggestedVideoBitrate(outputResolution, videoCodec)
    ),
    enableHardwareAcceleration: Boolean(merged.enableHardwareAcceleration),
    streamIdleTimeoutSeconds: clampInteger(merged.streamIdleTimeoutSeconds, 5, 3600, 30),
    hlsSegmentDurationSeconds: clampInteger(merged.hlsSegmentDurationSeconds, 1, 30, 4),
    outputBufferSize: String(merged.outputBufferSize || "3000k").trim(),
    websitePasswordHash
  };
}

async function loadSettings() {
  await ensureRuntimeDirs();

  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Unable to read settings file, using defaults: ${error.message}`);
    }
    const settings = normalizeSettings(defaultSettings);
    await saveSettings(settings);
    return settings;
  }
}

async function saveSettings(settings) {
  await ensureRuntimeDirs();
  const normalized = normalizeSettings(settings);
  await fs.writeFile(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeChoice(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeBitrate(value, fallback) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d+)([km])?$/);
  if (!match) return fallback;

  const suffix = match[2] || "k";
  const amount =
    suffix === "m"
      ? clampInteger(match[1], 1, 50, 3)
      : clampInteger(match[1], 100, 50000, Number.parseInt(fallback, 10));
  return `${amount}${suffix}`;
}

function normalizeFfmpegPath(value) {
  const ffmpegPath = String(value || defaultSettings.ffmpegPath || "").trim();
  if (process.platform !== "win32" && /^[a-z]:[\\/]/i.test(ffmpegPath)) {
    return defaultSettings.ffmpegPath;
  }
  return ffmpegPath;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const normalizedHash = normalizePasswordHash(passwordHash);
  const [, salt, expectedHash] = normalizedHash.split(":");
  if (!salt || !expectedHash) return false;

  const actual = crypto.scryptSync(String(password || ""), salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalizePasswordHash(value) {
  const passwordHash = String(value || "").trim();
  return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/i.test(passwordHash) ? passwordHash : "";
}

function suggestedVideoBitrate(outputResolution = "720p", videoCodec = "h264") {
  const suggestions = {
    h264: {
      "480p": "1800k",
      "720p": "3500k",
      "1080p": "6000k"
    },
    h265: {
      "480p": "1200k",
      "720p": "2500k",
      "1080p": "4000k"
    }
  };

  const codec = normalizeChoice(videoCodec, ["h264", "h265"], "h264");
  const resolution = normalizeChoice(outputResolution, ["480p", "720p", "1080p"], "720p");
  return suggestions[codec][resolution];
}

module.exports = {
  rootDir,
  dataDir,
  hlsRoot,
  settingsPath,
  defaultSettings,
  ensureRuntimeDirs,
  loadSettings,
  saveSettings,
  normalizeSettings,
  verifyPassword,
  suggestedVideoBitrate
};
