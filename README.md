# IPTV Restreamer

A self-hosted IPTV web app that imports an M3U playlist and XMLTV EPG, lets users browse channels by group, and watches channels through a centralized FFmpeg restreamer.

The stream manager keeps one upstream FFmpeg process per active channel, so many viewers on the same channel share the same provider connection.

## Quick Start

```powershell
npm install
npm start
```

Open `http://localhost:3000`.

FFmpeg must be installed and available on `PATH`, or set its executable path on the admin settings page.

## Docker And Unraid

This project publishes a Docker image to GitHub Container Registry:
`ghcr.io/cerlendson/iptv-restreamer:latest`.

For Unraid, set the repository to that image, map
`/mnt/user/appdata/iptv-restreamer` to `/config`, map
`/mnt/user/appdata/iptv-restreamer/storage` to `/storage`, and publish host port
`3000` to container port `3000`.

See [DOCKER.md](DOCKER.md) for the full Unraid setup.

## Features

- Persisted JSON settings in `data/settings.json`
- M3U playlist import from URL or local file
- XMLTV import from URL or local file
- EPG matching by `tvg-id`, with channel-name fallback
- Channel group browsing
- Current and next program display
- HTML5 playback with HLS.js
- Shared restreaming per channel
- Configurable maximum active upstream connections
- Viewer heartbeat/release logic
- Idle cleanup of FFmpeg and temporary HLS files
