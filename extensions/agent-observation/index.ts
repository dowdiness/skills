import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  MAX_NOTE_LENGTH,
  checkpoint,
  defaultStateRoot,
  recordIncident,
  readAutomationAggregate,
  type ObservationMemoryFilesystem,
} from "./core.ts";

const incidentSchema = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: "The packaged agent name." }),
  category: StringEnum([...INCIDENT_CATEGORIES], { description: "A strict observation category." }),
  severity: StringEnum([...INCIDENT_SEVERITIES], { description: "A strict observation severity." }),
  note: Type.String({ minLength: 1, maxLength: MAX_NOTE_LENGTH, description: "A short, non-sensitive operator note." }),
  saveToMemory: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly asks to record and remember this feedback." })),
}, { additionalProperties: false });

export type RecordObservationInput = Static<typeof incidentSchema>;

export interface AgentObservationDependencies {
  memoryRoot?: string;
  filesystem?: Partial<ObservationMemoryFilesystem>;
}

const PROMPT_SNIPPET = "record_observation: record feedback only after an explicitly stated request; for dual save, the latest user message must affirmatively mention observation/incident + memory/remember + record/save; never infer or guess.";
const PROMPT_GUIDELINES = [
  "Use record_observation ONLY when the user explicitly asks to record feedback (for example, 観測に記録して); never infer or guess that feedback should be recorded.",
  "Set saveToMemory=true ONLY when the latest user message explicitly affirms all three parts: observation/incident, memory/remember, and record/save (for example, 観測とメモリに記録して or record this incident and save it to memory). Questions, quotes, and negations do not count; recording alone means false or omitted.",
  "record_observation stores structured feedback; do not call it for ordinary discussion or to summarize a task.",
];

function isEphemeral(ctx: ExtensionContext): boolean {
  const manager = ctx.sessionManager as any;
  if (typeof manager.isPersisted === "function") return !manager.isPersisted();
  return typeof manager.getSessionFile !== "function" || !manager.getSessionFile();
}

function setStatus(ctx: ExtensionContext, result: { shortHead: string; invocationCount: number } | null): void {
  if (!ctx.ui?.setStatus) return;
  ctx.ui.setStatus("agent-observation", result ? `obs ${result.shortHead} ${result.invocationCount}/30–50` : undefined);
}

function checkpointContext(ctx: ExtensionContext): void {
  if (isEphemeral(ctx)) {
    setStatus(ctx, null);
    return;
  }
  try {
    const manager = ctx.sessionManager as any;
    const sessionId = manager.getSessionId();
    if (typeof sessionId !== "string" || sessionId.length === 0 || typeof manager.getEntries !== "function") return;
    const result = checkpoint({
      stateRoot: defaultStateRoot(),
      sessionId,
      entries: manager.getEntries(),
    });
    setStatus(ctx, result);
  } catch {
    // Observation is deliberately best-effort. Never interrupt normal pi usage.
  }
}

export default function agentObservation(pi: ExtensionAPI, dependencies: AgentObservationDependencies = {}): void {
  if (process.env.PI_SCHEDULER_CHILD === "1") return;

  pi.on("session_start", async (_event, ctx) => {
    checkpointContext(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    checkpointContext(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    checkpointContext(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    checkpointContext(ctx);
  });

  pi.registerTool({
    name: "record_observation",
    label: "Record observation",
    description: "Record structured feedback only after the user explicitly asks for it. Set saveToMemory=true only for an explicit request to both record and remember/save it; never infer or guess.",
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: incidentSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (isEphemeral(ctx)) throw new Error("Observation unavailable.");
      try {
        const wantsMemory = (params as any)?.saveToMemory === true;
        const manager = ctx.sessionManager as any;
        const sessionEntries = wantsMemory && typeof manager.getEntries === "function" ? manager.getEntries() : undefined;
        const result = recordIncident({
          stateRoot: defaultStateRoot(),
          incident: params,
          memoryRoot: dependencies.memoryRoot,
          filesystem: dependencies.filesystem,
          sessionEntries,
        });
        if (!result) throw new Error("Observation unavailable.");
        const memorySuffix = result.memorySaved ? " Memory saved." : "";
        return { content: [{ type: "text", text: `Recorded ${result.id} (${result.category}).${memorySuffix}` }] };
      } catch {
        throw new Error("Observation could not be recorded.");
      }
    },
  });

  // Keep the footer correct after a reload even when no entries were added.
  pi.on("session_start", async (_event, ctx) => {
    if (isEphemeral(ctx)) return;
    try { setStatus(ctx, readAutomationAggregate(defaultStateRoot())); } catch { /* best effort */ }
  });
}
