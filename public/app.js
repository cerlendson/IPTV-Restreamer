const state = {
  groups: [],
  channels: [],
  selectedGroup: "",
  settings: null,
  viewerId: null,
  hls: null,
  heartbeatTimer: null,
  statusTimer: null,
  playbackProfile: null,
  measuredBitrateKbps: null,
  search: "",
  groupSearch: "",
  collapsedGroupCategories: new Set(),
  filterOptions: { groups: [], channels: [] },
  filterGroupSearch: "",
  filterChannelSearch: "",
  feedLinkTimer: null,
  feedLinkRequestId: 0
};

const VIDEO_BITRATE_SUGGESTIONS = {
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

const els = {
  authGate: document.querySelector("#authGate"),
  authForm: document.querySelector("#authForm"),
  authPassword: document.querySelector("#authPassword"),
  authMessage: document.querySelector("#authMessage"),
  statusLine: document.querySelector("#statusLine"),
  groups: document.querySelector("#groups"),
  channels: document.querySelector("#channels"),
  channelTitle: document.querySelector("#channelTitle"),
  groupSearchInput: document.querySelector("#groupSearchInput"),
  searchInput: document.querySelector("#searchInput"),
  filterGroupSearchInput: document.querySelector("#filterGroupSearchInput"),
  filterChannelSearchInput: document.querySelector("#filterChannelSearchInput"),
  filterGroups: document.querySelector("#filterGroups"),
  filterChannels: document.querySelector("#filterChannels"),
  selectAllGroupFiltersButton: document.querySelector("#selectAllGroupFiltersButton"),
  selectAllChannelFiltersButton: document.querySelector("#selectAllChannelFiltersButton"),
  clearGroupFiltersButton: document.querySelector("#clearGroupFiltersButton"),
  clearChannelFiltersButton: document.querySelector("#clearChannelFiltersButton"),
  feedPasswordInput: document.querySelector("#feedPasswordInput"),
  m3uLinkInput: document.querySelector("#m3uLinkInput"),
  xmltvLinkInput: document.querySelector("#xmltvLinkInput"),
  feedLinksMessage: document.querySelector("#feedLinksMessage"),
  refreshButton: document.querySelector("#refreshButton"),
  adminRefreshButton: document.querySelector("#adminRefreshButton"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsMessage: document.querySelector("#settingsMessage"),
  activeStreams: document.querySelector("#activeStreams"),
  video: document.querySelector("#video"),
  nowPlaying: document.querySelector("#nowPlaying"),
  programLine: document.querySelector("#programLine"),
  streamDetails: document.querySelector("#streamDetails"),
  viewerBadge: document.querySelector("#viewerBadge"),
  stopButton: document.querySelector("#stopButton"),
  toast: document.querySelector("#toast")
};

els.authForm.addEventListener("submit", login);
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

els.refreshButton.addEventListener("click", refreshCatalog);
els.adminRefreshButton.addEventListener("click", refreshCatalog);
els.stopButton.addEventListener("click", stopPlayback);
els.video.addEventListener("loadedmetadata", renderPlaybackDetails);
els.video.addEventListener("resize", renderPlaybackDetails);
els.searchInput.addEventListener("input", () => {
  state.search = els.searchInput.value.trim().toLowerCase();
  renderChannels();
});
els.groupSearchInput.addEventListener("input", () => {
  state.groupSearch = els.groupSearchInput.value.trim().toLowerCase();
  renderGroups();
});
els.filterGroupSearchInput.addEventListener("input", () => {
  state.filterGroupSearch = els.filterGroupSearchInput.value.trim().toLowerCase();
  renderFilterGroups();
});
els.filterChannelSearchInput.addEventListener("input", () => {
  state.filterChannelSearch = els.filterChannelSearchInput.value.trim().toLowerCase();
  renderFilterChannels();
});
els.selectAllGroupFiltersButton.addEventListener("click", () => {
  state.settings.excludedGroups = state.filterOptions.groups.slice();
  markFiltersChanged();
  renderFilterGroups();
});
els.selectAllChannelFiltersButton.addEventListener("click", () => {
  state.settings.excludedChannels = state.filterOptions.channels.map((channel) => channel.id);
  markFiltersChanged();
  renderFilterChannels();
});
els.clearGroupFiltersButton.addEventListener("click", () => {
  state.settings.excludedGroups = [];
  markFiltersChanged();
  renderFilterGroups();
});
els.clearChannelFiltersButton.addEventListener("click", () => {
  state.settings.excludedChannels = [];
  markFiltersChanged();
  renderFilterChannels();
});
els.feedPasswordInput.addEventListener("input", scheduleFeedLinkRender);
els.settingsForm.addEventListener("submit", saveSettings);
els.settingsForm.elements.outputResolution.addEventListener("change", applySuggestedVideoBitrate);
els.settingsForm.elements.videoCodec.addEventListener("change", applySuggestedVideoBitrate);
window.addEventListener("beforeunload", releaseViewer);

if (await checkAuth()) {
  await boot();
}

async function checkAuth() {
  const status = await fetchJson("/api/auth/status");
  if (status.passwordRequired && !status.authenticated) {
    lockForPassword("");
    return false;
  }

  unlockApp();
  return true;
}

async function login(event) {
  event.preventDefault();
  els.authMessage.textContent = "";

  try {
    await fetchJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: els.authPassword.value })
    });
    els.authPassword.value = "";
    unlockApp();
    await boot();
  } catch (error) {
    els.authMessage.textContent = error.message;
    els.authPassword.select();
  }
}

