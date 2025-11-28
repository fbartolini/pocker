# Pocker

A consolidated dashboard for monitoring Docker containers across multiple servers. Connect to multiple Docker hosts, view all your containers in one place, and track versions across your infrastructure.

## Features

- **Multi-server support** – Connect to multiple Docker hosts (local sockets or remote proxies)
- **Smart grouping** – Containers with the same image are grouped together, even across different servers
- **Version tracking** – See which containers are outdated and need updates
- **Color-coded servers** – Each server has a unique color for easy identification
- **Portainer integration** – Click server chips to open containers directly in Portainer
- **Auto-fetched icons** – Icons and descriptions are automatically discovered from multiple sources
- **Embeddable** – Use `/?embed=1` for iframe integration or consume the JSON API

## Quick Start

### Using Docker Compose (Recommended)

```sh
git clone <repo>
cd pocker
cp env.example .env
mkdir -p config
cp config/docker-sources.sample.json config/docker-sources.json
# Edit config/docker-sources.json with your Docker sources
docker compose up -d --build
```

The dashboard will be available at `http://localhost:4173`

### Configuration

Create `config/docker-sources.json` to define your Docker sources:

```json

```json
[
  {
    "name": "core",
    "socket": "unix:///var/run/docker.sock",
    "label": "Home Lab",
    "color": "#4f80ff"
  },
  {
    "name": "media",
    "endpoint": "http://192.168.50.101:2375",
    "label": "Media Server",
    "ui": "https://192.168.50.101:9443/#!/3/docker/dashboard"
  },
  {
    "name": "edge",
    "endpoint": "http://edge-proxy:2375",
    "label": "Edge Server",
    "ui": "http://edge.home.arpa",
    "user": "proxy",
    "password": "secret"
  }
]
```

**Configuration options:**

- `name` - Unique identifier (required)
- `label` - Friendly name shown in UI (defaults to `name`)
- `endpoint` - Remote Docker API URL (e.g., `http://proxy:2375`)
- `socket` - Local socket path (e.g., `unix:///var/run/docker.sock`)
- `ui` - Base URL for Portainer or other UI (enables direct container links)
- `color` - Hex color for server chip border (auto-assigned if not specified)
- `user` / `password` - Basic auth credentials
- `ca` / `cert` / `key` - TLS certificate paths

**Default behavior:** If no config file exists, the app automatically connects to `/var/run/docker.sock` (local Docker). Set `DOCKER_SOCKET_DISABLE=true` to disable this.

### Environment Variables

Key environment variables (see `env.example` for all options):

- `DOCKER_SOURCES_FILE` - Path to config file (default: `./config/docker-sources.json`)
- `DOCKER_SOCKET_DISABLE` - Set to `true` to disable default local socket
- `PUBLIC_MAX_WIDTH` - Limit dashboard width (e.g., `1400px`)
- `SHOW_COMPOSE_TAGS` - Set to `true` to show compose project tags
- `METADATA_DEBUG` - Set to `true` for verbose icon/description logging

### API & Embedding

- `GET /api/apps` - Returns JSON with all apps, containers, and metadata
- `GET /?embed=1` - Simplified UI for iframe embedding (hides filters/toolbar)

Perfect for integrating into dashboards like Homepage or Homarr.

### Manual Docker Run

```sh
docker build -t pocker .
docker run --rm -p 4173:4173 --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v $(pwd)/config:/app/config:ro \
  pocker
```

**Important:** Mount your `config` directory to `/app/config` inside the container. The port defaults to `4173` (set `PORT` env var to change).

### Custom Icons

Icons are automatically fetched from multiple sources. To override specific icons, create `config/icon-map.json`:

```json
{
  "nginx": "https://example.com/nginx-icon.svg",
  "postgres": "https://example.com/postgres-icon.svg"
}
```

See `config/icon-map.sample.json` for examples.

### Security Notes

- All Docker API calls happen server-side (never exposed to the browser)
- Use read-only socket mounts (`:ro` flag)
- For remote hosts, use docker-socket-proxy with proper ACLs
- Enable TLS and authentication for remote endpoints

---

Happy self-hosting! 🐳
