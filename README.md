# Echovale

Echovale is a dark-first, keyboard-first RSS reader for a private household. It keeps each account's daily reading loop in one place: OPML subscriptions, folders, filtering rules, full-text articles, explicit read and starred state, and visible feed health.

It deliberately has no social, discovery, recommendation, or public account-management features.

## Features

- Import and export OPML, including feed folders.
- Magazine and expanded article lists.
- Unread, read, and starred states.
- Keyboard navigation for the complete reading loop.
- Rules that keep wanted articles, hide noise, or mark matches as read.
- Full-text extraction with feed content as a visible fallback.
- One-click AI article summaries through Google Gemini, OpenAI, or Anthropic.
- Manual refresh and server-side background polling.
- Per-feed last attempt, last success, HTTP status, and error details.
- Persistent article font sizing, visible keyboard focus, and reduced-motion support.
- In-app account registration and password login, with separate subscriptions, rules, settings, and reading state per account.

## Deploy with Docker Compose

The included deployment runs one Node.js 24.18.0 process and stores SQLite data in a named volume. Do not scale the service to multiple replicas: polling and SQLite ownership are intentionally kept in one process.

Requirements:

- Docker Engine with Docker Compose v2.
- A Tailscale-connected host if Echovale will be used from another device.

Build and start Echovale:

```sh
docker compose up -d --build
```

Open Echovale and choose **Create an account** on the sign-in screen. Registration signs the new account in immediately, and passwords are hashed before they are stored in SQLite. To add another household member, sign out and register another account.

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

## Private HTTPS over Tailscale

Echovale has password authentication, but registration remains available to anyone who can reach the sign-in screen. The Compose port remains bound to host loopback by default rather than the LAN or public internet. Keep access private and let tailnet access rules provide the outer network boundary.

On the Docker host, publish the loopback service through Tailscale Serve:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
```

The command prints the private `https://<device>.<tailnet>.ts.net` address. Inspect the active configuration with:

```sh
tailscale serve status
```

HTTPS is important here: browsers allow copy-to-clipboard from a secure context. Plain HTTP on a remote tailnet address may load the reader but block the copy shortcut. Tailscale Serve terminates HTTPS with an automatically provisioned certificate and persists a `--bg` configuration across restarts. See the official [Tailscale Serve command documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

Disable the proxy with:

```sh
sudo tailscale serve --https=443 off
```

Do not use Tailscale Funnel for Echovale; Funnel makes a service public to the internet.

## Configuration

Compose accepts these values from a project-level `.env` file or the shell:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ECHOVALE_BIND_ADDRESS` | `127.0.0.1` | Host address that publishes the container port. Keep loopback when using Tailscale Serve. |
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

## AI article summaries

Create a persistent encryption key before saving provider credentials:

```sh
openssl rand -hex 32
```

Save the generated value as `AI_CREDENTIALS_KEY` in the project-level `.env` file, recreate the service, then open **Settings → AI summaries**. Choose Google Gemini, OpenAI, or Anthropic, enter the model ID you want to use, and save that provider's API key. Each provider starts with a recommended model ID, but the field accepts any model that the provider makes available to your account. Keys are encrypted per account before they enter SQLite and are never returned to the browser after saving.

Use **Summarize** in the article action bar, or press `m`. Echovale prefers loaded publisher content, falls back to feed content, and finally uses the feed excerpt. A summary is cached until the article source changes; **Regenerate** deliberately requests a new result and can use a newly selected provider.

Provider credentials are shared by Echovale's AI feature foundation, while each feature owns its provider/model choice and prompt. This lets a future digest feature reuse saved credentials without coupling its model or behavior to article summaries.

## Back up and restore

Use a stopped service for a consistent copy of the SQLite database and its journal files. Back up the project-level `.env` securely as well: restoring encrypted provider keys requires the same `AI_CREDENTIALS_KEY`. If that key is lost, the database still starts, but each provider API key must be entered again.

Create a timestamped backup:

```sh
docker compose stop echovale
```

```sh
mkdir -p backups
```

```sh
docker compose cp echovale:/data/. ./backups/echovale-$(date +%Y%m%d-%H%M%S)
```

```sh
docker compose start echovale
```

Restore a selected backup after stopping the service:

```sh
docker compose stop echovale
```

```sh
docker compose run --rm --no-deps --entrypoint sh echovale -c 'rm -f /data/echovale.db /data/echovale.db-shm /data/echovale.db-wal'
```

```sh
docker compose cp ./backups/echovale-YYYYMMDD-HHMMSS/. echovale:/data/
```

```sh
docker compose run --rm --no-deps --user root --entrypoint chown echovale -R node:node /data
```

```sh
docker compose start echovale
```

Replace the timestamp placeholder with the backup directory to restore. Confirm readiness with the health command after restoration. Keep backups outside the Docker volume and include them in the homeserver's normal off-host backup routine.

## OPML and article rules

Open **Feeds** to import or export an OPML file. Import recreates folders and subscriptions; duplicate feed URLs are skipped and import failures are reported. OPML contains subscriptions and folder organization, not article read/starred state or rules, so retain the SQLite backup as the complete recovery source.

Open **Rules** to build filters from one or more case-insensitive conditions. Conditions can inspect the title, author, summary, content, media type, or all text and can require every condition (AND) or any condition (OR). A rule can hide matches, keep only wanted matches, or mark matches as read, and can apply globally or to a feed or folder.

## Keyboard shortcuts

Single-key shortcuts pause while focus is in a text field or other editable control. They can also be disabled in settings. Press `?` in the app to see the same shortcut reference.

| Key | Action |
| --- | --- |
| `j` | Move to the next article. |
| `k` | Move to the previous article. |
| `u` | Mark the active article unread. |
| `s` | Toggle the active article's starred state. |
| `c` | Copy the active article URL. |
| `m` | Show, hide, or create the active article summary. |
| `r` | Refresh the current feed or scope. |
| `Shift+r` | Refresh all feeds. |
| `[` | Decrease article font size. |
| `]` | Increase article font size. |
| `1` | Switch to magazine view. |
| `2` | Switch to expanded view. |
| `g`, then `u` | Open unread articles. |
| `g`, then `s` | Open starred articles. |
| `g`, then `a` | Open all articles. |
| `?` | Open keyboard help. |

## Local development

Install Node.js 24.18.0, then install locked dependencies:

```sh
npm ci
```

Start the API and Vite development server:

```sh
npm run dev
```

Open `http://localhost:5173/echovale/`. Vite proxies the app's API and health paths to the API on port 3000.

Run the complete validation suite:

```sh
npm run check
```

Build and run the production application without Docker:

```sh
npm run build
```

```sh
npm start
```

## Updating

The configured homeserver remote deploys `master` automatically through the bare repository hook:

```sh
git push homeserver master
```

The production app is available to the tailnet at `https://hs.tailb4f5f1.ts.net/echovale/`.

For another Docker host, back up the database, update the checkout, and rebuild the image:

```sh
git pull --ff-only
```

```sh
docker compose up -d --build
```
