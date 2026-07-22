# Extensions

pi extensions that add tools and commands to the coding agent. Extensions are TypeScript modules that run with full system access.

## Catalog

| Extension | Origin | Purpose |
|---|---|---|
| `agent-observation` | manual | Automatic privacy-preserving runtime checkpoints and explicitly requested structured feedback. |
| `scheduler` | manual | Profile-driven task routing, validation, patch management, and cautious autopilot. |
| `subagent` | manual | Registers the subagent delegation tool with user/project agent discovery and fallback handling. |

## agent-observation

Automatically checkpoints the active private observation cohort during normal pi
use: startup/reload/new/resume/fork/clone, tree navigation, settled turns, and
shutdown. It never finishes a cohort and does nothing for scheduler child or
ephemeral sessions. Runtime state stores only HMAC fingerprints and aggregate
runtime evidence. Use natural language such as `観測に記録して` when feedback
should be recorded; the agent then calls `record_observation` explicitly.

## scheduler

The scheduler integration is supported for Canopy repositories. Canopy
repository markers select MoonBit-aware routes, including
`/scheduler parallel-review`.

The generic profile implementation remains internal and is not a supported
third-party workflow. Its agent provisioning, provider configuration, and
validation coverage are tracked in [issue #7](https://github.com/dowdiness/skills/issues/7).

Features:
- Canopy task classification and routing
- Scheduler patch management and validation
- Worktree-based isolation for editing routes
- Cautious autopilot for high-confidence routes

Configuration via pi commands:
- `/scheduler on|off` - enable/disable routing
- `/scheduler parallel-review <request>` - run the Canopy parallel review route
- `/scheduler autopilot off|cautious|status` - control autopilot behavior
- `/scheduler validate [current|patch]` - package-aware validation
- `/scheduler last` - show latest route record
- `/scheduler apply <patch>` - preview/apply scheduler patches

## subagent

Delegates tasks to specialized agents with isolated context windows.

Supports three modes:
- **Single**: `{ agent: "name", task: "..." }`
- **Parallel**: `{ tasks: [{ agent: "name", task: "..." }, ...] }`
- **Chain**: `{ chain: [{ agent: "name", task: "... {previous} ..." }, ...] }`

Agent discovery:
- User agents: `~/.pi/agent/agents/*.md`
- Project agents: `.pi/agents/*.md`

Limits:
- Max 8 parallel tasks
- Max 4 concurrent executions
- 50KB per-task output cap
