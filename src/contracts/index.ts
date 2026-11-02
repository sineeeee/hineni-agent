import { z } from "zod";
export const TargetSchema = z
  .object({
    channel: z.string(),
    conversation: z.string(),
    thread: z.string().optional(),
    kind: z.enum(["private", "group"]).optional(),
  })
  .strict();
export type Target = z.infer<typeof TargetSchema>;
export const EventSchema = z
  .object({
    protocol_version: z.literal(1).default(1),
    event_id: z.string().min(1).max(200),
    agent_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    type: z.enum([
      "incoming_message",
      "internal_event",
      "attachment_ready",
      "attachment_failed",
      "tool_call",
      "tool_result",
      "agent_reply",
      "outbound_action",
      "run_finished",
      "delivery_result",
    ]),
    source: z.string().max(100),
    occurred_at: z.string().datetime().optional(),
    text: z.string().max(2_000_000).default(""),
    reply_target: TargetSchema.optional(),
    sender: z
      .object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(["user", "agent", "system"]),
      })
      .optional(),
    source_message_id: z.string().optional(),
    reply_to_message_id: z.string().optional(),
    parent_event_id: z.string().optional(),
    run_id: z.string().optional(),
    attachments: z.array(z.string()).default([]),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type EventInput = z.infer<typeof EventSchema>;
export interface Event extends EventInput {
  seq: number;
  received_at: string;
  claimed: number;
}
export const triggerTypes = new Set([
  "incoming_message",
  "internal_event",
  "attachment_ready",
  "attachment_failed",
]);
export interface Attachment {
  id: string;
  agent_id: string;
  path: string;
  name: string;
  mime: string;
  status: "pending" | "ready" | "failed";
  error?: string;
}
export type Part =
  | { type: "text"; text: string }
  | { type: "image" | "file"; attachment_id: string; caption?: string };
export interface Delivery {
  id: string;
  agent_id: string;
  run_id: string;
  response_id: string;
  chunk_index: number;
  target: Target;
  action: "send" | "react";
  parts: Part[];
  message_id?: string;
  emoji?: string;
}
export interface Channel {
  id: string;
  send(
    delivery: Delivery,
    part: Part | undefined,
  ): Promise<{ message_id?: string; raw?: unknown }>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
export interface ModelMessage {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      >;
}
export interface ContextBundle {
  system: string;
  messages: ModelMessage[];
  memories: Array<{ id: string; summary: string; details?: string }>;
  target: Target;
  inputText: string;
}
export interface RunRequest {
  agentId: string;
  runId: string;
  context: ContextBundle;
  signal: AbortSignal;
}
export interface RunResult {
  reason: "complete" | "silent" | "cancelled" | "error" | "limit";
  text: string;
  tools: string[];
  error?: string;
  memoryIds: string[];
}
export interface Executor {
  run(req: RunRequest): Promise<RunResult>;
}
export const targetKey = (t: Target) =>
  `${t.channel}:${t.conversation}:${t.thread ?? ""}`;
