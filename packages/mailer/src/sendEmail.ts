import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { sesClient } from "./sesClient.js";

export interface SendEmailInput {
  to: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  html: string;
  headers?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  messageId: string;
}

/** True when SES actually received and answered the request (even with an
 * error) — the AWS SDK v3 attaches `$metadata.httpStatusCode` to every error
 * that came back as a real HTTP response (throttling, validation, a rejected
 * address, etc.), which only happens once SES has genuinely processed the
 * request one way or the other. A network-level failure (timeout, connection
 * reset) throws *before* any response completes, so it never gets this
 * metadata — that's the case where SES may have already accepted and queued
 * the email even though the caller never found out, making it unsafe to
 * treat as "definitely never sent" and retry. */
export function sesDefinitelyRejected(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("$metadata" in err)) return false;
  const metadata = (err as { $metadata?: unknown }).$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    typeof (metadata as { httpStatusCode?: unknown }).httpStatusCode === "number"
  );
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const command = new SendEmailCommand({
    FromEmailAddress: `${input.fromName} <${input.fromEmail}>`,
    Destination: { ToAddresses: [input.to] },
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: { Html: { Data: input.html, Charset: "UTF-8" } },
        Headers: input.headers?.map((h) => ({ Name: h.name, Value: h.value })),
      },
    },
  });

  const response = await sesClient.send(command);
  if (!response.MessageId) {
    throw new Error("SES did not return a MessageId");
  }
  return { messageId: response.MessageId };
}
