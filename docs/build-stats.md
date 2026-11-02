# Build statistics

This document holds the totals behind the build figures in the [README](../README.md#how-it-was-built)
and in [`workflow.md`](workflow.md). The source transcript is not in the repository. A script measured
it. The script runs on the Claude Code session file.

## Method

Source data:

- The main transcript is one session of 23,900 records. 15,039 of them carry a top-level
  `timestamp`.
- The subagent transcripts are 177 `agent-*.jsonl` files. Each has a `.meta.json` file with the
  `agentType`, the `model`, the `effort` and the `description`.
- The script ignores all records after a fixed cutoff. It also excludes the subagent run that did the
  measurement. The numbers do not change when the session grows.
- The script reads the files line by line.

Definitions:

- Active time comes from the sorted record timestamps. A new block starts where two consecutive
  records are more than N minutes apart. The active time is the sum of (last - first) over all
  blocks. N = 30 is the main figure. N = 15 and N = 60 are comparisons. A block of one record counts
  as 0 h. A long tool call with no records for more than N minutes is not counted. The figure is a
  lower-bound estimate of the hours worked.
- The active time includes agents. Background subagents and task notifications write records to the
  main transcript. So the active time includes time when only agents worked.
- A human message is a `user` record with `origin.kind == "human"`. This covers typed messages and
  messages queued while the agent was busy. The count excludes tool results, subagent hand-backs
  (263), task notifications (133), context-compaction summaries (7) and one interrupt marker.
- Human presence (lower bound) is the number of distinct 15-minute blocks that contain a human
  message, times 0.25 h. It misses reading, phone testing and thinking time between messages.
- Unattended time is the time between consecutive records (gap of 30 minutes or less) where the
  last human message is more than X minutes old. X is 5, 10 or 20.
- Subagent time uses the same 30-minute rule, applied to each file. The tables also show the
  first-to-last span. 13 runs sat idle for hours, because they waited for a follow-up message or a
  sleeping computer. So the span overstates the work. The "union" merges the overlapping active
  intervals of all subagents. It gives the wall-clock time with agents busy.
- The model split reads the `message.model` field of the assistant records in each subagent file.
  The `model` field in the meta file is empty when the agent inherited the default.
- The commit count is the result of `git log --format=%H | wc -l` when the script ran. The history
  was rewritten once, in the publication phase. So the count is the count after the rewrite.

## Active time

| Measure | Value |
|---|---|
| Wall-clock span | 7.60 days |
| Calendar days with records | 8, and 7 of them have more than 3 h |
| Blocks, 30-min rule | 28 (23 longer than 1 min) |
| **Active time, 30-min rule (main figure)** | **61.8 h** |
| Active time, 15-min rule | 43.9 h in 77 blocks |
| Active time, 60-min rule | 72.3 h in 13 blocks |
| Main thread and all subagents combined, 15 / 30 / 60 min | 58.1 h / 66.3 h / 72.3 h |
| Claude Code `cost-state` record (cross-check) | 76.2 h total duration, 37.3 h API time, 19.7 h tool time, 32,023 lines added |
| Mean active time per calendar day | 7.7 h (8.8 h over the 7 days with more than 3 h) |

## Human attention

| Measure | Value |
|---|---|
| Human messages | 84 (9 with a screenshot attached) |
| Gap between consecutive human messages, median | 11.9 min |
| Gap, 75th percentile / 90th percentile | 69 min / 407 min (6.8 h, mostly nights) |
| Gaps of 5 min or less / 30 min or less / over 2 h | 24 / 52 / 15, of 83 gaps |
| Presence lower bound | 53 blocks of 15 min = 13.3 h, in 37 distinct clock hours |
| Active time with no human message in the last 5 / 10 / 20 min | 85 % / 79 % / 71 % (52.4 / 48.8 / 44.1 h of 61.8 h) |

About 84 messages and at least 13 h of presence sit inside 62 h of active time. Roughly three
quarters of the active time was agents working without a new instruction. Two of the 84 messages
only report that a usage limit is over. They give no new instruction.

## Agent work

177 subagent runs, one per `Agent` call in the main thread. 151 `SendMessage` calls continued
existing runs.

| Measure | Value |
|---|---|
| Runs | 177 (3 unfinished at the cutoff) |
| Sum of active time (30-min rule per run) | 93.2 h |
| Sum of first-to-last span | 179.2 h (includes idle waits of up to 38 h; not a work figure) |
| Union of active intervals (agents busy, wall clock) | 51.3 h |
| Peak concurrency | 8 agents |
| Median run | 10.9 min active |

By model:

| Model | Runs | Active time |
|---|---|---|
| claude-opus-5-5 (effort: xhigh 62, high 9, medium 8, default 98) | 116 | 90.2 h |
| claude-sonnet-5-5 | 59 | 2.9 h |
| claude-haiku-5-5 | 2 | 0.05 h |

The main thread ran on claude-fable-5-1 and wrote 3,020 assistant records.

By agent type:

| Agent type | Runs | Active time |
|---|---|---|
| general-purpose | 129 | 91.2 h |
| cavecrew-reviewer | 44 (43 on Sonnet) | 2.0 h |
| cavecrew-builder | 2 | |
| cavecrew-investigator | 1 | |
| web-search-researcher | 1 | |

## Tool calls

| Thread | Total | Calls by tool |
|---|---|---|
| Main thread | 1,580 | Bash 1,126; Agent 177; SendMessage 151; Read 61; Write 24; ToolSearch 17; AskUserQuestion 10; SendUserFile 4; TaskStop 3; WebFetch 2; WebSearch 2; Serena 3 |
| Subagents | 15,761 | Bash 11,215; Read 3,562; SubagentHandback 287; Write 222; Edit 136; ToolSearch 95; WebFetch 46; Monitor 40; WebSearch 34; Serena search and navigation 63 or more; TaskStop 14; Skill 11 (all `asd-ste100`) |

The main thread never called Edit. It changed files through the shell only for merges, one-line fixes
and documentation. The subagents made the code changes.

## Term counts

This build did not use the slash-command plan workflow.

## Commits

428 commits when the script ran. The repository has more now.

## Limits

The measure covers one Claude Code session and its subagents. It leaves out time in Claude Web,
reading the app on other devices without a message, and work in other tools. Read the human presence
as "at least 13 h".
