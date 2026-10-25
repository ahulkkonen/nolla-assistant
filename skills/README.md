# Skills

Each skill is a directory `skills/<name>/` with a `SKILL.md` file and an optional `bin/` directory.
Pi loads the skills from this directory. The skills come only from this repository (plan §2, invariant 7).

## Vendor a skill

1. Copy the skill into `skills/<name>/`. The name has only lowercase letters, digits and hyphens.
2. Make sure that `SKILL.md` has the frontmatter fields `name` and `description`. Pi does not load a skill without `description`.
3. Put executables in `bin/`. The sandbox mounts `bin/` read-only at `/skill/bin`.
4. Open a pull request. Review the skill like code.

## The `sandbox` block

The `bash` tool runs every command in a throwaway `skill-runner` container. The `sandbox` block in the frontmatter sets the network policy for the active skill:

```yaml
sandbox:
  network: none      # default: no network
```

| Value | Effect |
|---|---|
| `none` | The container has no network. This is the default. |
| `internet` | The container is on the `pa-skill-egress` network and can reach the internet. |

A list of hosts is not supported yet (phase 7). The broker uses `none` for a list, for an unknown value and for an unknown skill.

## Review rule

A skill must not install software at runtime. Do not use `pip install`, `npm install`, `apt-get` or a download that runs code. Add a tool to `infra/Dockerfile.skill-runner` instead, and review that change.
