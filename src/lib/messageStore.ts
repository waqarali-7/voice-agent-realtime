/**
 * messageStore.ts
 *
 * A tiny append-only store for caller messages the agent takes during a call.
 * Deliberately dependency-free: it writes newline-delimited JSON (JSONL) to a
 * file on disk. That keeps the demo self-contained — no database to stand up —
 * while still being a real, inspectable persistence layer the agent writes to.
 *
 * Swapping this for Postgres/DynamoDB later is a one-file change: keep the
 * `MessageStore` interface, replace the implementation.
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface CallerMessage {
  id: string;
  takenAt: string; // ISO timestamp
  callerName: string;
  callbackNumber: string;
  message: string;
  channel: "phone" | "web";
}

export interface NewMessage {
  callerName: string;
  callbackNumber: string;
  message: string;
  channel: "phone" | "web";
}

export interface MessageStore {
  save(input: NewMessage): Promise<CallerMessage>;
  list(): Promise<CallerMessage[]>;
}

/** JSONL-backed implementation. One JSON object per line, append-only. */
export class JsonlMessageStore implements MessageStore {
  constructor(private readonly filePath: string) {}

  async save(input: NewMessage): Promise<CallerMessage> {
    const record: CallerMessage = {
      id: randomUUID(),
      takenAt: new Date().toISOString(),
      ...input,
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  async list(): Promise<CallerMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return []; // no file yet → no messages
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CallerMessage);
  }
}
