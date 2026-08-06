const crypto = require("crypto");
const fs = require("fs/promises");
const { XMLParser } = require("fast-xml-parser");

function createEmptyCatalog() {
  return {
    importedAt: null,
    channels: [],
    groups: [],
    epgByChannelId: {},
    stats: {
      channelCount: 0,
      groupCount: 0,
      programmeCount: 0,
      errors: []
    }
  };
}

async function importCatalog(settings) {
  const errors = [];
  const [m3uResult, xmltvResult] = await Promise.allSettled([
    readSource(settings.m3uSource),
    readSource(settings.xmltvSource)
  ]);

  if (m3uResult.status === "rejected") {
    throw new Error(`Unable to load M3U source: ${m3uResult.reason.message}`);
  }

  if (xmltvResult.status === "rejected") {
    errors.push(`Unable to load XMLTV source: ${xmltvResult.reason.message}`);
  }

  const channels = parseM3U(m3uResult.value);
  const epg = xmltvResult.status === "fulfilled" ? parseXmltv(xmltvResult.value) : emptyEpg();
  const epgByChannelId = {};

  for (const channel of channels) {
    const epgRef = matchEpgReference(channel, epg);
    channel.epgRef = epgRef;
    epgByChannelId[channel.id] = epg.programmesByReference.get(epgRef) || [];
  }

  const groups = Array.from(
    new Set(
      channels
        .map((channel) => channel.group || guessGroupFromEpg(channel, epg) || "Ungrouped")
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  return {
    importedAt: new Date().toISOString(),
    channels,
    groups,
    epgByChannelId,
    stats: {
      channelCount: channels.length,
      groupCount: groups.length,
      programmeCount: epg.programmeCount,
      errors
    }
  };
}

async function readSource(source) {
  if (!source) throw new Error("source is empty");

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  return fs.readFile(source, "utf8");
}

function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      pending = parseExtinf(line);
      continue;
    }

    if (!line.startsWith("#") && pending) {
      const streamUrl = line;
      const tvgId = pending.attrs["tvg-id"] || "";
      const name = pending.name || pending.attrs["tvg-name"] || "Unnamed Channel";
      channels.push({
        id: stableChannelId(tvgId || name, streamUrl),
        name,
        group: pending.attrs["group-title"] || "Ungrouped",
        logo: pending.attrs["tvg-logo"] || "",
        tvgId,
        streamUrl,
        epgRef: ""
      });
      pending = null;
    }
  }

  return dedupeChannels(channels);
}

function parseExtinf(line) {
  const attrs = {};
  const attrRegex = /([\w-]+)="([^"]*)"/g;
  let match;

  while ((match = attrRegex.exec(line))) {
    attrs[match[1]] = decodeHtml(match[2].trim());
  }

  const commaIndex = line.lastIndexOf(",");
  const name = commaIndex >= 0 ? decodeHtml(line.slice(commaIndex + 1).trim()) : "";

  return { attrs, name };
}

function parseXmltv(content) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    trimValues: true
  });
  const doc = parser.parse(content);
  const tv = doc.tv || {};
  const channels = asArray(tv.channel);
  const programmes = asArray(tv.programme);
  const referencesById = new Map();
  const referencesByName = new Map();
  const programmesByReference = new Map();

  for (const channel of channels) {
    const id = String(channel["@_id"] || "").trim();
    const names = asArray(channel["display-name"]).map(xmlText).filter(Boolean);
    if (id) referencesById.set(normalKey(id), id);
    for (const name of names) {
      referencesByName.set(normalKey(name), id || name);
    }
  }

  for (const programme of programmes) {
    const channelRef = String(programme["@_channel"] || "").trim();
    if (!channelRef) continue;

    if (!programmesByReference.has(channelRef)) {
      programmesByReference.set(channelRef, []);
    }

    programmesByReference.get(channelRef).push({
      title: xmlText(programme.title) || "Untitled",
      subTitle: xmlText(programme["sub-title"]) || "",
      description: xmlText(programme.desc) || "",
      start: parseXmltvDate(programme["@_start"]),
      stop: parseXmltvDate(programme["@_stop"])
    });
  }

  for (const entries of programmesByReference.values()) {
    entries.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  }

  return {
    referencesById,
    referencesByName,
    programmesByReference,
    programmeCount: programmes.length
  };
}

function emptyEpg() {
  return {
    referencesById: new Map(),
    referencesByName: new Map(),
    programmesByReference: new Map(),
    programmeCount: 0
  };
}

function matchEpgReference(channel, epg) {
  if (channel.tvgId) {
    const byId = epg.referencesById.get(normalKey(channel.tvgId));
    if (byId) return byId;
  }

  const byName = epg.referencesByName.get(normalKey(channel.name));
  if (byName) return byName;

  return channel.tvgId || channel.name;
}

function guessGroupFromEpg() {
  return "";
}

function getSchedule(catalog, channelId) {
  const entries = catalog.epgByChannelId[channelId] || [];
  const now = Date.now();
  const current =
    entries.find((entry) => timestamp(entry.start) <= now && now < timestamp(entry.stop)) || null;
  const next =
    entries.find((entry) => timestamp(entry.start) > now) ||
    entries.find((entry) => current && timestamp(entry.start) > timestamp(current.start)) ||
    null;

  return { current, next };
}

function stableChannelId(key, streamUrl) {
  const hash = crypto.createHash("sha1").update(`${key}|${streamUrl}`).digest("hex").slice(0, 12);
  return `ch_${hash}`;
}

function dedupeChannels(channels) {
  const seen = new Map();
  const result = [];

  for (const channel of channels) {
    if (seen.has(channel.id)) continue;
    seen.set(channel.id, true);
    result.push(channel);
  }

  return result;
}

function normalKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function xmlText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return xmlText(value[0]);
  if (typeof value === "object") return String(value["#text"] || "");
  return "";
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseXmltvDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, offset] = match;
  const isoBase = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (!offset) return `${isoBase}Z`;
  return `${isoBase}${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function timestamp(value) {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

module.exports = {
  createEmptyCatalog,
  importCatalog,
  getSchedule
};
