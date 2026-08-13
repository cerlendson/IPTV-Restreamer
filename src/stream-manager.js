const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const MAX_PLAYLIST_WAIT_MS = 15000;
const DEFAULT_VIDEO_MAXRATE = "3000k";
const AUDIO_BITRATE = "128k";

class StreamManager {
  constructor({ hlsRoot, getSettings, getChannel }) {
    this.hlsRoot = hlsRoot;
    this.getSettings = getSettings;
    this.getChannel = getChannel;
    this.streams = new Map();
    this.viewerToChannel = new Map();
  }

  listActiveStreams() {
    return Array.from(this.streams.values()).map((stream) => ({
      channelId: stream.channelId,
      channelName: stream.channelName,
      viewerCount: stream.viewerIds.size,
      lastActivity: stream.lastActivity,
      hlsOutputFolder: stream.outputDir,
      startedAt: stream.startedAt,
      status: stream.status,
      playbackProfile: stream.playbackProfile
    }));
  }

  async start(channelId) {
    const settings = this.getSettings();
    const channel = this.getChannel(channelId);
    if (!channel) {
      const error = new Error("Channel not found.");
      error.status = 404;
      throw error;
    }

    const stream = await this.getOrCreateStream(channel, settings);
    const viewerId = crypto.randomUUID();
    stream.viewerIds.add(viewerId);
    stream.lastActivity = new Date().toISOString();
    this.viewerToChannel.set(viewerId, channelId);

    return {
      viewerId,
      channelId,
      playlistUrl: `/hls/${encodeURIComponent(channelId)}/index.m3u8`,
      viewerCount: stream.viewerIds.size,
      reused: stream.viewerIds.size > 1,
      activeUpstreamConnections: this.streams.size,
      playbackProfile: stream.playbackProfile
    };
  }

  async startExternal(channelId) {
    const settings = this.getSettings();
    const channel = this.getChannel(channelId);
    if (!channel) {
      const error = new Error("Channel not found.");
      error.status = 404;
      throw error;
    }

    const stream = await this.getOrCreateStream(channel, settings);
    const viewerId = `external:${channelId}`;
    stream.viewerIds.add(viewerId);
    stream.lastActivity = new Date().toISOString();
    this.viewerToChannel.set(viewerId, channelId);
    this.scheduleExternalRelease(stream, viewerId);

    return {
      channelId,
      playlistPath: path.join(stream.outputDir, "index.m3u8"),
      outputDir: stream.outputDir,
      viewerCount: stream.viewerIds.size,
      reused: stream.viewerIds.size > 1,
      activeUpstreamConnections: this.streams.size,
      playbackProfile: stream.playbackProfile
    };
  }

  heartbeat(viewerId) {
    const stream = this.getStreamForViewer(viewerId);
    if (!stream) return false;
    stream.lastActivity = new Date().toISOString();
    return true;
  }

  release(viewerId) {
    const channelId = this.viewerToChannel.get(viewerId);
    if (!channelId) return false;

    const stream = this.streams.get(channelId);
    this.viewerToChannel.delete(viewerId);
    if (!stream) return false;

    stream.viewerIds.delete(viewerId);
    stream.lastActivity = new Date().toISOString();

    if (stream.viewerIds.size === 0) {
      this.scheduleIdleStop(stream);
    }

    return true;
  }

  async stopAll() {
    await Promise.all(Array.from(this.streams.values()).map((stream) => this.stopStream(stream)));
  }

  async getOrCreateStream(channel, settings) {
    let stream = this.streams.get(channel.id);
    if (!stream) {
      if (this.streams.size >= settings.maxUpstreamConnections) {
        const error = new Error(
          "Maximum number of active streams is currently in use. Please try again later."
        );
        error.status = 429;
        throw error;
      }
      stream = await this.createStream(channel, settings);
      this.streams.set(channel.id, stream);
    }

    if (stream.idleTimer) {
      clearTimeout(stream.idleTimer);
      stream.idleTimer = null;
    }

    return stream;
  }

