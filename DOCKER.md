# Running IPTV Restreamer On Unraid With Docker

This project includes a Docker image that installs FFmpeg, runs the Node app on
port `3000`, and stores writable runtime data outside the container.

## Install Directly From GitHub

The repository publishes a Docker image to GitHub Container Registry:

```text
ghcr.io/cerlendson/iptv-restreamer:latest
```

After the GitHub Actions workflow finishes successfully, install it in Unraid:

1. Open Docker > Add Container.
2. Set Repository to `ghcr.io/cerlendson/iptv-restreamer:latest`.
3. Set Network Type to `bridge`.
4. Add a port mapping from host `3000` to container `3000`.
5. Add a path mapping from `/mnt/user/appdata/iptv-restreamer` to `/config`.
6. Add a path mapping from `/mnt/user/appdata/iptv-restreamer/storage` to `/storage`.
7. Add variables `PUID=99`, `PGID=100`, and `TZ=America/Regina`.
8. Start the container and open `http://<unraid-ip>:3000`.

If the package is private, either make the GitHub package public or run
`docker login ghcr.io` on Unraid with a GitHub personal access token that can
read packages.

## Container Paths

| Container path | Purpose | Recommended Unraid host path |
| --- | --- | --- |
| `/config` | Persistent `settings.json` | `/mnt/user/appdata/iptv-restreamer` |
| `/storage` | Runtime HLS stream output | `/mnt/user/appdata/iptv-restreamer/storage` |

The app also supports these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUID` | `99` | Unraid `nobody` user id |
| `PGID` | `100` | Unraid `users` group id |
| `TZ` | `America/Regina` | Container timezone |
| `PORT` | `3000` | Internal web server port |
| `DATA_DIR` | `/config` | Settings directory |
| `STORAGE_DIR` | `/storage` | Storage directory |
| `HLS_DIR` | `/storage/hls` | HLS segment directory |
| `M3U_SOURCE` | empty | Optional first-run playlist URL/path |
| `XMLTV_SOURCE` | empty | Optional first-run XMLTV URL/path |
| `FFMPEG_PATH` | empty | Optional FFmpeg executable path override |

Leave `FFMPEG_PATH` empty on Unraid unless you intentionally mount a different
FFmpeg binary into the container. The image already includes FFmpeg.

## Build On Unraid

You can also build the image yourself.

Copy this project folder somewhere on the server, then run:

```bash
cd /path/to/iptv
docker build -t ghcr.io/cerlendson/iptv-restreamer:latest .
```

## Run From Unraid Docker UI

1. Open Docker > Add Container.
2. Set Repository to `ghcr.io/cerlendson/iptv-restreamer:latest` for the GitHub
   image, or `iptv-restreamer:latest` if you built it locally.
3. Set Network Type to `bridge`.
4. Add a port mapping from host `3000` to container `3000`.
5. Add a path mapping from `/mnt/user/appdata/iptv-restreamer` to `/config`.
6. Add a path mapping from `/mnt/user/appdata/iptv-restreamer/storage` to `/storage`.
7. Add variables `PUID=99`, `PGID=100`, and `TZ=America/Regina`.
8. Start the container and open `http://<unraid-ip>:3000`.

A starter Unraid template is available at `unraid/iptv-restreamer.xml`. You can
copy it to:

```text
/boot/config/plugins/dockerMan/templates-user/my-iptv-restreamer.xml
```

Then add the container from the Unraid template screen.

## Docker Compose Option

The included `docker-compose.yml` works with the Unraid Compose Manager plugin or
plain Docker Compose.

```bash
cp .env.example .env
docker compose up -d
```

Open:

```text
http://<unraid-ip>:3000
```

To stop it:

```bash
docker compose down
```

## Notes

- The web app saves playlist, EPG, and transcoding settings in `/config/settings.json`.
- If you previously used this on Windows, a saved Windows FFmpeg path is ignored
  automatically when running in Linux, so the container can use its bundled
  `ffmpeg`.
- Local M3U/XMLTV files must be inside a mounted container path, such as
  `/config/playlist.m3u`.