function lockForPassword(message) {
  document.body.classList.remove("auth-checking");
  document.body.classList.add("auth-locked");
  els.authGate.hidden = false;
  els.authMessage.textContent = message;
  els.authPassword.focus();
}

function unlockApp() {
  document.body.classList.remove("auth-checking", "auth-locked");
  els.authGate.hidden = true;
  els.authMessage.textContent = "";
}

async function boot() {
  await Promise.all([loadSettings(), loadStatus()]);
  await loadGroups();
  await loadFilterOptions();
  if (state.statusTimer) clearInterval(state.statusTimer);
  state.statusTimer = setInterval(() => loadStatus().catch(() => {}), 10000);
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  state.settings.excludedGroups = Array.isArray(state.settings.excludedGroups)
    ? state.settings.excludedGroups
    : [];
  state.settings.excludedChannels = Array.isArray(state.settings.excludedChannels)
    ? state.settings.excludedChannels
    : [];
  for (const [key, value] of Object.entries(state.settings)) {
    const input = els.settingsForm.elements[key];
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value;
  }
  updateVideoBitrateHint();
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(els.settingsForm);
  const payload = {
    m3uSource: form.get("m3uSource"),
    xmltvSource: form.get("xmltvSource"),
    maxUpstreamConnections: Number(form.get("maxUpstreamConnections")),
    ffmpegPath: form.get("ffmpegPath"),
    defaultTranscodingProfile: form.get("defaultTranscodingProfile"),
    outputResolution: form.get("outputResolution"),
    videoCodec: form.get("videoCodec"),
    videoBitrate: form.get("videoBitrate"),
    enableHardwareAcceleration: form.has("enableHardwareAcceleration"),
    streamIdleTimeoutSeconds: Number(form.get("streamIdleTimeoutSeconds")),
    hlsSegmentDurationSeconds: Number(form.get("hlsSegmentDurationSeconds")),
    outputBufferSize: form.get("outputBufferSize"),
    websitePassword: form.get("websitePassword"),
    excludedGroups: state.settings.excludedGroups,
    excludedChannels: state.settings.excludedChannels
  };

  const result = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  state.settings = result.settings || result;
  state.settings.excludedGroups = Array.isArray(state.settings.excludedGroups)
    ? state.settings.excludedGroups
    : [];
  state.settings.excludedChannels = Array.isArray(state.settings.excludedChannels)
    ? state.settings.excludedChannels
    : [];
  els.settingsForm.elements.websitePassword.value = "";
  renderFeedLinks();
  renderFilterOptions();
  await loadGroups();
  await loadStatus();

  if (result.streamsRestarted) {
    clearViewerSession();
    resetPlayer();
    els.settingsMessage.textContent = "Settings saved. Active streams were restarted.";
    showToast("Settings saved. Restarted active streams.");
  } else {
    els.settingsMessage.textContent = "Settings saved.";
    showToast("Settings saved.");
  }
}

