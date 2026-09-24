import { db } from "../client.js";
import { events } from "../schema.js";

export type EventType = "open" | "click" | "bounce" | "complaint" | "unsubscribe";

export interface RecordEventInput {
  contactId: number;
  campaignId?: number | null;
  sendId?: number | null;
  type: EventType;
  url?: string | null;
}

export async function recordEvent(input: RecordEventInput) {
  const [row] = await db
    .insert(events)
    .values({
      contactId: input.contactId,
      campaignId: input.campaignId ?? null,
      sendId: input.sendId ?? null,
      type: input.type,
      url: input.url ?? null,
    })
    .returning();
  return row;
}
