# Extensions

pi extensions that add tools and commands to the coding agent. Extensions are TypeScript modules that run with full system access.

## Catalog

| Extension | Origin | Purpose |
|---|---|---|
| `scheduler` | manual | Profile-driven task routing, validation, patch management, and cautious autopilot. |
| `subagent` | manual | Registers the subagent delegation tool with user/project agent discovery and fallback handling. |

## scheduler

Routes high-confidence tasks through the active repository profile. Canopy repository markers select MoonBit-aware routes; other repositories use a generic profile that defaults to `off` until explicitly enabled.

Features:
- Automatic task classification and routing
- Scheduler patch management and validation
- Worktree-based isolation for editing routes
- Autopilot modes for high-confidence routes

Configuration via pi commands:
- `/scheduler on|off` - enable/disable routing
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
