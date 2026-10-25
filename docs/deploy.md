# Deploy runbook

This procedure deploys `pa-server` to Coolify on the Hetzner VPS. Do the steps in order.
Phase 2 ships only `pa-server`. Later phases add services to `infra/compose.yaml`.

## 1. Prepare secrets

1. Create the password hash on your workstation:

   ```sh
   node scripts/hash-password.mjs
   ```

   Type the password at the prompt. Copy the printed `scrypt$...` string.

2. Create a cookie secret:

   ```sh
   openssl rand -base64 48
   ```

## 2. Create the Coolify resource

1. In Coolify, add a new resource of type **Docker Compose** from this Git repository.
2. Set the compose file path to `infra/compose.yaml`.
3. Set the domain for the `pa-server` service, for example `https://assistant.example.fi`. Coolify issues the TLS certificate.
4. Add these environment variables in Coolify. Do not commit them.

   | Variable | Value |
   |---|---|
   | `AUTH_ORIGIN` | `https://assistant.example.fi` (the exact origin, no trailing slash) |
   | `AUTH_PASSWORD_HASH` | the `scrypt$...` string from step 1 |
   | `COOKIE_SECRET` | the random string from step 1 |
   | `LITELLM_URL` | `http://litellm:4000`, no `/v1`: Pi appends `/chat/completions` and LiteLLM serves it (compose default) |
   | `LITELLM_MASTER_KEY` | any random string for now; phase 3 uses it |
   | `TRUST_PROXY` | `1` |
   | `USER_ID` | your short user id, letters and digits only |

5. Deploy. Wait until the health check reports healthy.

## 3. First login and passkey

1. Open the domain in Safari on the iPhone or in Chrome on the desktop.
2. Log in with the password.
3. Open **Asetukset** (the gear) and select **Lisää avain** within 10 minutes of the login. Registration requires a fresh session.
4. On iPhone: Share → **Add to Home Screen**. Open the app from the Home Screen once; the service worker installs.
5. On desktop Chrome: use the install icon in the address bar.

## 4. Verify

- `https://<domain>/healthz` returns `{"ok":true}`.
- Logging out and back in with the passkey works.
- The app opens from the Home Screen in standalone mode (no browser chrome).

## Backups

The `backup` service replicates `app.db` to the S3 bucket with Litestream and snapshots `/data` with restic every night at 03:00 Europe/Helsinki. `vault.db` is covered hourly by restic (tag `vault`, with its WAL file), because Litestream cannot read SQLCipher files. At most one hour of new mappings can be lost. A lost mapping cannot be rebuilt: surrogates are seeded with a random secret that exists only inside the vault. The service mounts `/data` read-write because Litestream opens the live database and keeps its state next to it.

### Set up

1. Create an S3-compatible bucket and a key pair that can read and write it.
2. Add these environment variables in Coolify. Do not commit them.

   | Variable | Value |
   |---|---|
   | `S3_ENDPOINT` | the endpoint URL, with scheme and no trailing slash |
   | `S3_BUCKET` | the bucket name |
   | `S3_ACCESS_KEY`, `S3_SECRET_KEY` | the key pair |
   | `RESTIC_PASSWORD` | a long random string. Store a copy outside the VPS: without it the restic snapshots are lost. |

3. Deploy. The first nightly run creates the restic repository. To snapshot now, run `docker compose exec backup /backup-now.sh`.

### Verify that Litestream replicates

```sh
docker compose exec backup litestream ltx -config /etc/litestream.yml -level all /data/app.db
```

The command lists LTX files with a recent `created` time. Litestream 0.5 has no `snapshots` command. The log line `restic run ok` appears after each nightly run.

### Restore on a new VPS

1. Set the same environment variables on the new host. Do not start the stack yet: the volume must be empty when the restore starts.
2. Run the restore into the empty `pa-data` volume:

   ```sh
   docker compose run --rm --no-deps backup /scripts/restore.sh
   ```

   The script restores `app.db` with Litestream, then sessions, files, Pi state and `vault.db` from restic (the vault from the newest snapshot with tag `vault`). It prints each restored file.
3. Start the stack: `docker compose up -d`.

### Restore drill

```sh
scripts/restore-drill.sh
```

The drill starts a local S3 server (rustfs; MinIO has no image on Docker Hub), creates a chat, backs up, deletes the volume, restores and checks that the chat opens. It needs Docker and Node and takes about 20 seconds after the images are pulled.

## Sandbox

The `bash` tool runs each command in a throwaway `pa-skill-runner` container. The `sandbox-broker` service starts these containers. It is the only service with the Docker socket.

1. Build the runner image on the Docker host. Compose cannot build an image that no service runs. Do this before the first deploy and after each change to `infra/Dockerfile.skill-runner`:

   ```sh
   scripts/build-skill-runner.sh
   ```

2. Add these environment variables in Coolify:

   | Variable | Value |
   |---|---|
   | `BROKER_TOKEN` | at least 32 random characters, for example `openssl rand -base64 48`. `pa-server` and `sandbox-broker` share it. |
   | `HOST_DATA_DIR` | the host path of the `pa-data` volume, from `docker volume inspect <project>_pa-data --format '{{.Mountpoint}}'` |
   | `HOST_SKILLS_DIR` | the host path of the `skills/` directory of the checkout. Only skills with a `bin/` directory need it. |

   The broker gives these paths to the Docker host as bind sources. A path inside the broker container does not work.

