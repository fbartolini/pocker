# Pocker

A consolidated dashboard for monitoring Docker containers across multiple servers. Connect to multiple Docker hosts, view all your containers in one place, and track versions across your infrastructure.

![Alt text](screenshot.png?raw=true "screenshot")

## Features

- **Multi-server support** – Connect to multiple Docker hosts (local sockets or remote proxies)
- **Smart grouping** – Containers with the same image are grouped together, even across different servers
- **Version tracking** – See which containers are outdated and need updates
- **Color-coded servers** – Each server has a unique color for easy identification
- **Portainer integration** – Click server chips to open containers directly in Portainer
- **Auto-fetched icons** – Icons and descriptions are automatically discovered from multiple sources
- **Embeddable** – Use `/?embed=1` for iframe integration or consume the JSON API

## Quick Start

**Docker Image:** Available on [Docker Hub](https://hub.docker.com/repository/docker/fbartolini/pocker) as `fbartolini/pocker:latest`

### Using Docker Compose (Recommended)

1. **Create a directory for your configuration:**
```sh
mkdir -p pocker/config
cd pocker
```

2. **Create your configuration files:**
```sh
# Copy the sample config
curl -o config/docker-sources.sample.json https://raw.githubusercontent.com/fbartolini/pocker/main/config/docker-sources.sample.json
cp config/docker-sources.sample.json config/docker-sources.json

# Edit config/docker-sources.json with your Docker sources
# Optionally create config/icon-map.json for custom icons
```

3. **Create docker-compose.yml:**
```yaml
services:
  pocker:
    image: fbartolini/pocker:latest
    container_name: pocker
    restart: unless-stopped
    ports:
      - "4173:4173"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./config:/app/config:ro
    environment:
      - NODE_ENV=production
      - PORT=4173
```

4. **Start the container:**
```sh
docker compose up -d
```

The dashboard will be available at `http://localhost:4173`

**Note:** You can also clone the repository to get the full `docker-compose.yml` and sample files:
```sh
git clone https://github.com/fbartolini/pocker.git
cd pocker
cp env.example .env
cp config/docker-sources.sample.json config/docker-sources.json
# Edit config/docker-sources.json
docker compose up -d
```

### Configuration

Create `config/docker-sources.json` to define your Docker sources:

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

### Using Docker Run

```sh
docker run -d \
  --name pocker \
  --restart unless-stopped \
  -p 4173:4173 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v $(pwd)/config:/app/config:ro \
  -e NODE_ENV=production \
  -e PORT=4173 \
  fbartolini/pocker:latest
```

**Important:** Mount your `config` directory to `/app/config` inside the container. The port defaults to `4173` (set `PORT` env var to change).

### Building from Source

If you prefer to build the image yourself (useful for ARM64/Apple Silicon):

```sh
git clone https://github.com/fbartolini/pocker.git
cd pocker
docker build -t pocker .
docker run --rm -p 4173:4173 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v $(pwd)/config:/app/config:ro \
  pocker
```

**Note:** The Docker Hub image is built for both AMD64 and ARM64. If you encounter an "exec format error", it means the image hasn't been rebuilt with multi-architecture support yet. You can build locally for your architecture, or wait for the next automated build.

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
