import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

// Brand fonts (Autography, Sans Merci, etc.) from the client's identity kit —
// used both by apps/admin's block editor (so text previews in the real font)
// and by real sent emails (for the email clients that honor @font-face at
// all; most fall back to the font stack's next entry, which is expected).
const fontsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../fonts");

const CONTENT_TYPES: Record<string, string> = {
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Filenames are our own fixed set (see apps/api/fonts/), so this is a strict
// allowlist rather than an attempt to sanitize arbitrary input.
const SAFE_FILENAME = /^[a-z0-9-]+\.(otf|ttf|woff2?)$/i;

export async function fontsRoutes(app: FastifyInstance) {
  app.get<{ Params: { filename: string } }>("/fonts/:filename", async (request, reply) => {
    const { filename } = request.params;
    const ext = path.extname(filename).toLowerCase();
    if (!SAFE_FILENAME.test(filename) || !CONTENT_TYPES[ext]) {
      reply.code(404).send();
      return;
    }
    const filePath = path.join(fontsDir, filename);
    try {
      await stat(filePath);
    } catch {
      reply.code(404).send();
      return;
    }
    reply.type(CONTENT_TYPES[ext]);
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(filePath));
  });
}
