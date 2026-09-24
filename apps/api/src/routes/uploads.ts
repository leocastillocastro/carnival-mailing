import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

// Shared with apps/admin, which is the one that writes these files —
// apps/admin is LAN-only, so this app is what actually serves them to an
// email client opened outside the network.
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../uploads");

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Filenames are always our own randomUUID()+extension (see apps/admin's
// uploadsRoutes) — reject anything else so this can't double as a path-
// traversal-style file reader for the rest of the filesystem.
const SAFE_FILENAME = /^[a-f0-9-]+\.(jpg|jpeg|png|webp|gif)$/i;

export async function uploadsRoutes(app: FastifyInstance) {
  app.get<{ Params: { filename: string } }>("/uploads/:filename", async (request, reply) => {
    const { filename } = request.params;
    if (!SAFE_FILENAME.test(filename)) {
      reply.code(404).send();
      return;
    }
    const filePath = path.join(uploadsDir, filename);
    try {
      await stat(filePath);
    } catch {
      reply.code(404).send();
      return;
    }
    reply.type(CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(filePath));
  });
}
