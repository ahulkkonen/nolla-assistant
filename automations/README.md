# Automations

Each `*.yaml` file here is one scheduled agent run. `pa-server` loads the files at startup and
reloads them one second after a change. A file with a different extension is ignored.

Each run is a normal chat under the "Automaatiot" topic. The chat title is the automation id plus the
run time.

Fields:

- `id`: must equal the file name without `.yaml`.
- `name`: optional display name for Settings › Automaatiot, 1 to 80 characters. Without it the
  settings page shows the id.
- `cron`: cron expression (5 fields, or 6 with seconds first).
- `timezone`: IANA zone, default `Europe/Helsinki`.
- `agentId`: agent profile in `agents/`, default `assistant`.
- `prompt`: text sent to the agent.
- `deliver`: `chat`, `push` or `both`, default `chat`. Push is not available until phase 7.
- `enabled`: default `true`. The settings button runs a disabled automation anyway, on purpose.
- `autoApprove`: tools of the agent's `approval.always` list that run without asking, default none.
  Nobody is there to approve a scheduled run, so any other gated tool is denied at once and the
  agent is told why.

A run that is still going is not started again. A run records `error` when the session fails or the
model call fails. Push on failure is not sent until phase 7; the settings page shows `lastStatus`.
An automation whose `agentId` is unknown is skipped with a warning.

See `example.yaml.disabled`. Rename it to `example.yaml` to enable it.