3. Deploy. Compose creates the `pa-skill-egress` and `pa-skill-proxy-only` networks. A skill with `network: [hosts]` runs on `pa-skill-proxy-only` and reaches the listed hosts through the broker's proxy.

## Integrations

The `mcp-workspace` service gives the agents Google Calendar (read and write), Google Drive (read) and Gmail (read). Decision `docs/decisions/0005-mcp-integrations.md` records the pin and the flags. `infra/mcp.yaml` lists the tools that the agents can use. `manage_event` always needs your approval.

### Create the Google OAuth client

1. In Google Cloud Console, create a project or select one.
2. Enable these APIs: Google Calendar API, Google Drive API, Gmail API.
3. Configure the OAuth consent screen. Add your Google address as a test user if the app is in testing mode.
4. Create an OAuth client ID of type **Web application**.
5. Add one authorized redirect URI: `<AUTH_ORIGIN>/api/oauth/google/callback`, for example `https://assistant.example.fi/api/oauth/google/callback`. The value must match `AUTH_ORIGIN` exactly.
6. Add these environment variables in Coolify:

   | Variable | Value |
   |---|---|
   | `GOOGLE_OAUTH_CLIENT_ID` | the client ID |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | the client secret. Only `mcp-workspace` receives it. |
   | `USER_GOOGLE_EMAIL` | your Google address. `pa-server` receives it as `SELF_EMAIL`. |

7. In Coolify, do not attach `mcp-workspace` to the proxy network and do not give it a domain. Its `/mcp` endpoint has no authentication. Only the `mcp` network (shared with `pa-server`) protects it.
8. Deploy. The one-shot `mcp-workspace-init` service gives the `mcp-workspace-data` volume to uid 10001, then `mcp-workspace` starts.

### Connect your Google account

1. Log in to the app.
2. Send `POST /api/integrations/google/connect` from the app (Settings, when the web UI has the button). The response holds `authUrl`.
3. Open `authUrl` and accept the consent screen. Google redirects to `/api/oauth/google/callback`. `pa-server` forwards the request to `mcp-workspace`, then redirects you to `/?integrations=google`.
4. `GET /api/integrations/status` returns `{"google":{"connected":true,...}}`. Open sockets receive `integrations.state`.

The consent link expires after 10 minutes and works one time. If the link fails, request a new one.

### Disconnect

The server has no API to remove its token. Do these steps:

1. Remove the token file: `docker compose exec mcp-workspace sh -c 'rm /data/mcp/workspace/*.json'`.
2. Revoke the access at <https://myaccount.google.com/permissions>.

### Your own address in the vault

`pa-server` adds `USER_GOOGLE_EMAIL` (as `SELF_EMAIL`) to the vault as an allowlisted `EMAIL` entity at startup. Your address is in every workspace tool schema, and no masking covers tool schemas. The allowlist keeps the schemas and the tool results the same. If the startup log shows `self email allowlist failed`, allowlist the address manually in Nimisuoja.

### Backups

The token file is in the `mcp-workspace-data` volume. The file holds the refresh token in plain JSON (mode 600). The `backup` service mounts the volume read-only at `/backup-extra/mcp-workspace`, and the nightly restic snapshot includes it. Only the restic backup is encrypted.

`scripts/restore.sh` does not restore the token volume, because the backup service mounts it read-only. After the main restore, run the script once more with the volume mounted read-write:

```sh
docker run --rm --env-file restore.env \
  -v <project>_mcp-workspace-data:/backup-extra/mcp-workspace \
  --entrypoint /scripts/restore.sh <project>-backup mcp
```

`restore.env` holds `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `RESTIC_PASSWORD`. If you skip this step, connect your Google account again. The restore drill does not cover the token volume.

## Local run with Docker

This runs every service on your machine, with the real pseudonymization service and the real
LiteLLM egress. Only the OpenRouter key is real; nothing leaves the machine except model calls.

1. Copy `.env.example` to `.env`. Fill in `OPENROUTER_API_KEY`, `LITELLM_MASTER_KEY`,
   `PSEUDO_VAULT_KEY`, `BROKER_TOKEN`, `COOKIE_SECRET` and `AUTH_PASSWORD_HASH`
   (`node scripts/hash-password.mjs`). Write each `$` of the hash as `$$`, because compose
   interpolates `$name` in `.env`. Keep `AUTH_ORIGIN=http://localhost:3000`.
2. Google Workspace is optional. Without a client, set `GOOGLE_OAUTH_CLIENT_ID=unused`,
   `GOOGLE_OAUTH_CLIENT_SECRET=unused` and `USER_GOOGLE_EMAIL=you@example.com`. The
   Google tools then show "Ei yhdistetty".
3. Start the stack. The first build downloads the models and takes several minutes.

   ```
   docker compose --env-file .env -f infra/compose.yaml -f infra/compose.local.yaml up --build
   ```

4. Open http://localhost:3000 and log in with the password. Passkeys, push and the Google
   OAuth callback all accept `localhost`.

The `backup` service does not start here because it needs an S3 bucket. Add `--profile backup`
when `.env` has the S3 values. Stop everything with `docker compose ... down`; add `-v` to
delete the data volume too.
