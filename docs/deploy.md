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

3. Set up the OpenRouter account and its two API keys (decision `phase-10-models`, decision 1).
   Do these steps in the default workspace.

   1. Open https://openrouter.ai/settings/privacy. Turn off the ZDR toggle for all five model
      groups. An account toggle applies to every key, so it also blocks the open key.
   2. On the same page, keep the setting that blocks providers that train on prompts.
   3. Do not add ZDR to the default guardrail of the workspace. That guardrail applies to every
      key in the workspace.
   4. Create the ZDR guardrail. Set all five `enforce_zdr_*` fields to true and set a monthly
      budget.
   5. Create an API key. In the **API Keys** section of the ZDR guardrail, assign the guardrail to
      this key. A guardrail enforces nothing until you assign it. This key is
      `OPENROUTER_API_KEY`. Every `zdr/` route uses it.
   6. Create the open guardrail. Do not turn on ZDR in it. Set its own monthly budget.
   7. Create a second API key and assign the open guardrail to it. This key is
      `OPENROUTER_OPEN_API_KEY`. Only the `open/*` route uses it.
   8. Add both keys as Coolify environment variables in section 2, step 4. Only the `litellm`
      service gets them.
   9. Open https://openrouter.ai/settings/plugins. Keep every plugin off by default, the web
      plugin too. A default plugin applies to every request of every key. Only the `zdr/search`
      alias searches (decision `phase-14-search`, decision 3).

   `OPENROUTER_OPEN_API_KEY` is optional. When it is empty, LiteLLM refuses every `open/` model
   with HTTP 400. Then no model call leaves without ZDR.

## 2. Create the Coolify resource

1. In Coolify, add a new resource of type **Docker Compose** from this Git repository.
2. Set the compose file path to `infra/compose.yaml`.
3. Set the domain for the `pa-server` service, for example `https://assistant.example.fi`. Coolify issues the TLS certificate. Do not give a domain to another service. `pseudo-svc` has no authentication. Only the `pseudo` network (shared with `pa-server`, no internet) protects it. The Presidio containers are on the `presidio` network with `litellm` only.
4. Add these environment variables in Coolify. Do not commit them.

   | Variable | Value |
   |---|---|
   | `AUTH_ORIGIN` | `https://assistant.example.fi` (the exact origin, no trailing slash) |
   | `AUTH_PASSWORD_HASH` | the `scrypt$...` string from step 1 |
   | `COOKIE_SECRET` | the random string from step 1 |
   | `LITELLM_URL` | `http://litellm:4000`, no `/v1`: Pi appends `/chat/completions` and LiteLLM serves it (compose default) |
   | `LITELLM_MASTER_KEY` | at least 32 random characters, for example `openssl rand -base64 48`. `pa-server` does not start with a shorter key. |
   | `TRUST_PROXY` | `1` |
   | `USER_ID` | your short user id, letters and digits only |

   These optional variables control the two public, key-free lookups of `pa-server`. Neither call carries user data.

   - `ECB_RATES`: the base URL of the ECB exchange-rate API. The default is `https://data-api.ecb.europa.eu`. Set `off` to stop every request. The server still loads the cached rate from `DATA_DIR/fx`. Without a rate, the UI shows costs in USD.
   - `OPENROUTER_CATALOG`: the base URL of the public OpenRouter model catalog. The default is `https://openrouter.ai/api/v1`. Set `off` to stop every request. The server still loads the cached catalog from `DATA_DIR/openrouter`.

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

The `backup` service replicates `app.db` to the S3 bucket with Litestream and snapshots `/data` with restic every night at 03:00 Europe/Helsinki. The snapshot includes the work dirs (`/data/work/<user>`, the Työkansio root of the Files screen) but not their `.trash` folders. `vault.db` is covered hourly by restic (tag `vault`, with its WAL file), because Litestream cannot read SQLCipher files. At most one hour of new mappings can be lost. A lost mapping cannot be rebuilt: surrogates are seeded with a random secret that exists only inside the vault. The service mounts `/data` read-write because Litestream opens the live database and keeps its state next to it.

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

   The broker gives these paths to the Docker host as bind sources. A path inside the broker container does not work. The broker does not start without `HOST_DATA_DIR`.

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
LiteLLM egress. Only the OpenRouter keys are real; nothing leaves the machine except model calls.

1. Copy `.env.example` to `.env`. Fill in `OPENROUTER_API_KEY`, `LITELLM_MASTER_KEY`,
   `PSEUDO_VAULT_KEY`, `BROKER_TOKEN`, `COOKIE_SECRET` and `AUTH_PASSWORD_HASH`
   (`node scripts/hash-password.mjs`). Write each `$` of the hash as `$$`, because compose
   interpolates `$name` in `.env`. Keep `AUTH_ORIGIN=http://localhost:3000`.
   `OPENROUTER_OPEN_API_KEY` is optional (section 1, step 3). When it is empty, LiteLLM refuses
   every `open/` model with HTTP 400.
2. Google Workspace is optional. Without a client, set `GOOGLE_OAUTH_CLIENT_ID=unused`,
   `GOOGLE_OAUTH_CLIENT_SECRET=unused` and `USER_GOOGLE_EMAIL=you@example.com`. The
   Google tools then show "Ei yhdistetty".
3. Start the stack. The first build downloads the models and takes several minutes.

   ```
   docker compose --env-file .env -f infra/compose.yaml -f infra/compose.local.yaml up --build
   ```

4. Open http://localhost:3000 and log in with the password. Passkeys, push and the Google
   OAuth callback all accept `localhost`.

### Open the local run on your phone

You can use the local run from a phone on the same wifi. This connection uses plain http.
Use it only on a network that you trust.

1. In `.env`, set `PA_LAN_BIND=0.0.0.0`, `AUTH_INSECURE_LAN=1` and
   `AUTH_ORIGIN=http://<mac-name>.local:3000`. Replace `<mac-name>` with the local host name
   of your Mac (System Settings › General › Sharing).
2. Start the stack again with the command in step 3.
3. On the phone, open `http://<mac-name>.local:3000` and log in with the password.

Passkeys, the microphone and the PWA install need https. They do not work on this connection.
The session cookie does not have the `Secure` flag, because the origin is http.

The `backup` service does not start here because it needs an S3 bucket. Add `--profile backup`
when `.env` has the S3 values. Stop everything with `docker compose ... down`; add `-v` to
delete the data volume too.

## Upgrade notes

- At each start, the server updates the files in `DATA_DIR/agents` and `DATA_DIR/automations` that you did not edit to the versions in the image. It does not change a file that you edited. It logs one warning line for each such file: "agent file edited by user, not updated". Merge the change in Settings › Agentit if you want it.
- Phase 16 (one agent): after this upgrade, open Settings › Agentit and delete "Tutkija". The delete moves the chats of Tutkija to Avustaja. Avustaja gets the tools of Tutkija only if you did not edit `assistant.yaml`. If you edited it, the log names the file. Then add `bash` and turn on "Aliagentit" in the form.
- An install from before phase 16 has no `.seeded.json`. On the first start of phase 16, the server treats every existing file that differs from the image as edited and does not change it. So such an install must make the Avustaja change by hand, as in the item above.