  async createStream(channel, settings) {
    const outputDir = path.join(this.hlsRoot, channel.id);
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });

    const args = buildFfmpegArgs(channel.streamUrl, outputDir, settings);
    const command = settings.ffmpegPath || "ffmpeg";
    const ffmpeg = spawn(command, args, { windowsHide: true });
    const stream = {
      channelId: channel.id,
      channelName: channel.name,
      ffmpeg,
      viewerIds: new Set(),
      lastActivity: new Date().toISOString(),
      outputDir,
      startedAt: new Date().toISOString(),
      status: "starting",
      playbackProfile: outputPlaybackProfile(settings),
      idleTimer: null,
      externalTimer: null,
      stderrTail: []
    };

    ffmpeg.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        stream.stderrTail.push(line);
        if (stream.stderrTail.length > 20) stream.stderrTail.shift();
      }
    });

    ffmpeg.once("spawn", () => {
      stream.status = "running";
    });

    ffmpeg.once("error", async (error) => {
      stream.status = "error";
      stream.stderrTail.push(error.message);
      await this.stopStream(stream);
    });

    ffmpeg.once("exit", async () => {
      if (this.streams.get(channel.id) === stream) {
        stream.status = "exited";
        await this.stopStream(stream);
      }
    });

    try {
      await waitForPlaylist(path.join(outputDir, "index.m3u8"), stream);
      return stream;
    } catch (error) {
      await this.stopStream(stream);
      throw error;
    }
  }

  scheduleIdleStop(stream) {
    const settings = this.getSettings();
    if (stream.idleTimer) clearTimeout(stream.idleTimer);

    stream.idleTimer = setTimeout(() => {
      if (stream.viewerIds.size === 0) {
        this.stopStream(stream).catch((error) => {
          console.error(`Failed to stop stream ${stream.channelId}:`, error);
        });
      }
    }, settings.streamIdleTimeoutSeconds * 1000);
  }

  scheduleExternalRelease(stream, viewerId) {
    const settings = this.getSettings();
    if (stream.externalTimer) clearTimeout(stream.externalTimer);

    const timeoutMs = Math.max(settings.streamIdleTimeoutSeconds * 1000, 30000);
    stream.externalTimer = setTimeout(() => {
      stream.externalTimer = null;
      this.release(viewerId);
    }, timeoutMs);
  }

  async stopStream(stream) {
    if (stream.idleTimer) {
      clearTimeout(stream.idleTimer);
      stream.idleTimer = null;
    }
    if (stream.externalTimer) {
      clearTimeout(stream.externalTimer);
      stream.externalTimer = null;
    }

    for (const viewerId of stream.viewerIds) {
      this.viewerToChannel.delete(viewerId);
    }
    stream.viewerIds.clear();

    if (stream.ffmpeg && !stream.ffmpeg.killed) {
      stream.ffmpeg.kill("SIGTERM");
      setTimeout(() => {
        if (!stream.ffmpeg.killed) stream.ffmpeg.kill("SIGKILL");
      }, 3000).unref();
    }

    this.streams.delete(stream.channelId);
    await fs.rm(stream.outputDir, { recursive: true, force: true });
  }

  getStreamForViewer(viewerId) {
    const channelId = this.viewerToChannel.get(viewerId);
    return channelId ? this.streams.get(channelId) : null;
  }
}

function buildFfmpegArgs(inputUrl, outputDir, settings) {
  const profile = transcodingProfile(settings.defaultTranscodingProfile);
  const resolution = outputResolution(settings.outputResolution);
  const codec = videoCodec(settings.videoCodec);
  const videoBitrate = settings.videoBitrate || DEFAULT_VIDEO_MAXRATE;
  const playlistPath = path.join(outputDir, "index.m3u8");
  const segmentPath = path.join(outputDir, "segment_%05d.ts");
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5"
  ];

  if (settings.enableHardwareAcceleration) {
    args.push("-hwaccel", "auto");
  }

  args.push(
    "-i",
    inputUrl,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-vf",
    `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v",
    codec.encoder,
    "-preset",
    profile.preset,
    "-b:v",
    videoBitrate,
    "-maxrate",
    videoBitrate,
    "-bufsize",
    settings.outputBufferSize || "3000k",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-ac",
    "2",
    "-f",
    "hls",
    "-hls_time",
    String(settings.hlsSegmentDurationSeconds),
    "-hls_list_size",
    "8",
    "-hls_flags",
    "delete_segments+append_list+program_date_time",
    "-hls_segment_filename",
    segmentPath,
    playlistPath
  );

  return args;
}

function outputPlaybackProfile(settings) {
  const resolution = outputResolution(settings.outputResolution);
  const codec = videoCodec(settings.videoCodec);

  return {
    resolution: resolution.label,
    width: resolution.width,
    height: resolution.height,
    codec: codec.name,
    encoder: codec.encoder,
    targetVideoBitrate: settings.videoBitrate || DEFAULT_VIDEO_MAXRATE,
    audioCodec: "AAC",
    audioBitrate: AUDIO_BITRATE
  };
}

function outputResolution(name) {
  const resolutions = {
    "480p": { label: "480p", width: 854, height: 480 },
    "720p": { label: "720p", width: 1280, height: 720 },
    "1080p": { label: "1080p", width: 1920, height: 1080 }
  };
  return resolutions[String(name || "").toLowerCase()] || resolutions["720p"];
}

function videoCodec(name) {
  const codecs = {
    h264: { name: "H.264", encoder: "libx264" },
    h265: { name: "H.265", encoder: "libx265" }
  };
  return codecs[String(name || "").toLowerCase()] || codecs.h264;
}

function transcodingProfile(name) {
  const profiles = {
    fast: { preset: "veryfast", crf: "25" },
    balanced: { preset: "veryfast", crf: "23" },
    quality: { preset: "faster", crf: "21" }
  };
  return profiles[String(name || "").toLowerCase()] || profiles.balanced;
}

async function waitForPlaylist(playlistPath, stream) {
  const started = Date.now();
  while (Date.now() - started < MAX_PLAYLIST_WAIT_MS) {
    if (stream.status === "error" || stream.status === "exited") {
      throw new Error(
        `FFmpeg failed to start this stream.${stream.stderrTail.length ? ` ${stream.stderrTail.slice(-3).join(" ")}` : ""}`
      );
    }

    try {
      const stat = await fs.stat(playlistPath);
      if (stat.size > 0) return;
    } catch {
      // FFmpeg is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error("Timed out waiting for FFmpeg to create the HLS playlist.");
}

module.exports = {
  StreamManager,
  buildFfmpegArgs,
  outputPlaybackProfile,
  outputResolution,
  videoCodec
};
