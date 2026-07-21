# Echovale

Echovale is a quiet, keyboard-first RSS reader designed to be self-hosted.

## Screenshots

| Reader | Subscription health |
| :---: | :---: |
| [![Echovale magazine view populated with public demo feeds](docs/screenshots/reader-desktop.jpg)](docs/screenshots/reader-desktop.jpg) | [![Healthy YouTube, Telegram, Nitter, and RSS subscriptions in Echovale](docs/screenshots/feed-sources-desktop.jpg)](docs/screenshots/feed-sources-desktop.jpg) |
| **YouTube article** | **Nitter / X article** |
| [![A 3Blue1Brown YouTube video open in Echovale](docs/screenshots/article-youtube.jpg)](docs/screenshots/article-youtube.jpg) | [![An Andrej Karpathy post from Nitter open in Echovale](docs/screenshots/article-nitter.jpg)](docs/screenshots/article-nitter.jpg) |

## Features

- Keyboard navigation for the complete reading loop.
- Rules that keep wanted articles, hide noise, or mark matches as read.
- Full-text extraction with feed content as a visible fallback.
- One-click AI article summaries and translations through Google Gemini, OpenAI, or Anthropic.
- Per-feed last attempt, last success, HTTP status, and error details.
- Installable Progressive Web App with standalone windows, home-screen shortcuts, and an offline app shell.
- Import and export OPML, including feed folders.
- Choose newest-first or oldest-first reading order for each folder or feed. Configured sorting per folder or feed persists in the aggregated view without affecting other feeds.

## Deploy with Docker Compose

The included deployment runs one Node.js 24.18.0 process and stores SQLite data in a named volume. Do not scale the service to multiple replicas: polling and SQLite ownership are intentionally kept in one process.

Requirements:

- Docker Engine with Docker Compose v2.

Build and start Echovale:

```sh
docker compose up -d --build
```

Open `http://127.0.0.1:3000/echovale/` and choose **Create an account**. Registration signs the new account in immediately, and passwords are hashed before they are stored in SQLite. To add another account, sign out and register again.

When an existing single-account database is upgraded, its feeds, folders, rules, settings, and article state belong to the first account registered after the upgrade. Later accounts start with an empty reading queue.

Check container and database readiness:

```sh
docker compose ps
```

```sh
curl --fail http://127.0.0.1:3000/health
```

The health endpoint returns HTTP 200 only when the server can query SQLite. Application data is stored in the `echovale-data` volume at `/data/echovale.db`.

Follow logs:

```sh
docker compose logs -f --tail=200 echovale
```

Stop the application without deleting its data:

```sh
docker compose down
```

Never add `--volumes` to that command unless the SQLite database should be permanently deleted.

## Network exposure and HTTPS

Echovale has password authentication, but registration remains available to anyone who can reach the sign-in screen. Compose binds the service to host loopback by default. For access from another device, place Echovale behind a trusted private network or a reverse proxy with HTTPS and its own access controls.

For example, a host connected to Tailscale can publish the loopback service to its tailnet:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

The command prints the private `https://<device>.<tailnet>.ts.net` address. Inspect the active configuration with:

```sh
tailscale serve status
```

HTTPS is important because browsers only allow features such as copy-to-clipboard in a secure context. Tailscale Serve terminates HTTPS with an automatically provisioned certificate and persists a `--bg` configuration across restarts. See the official [Tailscale Serve command documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

Disable the proxy with:

```sh
sudo tailscale serve --https=443 off
```

Do not expose Echovale through Tailscale Funnel or an unrestricted public proxy unless open registration is intentional.

## Configuration

Compose accepts these values from a project-level `.env` file or the shell:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ECHOVALE_BIND_ADDRESS` | `127.0.0.1` | Host address that publishes the container port. Keep loopback when using a local reverse proxy. |
| `ECHOVALE_PORT` | `3000` | Host port forwarded to Echovale. |
| `POLL_INTERVAL_MINUTES` | `20` | Initial background polling interval for a new database. |
| `FEED_FETCH_TIMEOUT_MS` | `15000` | Feed request timeout in milliseconds. |
| `ARTICLE_FETCH_TIMEOUT_MS` | `20000` | Full-text article request timeout in milliseconds. |
| `AI_CREDENTIALS_KEY` | none | A persistent 64-character hexadecimal key used to encrypt provider API keys. AI setup is disabled until this is set. |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | AI provider request timeout in milliseconds. |

The container fixes its internal runtime settings to `HOST=0.0.0.0`, `PORT=3000`, and `DATABASE_PATH=/data/echovale.db`. For a non-container run, all server settings are listed in `.env.example`.

After changing container configuration, recreate the service:

```sh
docker compose up -d
```

Background polling runs in the server and continues when no browser is open. The initial interval comes from `POLL_INTERVAL_MINUTES`; later changes made in **Settings** are stored in SQLite and survive restarts. Manual refresh remains available from the interface. Feed health shows the last attempt separately from the last successful update, so a stale or failing source is distinguishable from a healthy feed with no new articles.

## AI summaries and translations

Create a persistent encryption key before saving provider credentials:

```sh
openssl rand -hex 32
```

Save the generated value as `AI_CREDENTIALS_KEY` in the project-level `.env` file, recreate the service, then open **Settings → AI**. Choose Google Gemini, OpenAI, or Anthropic, enter the model ID you want to use, and save that provider's API key. Summaries and translations use this same model. Each provider starts with a recommended model ID, but the field accepts any model that the provider makes available to your account. Keys are encrypted per account before they enter SQLite and are never returned to the browser after saving.

## Updating

```sh
git pull --ff-only
```

```sh
docker compose up -d --build
```
