# Automations

Each `*.yaml` file here is one scheduled agent run. `pa-server` loads the files at startup and
reloads them one second after a change. A file with a different extension is ignored.

Each run is a normal chat under the "Automaatiot" topic. The chat title is the automation id plus the
run time.

Fields:

- `id`: must equal the file name without `.yaml`.
- `cron`: cron expression (5 fields, or 6 with seconds first).
- `timezone`: IANA zone, default `Europe/Helsinki`.
- `agentId`: agent profile in `agents/`, default `assistant`.
- `prompt`: text sent to the agent.
- `deliver`: `chat`, `push` or `both`, default `chat`. Push is not available until phase 7.
- `enabled`: default `true`.

See `example.yaml.disabled`. Rename it to `example.yaml` to enable it.