async function loadStatus() {
  const status = await api("/api/status");
  const stats = status.stats;
  els.statusLine.textContent = `${status.importState.status}: ${status.importState.message || "Waiting"} | ${stats.channelCount} channels | ${status.activeStreams.length}/${status.maxUpstreamConnections} upstream connections`;
  renderActiveStreams(status.activeStreams);
}

async function loadGroups() {
  state.groups = await api("/api/groups");
  state.selectedGroup = state.groups[0] || "";
  state.collapsedGroupCategories = new Set(
    groupCategories(state.groups)
      .filter((category) => !category.groups.includes(state.selectedGroup))
      .map((category) => category.name)
  );
  renderGroups();
  await loadChannels();
}

async function loadChannels() {
  const query = state.selectedGroup ? `?group=${encodeURIComponent(state.selectedGroup)}` : "";
  state.channels = await api(`/api/channels${query}`);
  renderChannels();
}

async function loadFilterOptions() {
  state.filterOptions = await api("/api/filter-options");
  renderFilterOptions();
}

async function refreshCatalog() {
  showToast("Refreshing IPTV data...");
  const result = await api("/api/refresh", { method: "POST" });
  showToast(result.importState.message || "Refresh complete.");
  await loadGroups();
  await loadFilterOptions();
  await loadStatus();
}

function renderGroups() {
  els.groups.innerHTML = "";

  if (!state.groups.length) {
    els.groups.innerHTML = `<p class="message">No groups imported yet.</p>`;
    return;
  }

  const visibleGroups = state.groups.filter((group) =>
    group.toLowerCase().includes(state.groupSearch)
  );

  if (!visibleGroups.length) {
    els.groups.innerHTML = `<p class="message">No groups found.</p>`;
    return;
  }

  for (const category of groupCategories(visibleGroups)) {
    const details = document.createElement("details");
    details.className = "group-category";
    details.open =
      Boolean(state.groupSearch) ||
      category.groups.includes(state.selectedGroup) ||
      !state.collapsedGroupCategories.has(category.name);

    const summary = document.createElement("summary");
    const title = document.createElement("span");
    const count = document.createElement("span");
    title.textContent = category.name;
    count.className = "group-count";
    count.textContent = String(category.groups.length);
    summary.append(title, count);
    details.append(summary);

    const categoryList = document.createElement("div");
    categoryList.className = "group-category-list";

    for (const group of category.groups) {
      const button = document.createElement("button");
      button.className = `group-button${group === state.selectedGroup ? " active" : ""}`;
      button.type = "button";
      button.textContent = group;
      button.addEventListener("click", async () => {
        state.selectedGroup = group;
        state.collapsedGroupCategories.delete(category.name);
        renderGroups();
        await loadChannels();
      });
      categoryList.append(button);
    }

    details.addEventListener("toggle", () => {
      if (state.groupSearch) return;
      if (details.open) state.collapsedGroupCategories.delete(category.name);
      else state.collapsedGroupCategories.add(category.name);
    });

    details.append(categoryList);
    els.groups.append(details);
  }
}

function groupCategories(groups) {
  const categories = new Map();

  for (const group of groups) {
    const category = groupCategory(group);
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(group);
  }

  return Array.from(categories, ([name, categoryGroups]) => ({
    name,
    groups: categoryGroups
  }));
}

function groupCategory(group) {
  if (/^24\/7\b/i.test(group)) return "24/7";

  const [prefix] = group.split("|");
  const category = prefix.trim();
  return category && category !== group ? category : "Other";
}

