import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Shared with apps/api, which is the one that actually serves these files
// publicly — apps/admin is deliberately LAN-only, so an email opened outside
// the network could never load an image from its own address.
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../uploads");

interface WpMediaItem {
  id: number;
  title: { rendered: string };
  source_url: string;
  media_details?: { sizes?: Record<string, { source_url: string }> };
}

export async function uploadsRoutes(app: FastifyInstance) {
  // Consumed by apps/admin/public/template-editor.js's asset manager (both
  // the "upload a new file" and "browse the site's existing gallery" tabs).
  // Proxies WordPress's own public media library (no auth required there)
  // instead of fetching it client-side — the WP REST API doesn't send
  // Access-Control-Allow-Origin, so a browser-side fetch from this app's
  // origin would just be blocked by CORS.
  app.get<{ Querystring: { page?: string } }>("/uploads/gallery", async (request, reply) => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const wpUrl = new URL("/wp-json/wp/v2/media", env.WORDPRESS_URL);
    wpUrl.searchParams.set("page", String(page));
    // 100 is the WordPress REST API's own hard cap on per_page.
    wpUrl.searchParams.set("per_page", "100");
    wpUrl.searchParams.set("media_type", "image");
    wpUrl.searchParams.set("orderby", "date");
    wpUrl.searchParams.set("_fields", "id,title,source_url,media_details");

    const wpRes = await fetch(wpUrl);
    if (!wpRes.ok) {
      // WordPress answers a page number past the last one with 400, not an
      // empty array — that means "no more results", not a real failure.
      if (wpRes.status === 400) {
        reply.send({ items: [], hasMore: false });
        return;
      }
      reply.code(502).send({ error: "No se pudo cargar la galería de la web" });
      return;
    }

    const items = (await wpRes.json()) as WpMediaItem[];
    const totalPages = Number(wpRes.headers.get("x-wp-totalpages") ?? "1");
    reply.send({
      items: items.map((item) => ({
        id: item.id,
        title: item.title.rendered,
        thumbnailUrl: item.media_details?.sizes?.thumbnail?.source_url ?? item.source_url,
        url: item.media_details?.sizes?.large?.source_url ?? item.source_url,
      })),
      hasMore: page < totalPages,
    });
  });

  app.post("/uploads", async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_FILE_SIZE } });
    if (!file) {
      reply.code(400).send({ error: "No se recibió ningún archivo" });
      return;
    }

    const ext = ALLOWED_MIME_TYPES[file.mimetype];
    if (!ext) {
      reply.code(400).send({ error: "Tipo de archivo no permitido — usá JPG, PNG, WEBP o GIF" });
      return;
    }

    const buffer = await file.toBuffer();
    if (file.file.truncated) {
      reply.code(400).send({ error: "La imagen pesa más de 5MB" });
      return;
    }

    const filename = `${randomUUID()}.${ext}`;
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, filename), buffer);

    reply.send({ url: `${env.UPLOADS_PUBLIC_URL}/uploads/${filename}` });
  });
}
