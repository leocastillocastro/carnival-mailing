import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

// Same shared fonts/ directory apps/api serves publicly. This copy exists so
// the block editor's canvas can load them same-origin — the public domain
// (mailing.example.com) can't be reached from this same LAN/host due
// to the router's lack of NAT hairpinning, which would otherwise break the
// live font preview for anyone editing from the same network as the server.
const fontsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../fonts");

const CONTENT_TYPES: Record<string, string> = {
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

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
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(filePath));
  });
}
