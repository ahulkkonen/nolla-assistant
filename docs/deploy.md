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
   | `LITELLM_URL` | `http://litellm:4000` (phase 3 adds the service; until then the chat replies with an error) |
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

## Restore and backups

Phase 4 adds `scripts/restore.sh` and the backup sidecar. Until then, back up the `pa-data` volume manually.