function renderChannels() {
  const visible = state.channels.filter((channel) =>
    channel.name.toLowerCase().includes(state.search)
  );
  els.channelTitle.textContent = state.selectedGroup || "Channels";
  els.channels.innerHTML = "";

  if (!visible.length) {
    els.channels.innerHTML = `<p class="message">No channels found.</p>`;
    return;
  }

  for (const channel of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "channel-card";
    button.addEventListener("click", () => playChannel(channel));

    const logo = channel.logo
      ? `<img class="logo" src="${escapeAttr(channel.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : `<div class="logo-placeholder">${escapeHtml(initials(channel.name))}</div>`;
    const current = channel.schedule?.current?.title || "No current program";
    const next = channel.schedule?.next?.title ? `Next: ${channel.schedule.next.title}` : "";

    button.innerHTML = `
      ${logo}
      <div>
        <h3>${escapeHtml(channel.name)}</h3>
        <p>${escapeHtml(current)}</p>
        <p>${escapeHtml(next)}</p>
      </div>
    `;

    els.channels.append(button);
  }
}

function renderFilterOptions() {
  renderFilterGroups();
  renderFilterChannels();
}

function renderFilterGroups() {
  const excludedGroups = new Set(state.settings?.excludedGroups || []);
  const groups = state.filterOptions.groups.filter((group) =>
    group.toLowerCase().includes(state.filterGroupSearch)
  );

  els.filterGroups.innerHTML = "";
  if (!groups.length) {
    els.filterGroups.innerHTML = `<p class="message">No groups found.</p>`;
    return;
  }

  for (const group of groups) {
    const label = document.createElement("label");
    label.className = "filter-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = excludedGroups.has(group);
    checkbox.addEventListener("change", () => {
      updateExcludedList("excludedGroups", group, checkbox.checked);
    });

    const name = document.createElement("span");
    name.textContent = group;

    label.append(checkbox, name);
    els.filterGroups.append(label);
  }
}

function renderFilterChannels() {
  const excludedChannels = new Set(state.settings?.excludedChannels || []);
  const channels = state.filterOptions.channels.filter((channel) =>
    `${channel.name} ${channel.group}`.toLowerCase().includes(state.filterChannelSearch)
  );

  els.filterChannels.innerHTML = "";
  if (!channels.length) {
    els.filterChannels.innerHTML = `<p class="message">No channels found.</p>`;
    return;
  }

  for (const channel of channels) {
    const label = document.createElement("label");
    label.className = "filter-option channel-filter-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = excludedChannels.has(channel.id);
    checkbox.addEventListener("change", () => {
      updateExcludedList("excludedChannels", channel.id, checkbox.checked);
    });

    const text = document.createElement("span");
    const name = document.createElement("strong");
    const group = document.createElement("small");
    name.textContent = channel.name;
    group.textContent = channel.group || "Ungrouped";
    text.append(name, group);

    label.append(checkbox, text);
    els.filterChannels.append(label);
  }
}

function updateExcludedList(key, value, excluded) {
  const entries = new Set(state.settings?.[key] || []);
  if (excluded) entries.add(value);
  else entries.delete(value);
  state.settings[key] = Array.from(entries);
  markFiltersChanged();
}

function markFiltersChanged() {
  els.settingsMessage.textContent = "Save settings to apply content filters.";
}

function renderFeedLinks() {
  scheduleFeedLinkRender();
}

function scheduleFeedLinkRender() {
  if (state.feedLinkTimer) clearTimeout(state.feedLinkTimer);
  state.feedLinkTimer = setTimeout(generateFeedLinks, 250);
}

async function generateFeedLinks() {
  const password = els.feedPasswordInput.value;
  const requestId = ++state.feedLinkRequestId;

  if (!password) {
    els.m3uLinkInput.value = "";
    els.xmltvLinkInput.value = "";
    els.feedLinksMessage.textContent = "";
    return;
  }

  els.feedLinksMessage.textContent = "Checking password...";

  try {
    const links = await fetchJson("/api/feed-links", {
      method: "POST",
      body: JSON.stringify({ password })
    });
    if (requestId !== state.feedLinkRequestId) return;
    els.m3uLinkInput.value = links.m3uUrl;
    els.xmltvLinkInput.value = links.xmltvUrl;
    els.feedLinksMessage.textContent = "Links ready.";
  } catch (error) {
    if (requestId !== state.feedLinkRequestId) return;
    els.m3uLinkInput.value = "";
    els.xmltvLinkInput.value = "";
    els.feedLinksMessage.textContent = error.message;
  }
}

async function playChannel(channel) {
  await releaseViewer();

  try {
    const stream = await api(`/api/streams/${encodeURIComponent(channel.id)}/start`, {
      method: "POST"
    });
    state.viewerId = stream.viewerId;
    state.playbackProfile = stream.playbackProfile || playbackProfileFromSettings(state.settings);
    state.measuredBitrateKbps = null;
    attachVideo(stream.playlistUrl);
    startHeartbeat();
    els.nowPlaying.textContent = channel.name;
    els.programLine.textContent = formatProgramLine(channel.schedule);
    els.viewerBadge.textContent = `${stream.viewerCount} viewer${stream.viewerCount === 1 ? "" : "s"} | ${stream.activeUpstreamConnections} active upstream`;
    els.stopButton.disabled = false;
    renderPlaybackDetails();
    showToast(stream.reused ? "Joined existing restream." : "Started shared restream.");
    await loadStatus();
  } catch (error) {
    showToast(error.message);
  }
}

function attachVideo(url) {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }

  if (window.Hls && window.Hls.isSupported()) {
    state.hls = new window.Hls({
      liveSyncDurationCount: 3
    });
    state.hls.on(window.Hls.Events.FRAG_LOADED, (event, data) => {
      updateMeasuredBitrate(data);
    });
    state.hls.loadSource(url);
    state.hls.attachMedia(els.video);
  } else if (els.video.canPlayType("application/vnd.apple.mpegurl")) {
    els.video.src = url;
  } else {
    showToast("This browser cannot play HLS streams.");
  }

  els.video.play().catch(() => {
    showToast("Playback is ready. Press play to start.");
  });
}

async function stopPlayback() {
  await releaseViewer();
  resetPlayer();
  showToast("Playback stopped.");
  await loadStatus();
}

function resetPlayer() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }

  els.video.pause();
  els.video.removeAttribute("src");
  els.video.load();
  state.playbackProfile = null;
  state.measuredBitrateKbps = null;
  els.nowPlaying.textContent = "Select a channel";
  els.programLine.textContent = "Current and next program details will appear here.";
  els.viewerBadge.textContent = "No stream";
  els.stopButton.disabled = true;
  renderPlaybackDetails();
}

function updateMeasuredBitrate(data) {
  const bytes = data?.stats?.loaded || data?.stats?.total;
  const durationSeconds = data?.frag?.duration;
  if (!bytes || !durationSeconds) return;

  state.measuredBitrateKbps = Math.round((bytes * 8) / durationSeconds / 1000);
  renderPlaybackDetails();
}

function renderPlaybackDetails() {
  if (!state.playbackProfile) {
    els.streamDetails.textContent = "Output stream details will appear during playback.";
    return;
  }

  const profile = state.playbackProfile;
  const renderedResolution =
    els.video.videoWidth && els.video.videoHeight
      ? `${els.video.videoWidth}x${els.video.videoHeight}`
      : `${profile.width}x${profile.height}`;
  const bitrate = state.measuredBitrateKbps
    ? `${formatBitrate(state.measuredBitrateKbps)} observed`
    : `${profile.targetVideoBitrate} target video`;

  els.streamDetails.textContent = `${profile.codec} output | ${renderedResolution} rendered | ${bitrate}`;
}

function playbackProfileFromSettings(settings = {}) {
  const resolution = outputResolution(settings.outputResolution);
  const codec = videoCodec(settings.videoCodec);

  return {
    resolution: resolution.label,
    width: resolution.width,
    height: resolution.height,
    codec,
    targetVideoBitrate:
      settings.videoBitrate || suggestedVideoBitrate(settings.outputResolution, settings.videoCodec)
  };
}

function applySuggestedVideoBitrate() {
  const bitrateInput = els.settingsForm.elements.videoBitrate;
  bitrateInput.value = suggestedVideoBitrate(
    els.settingsForm.elements.outputResolution.value,
    els.settingsForm.elements.videoCodec.value
  );
  updateVideoBitrateHint();
}

function updateVideoBitrateHint() {
  const resolution = els.settingsForm.elements.outputResolution.value;
  const codec = els.settingsForm.elements.videoCodec.value;
  const suggested = suggestedVideoBitrate(resolution, codec);
  const bitrateInput = els.settingsForm.elements.videoBitrate;

  bitrateInput.placeholder = suggested;
  bitrateInput.title = `Suggested ${videoCodec(codec)} ${resolution} bitrate: ${suggested}`;
}

function suggestedVideoBitrate(resolution = "720p", codec = "h264") {
  const normalizedCodec = String(codec || "h264").toLowerCase();
  const normalizedResolution = String(resolution || "720p").toLowerCase();
  return (
    VIDEO_BITRATE_SUGGESTIONS[normalizedCodec]?.[normalizedResolution] ||
    VIDEO_BITRATE_SUGGESTIONS.h264["720p"]
  );
}

function outputResolution(value) {
  const resolutions = {
    "480p": { label: "480p", width: 854, height: 480 },
    "720p": { label: "720p", width: 1280, height: 720 },
    "1080p": { label: "1080p", width: 1920, height: 1080 }
  };
  return resolutions[String(value || "").toLowerCase()] || resolutions["720p"];
}

function videoCodec(value) {
  const codecs = {
    h264: "H.264",
    h265: "H.265"
  };
  return codecs[String(value || "").toLowerCase()] || codecs.h264;
}

function startHeartbeat() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (state.viewerId) {
      api(`/api/viewers/${encodeURIComponent(state.viewerId)}/heartbeat`, {
        method: "POST"
      }).catch(() => {});
    }
  }, 15000);
}

function clearViewerSession() {
  state.viewerId = null;
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

async function releaseViewer() {
  if (!state.viewerId) return;
  const viewerId = state.viewerId;
  state.viewerId = null;

  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  navigator.sendBeacon?.(`/api/viewers/${encodeURIComponent(viewerId)}/release`);
  await fetch(`/api/viewers/${encodeURIComponent(viewerId)}/release`, {
    method: "POST",
    keepalive: true
  }).catch(() => {});
}

function renderActiveStreams(streams) {
  if (!streams.length) {
    els.activeStreams.innerHTML = `<p class="message">No active upstream streams.</p>`;
    return;
  }

  els.activeStreams.innerHTML = streams
    .map(
      (stream) => `
        <div class="stream-row">
          <strong>${escapeHtml(stream.channelName)}</strong>
          <span>${stream.viewerCount} viewer${stream.viewerCount === 1 ? "" : "s"} | ${escapeHtml(stream.status)}</span>
          <span>Started ${formatTime(stream.startedAt)}</span>
        </div>
      `
    )
    .join("");
}

function switchView(view) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
  document.querySelector("#watchView").classList.toggle("active", view === "watch");
  document.querySelector("#adminView").classList.toggle("active", view === "admin");
  if (view === "admin") loadStatus().catch(() => {});
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearViewerSession();
      resetPlayer();
      lockForPassword(body.error || "Enter the website password to continue.");
    }
    throw new Error(body.error || response.statusText);
  }

  return body;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    throw new Error(body.error || response.statusText);
  }

  return body;
}

function formatProgramLine(schedule) {
  const current = schedule?.current?.title || "No current program";
  const next = schedule?.next?.title || "No upcoming program";
  return `Now: ${current} | Next: ${next}`;
}

function formatTime(value) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBitrate(kbps) {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 3500);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
