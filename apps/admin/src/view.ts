import path from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { env } from "./env.js";

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../views");

const eta = new Eta({ views: viewsDir, cache: env.NODE_ENV === "production" });

export interface PageData {
  title: string;
  activeNav?: string;
  flash?: string | null;
  [key: string]: unknown;
}

/** Renders `view` inside `layout.eta`. The inner view's output is trusted HTML
 * (Eta already auto-escapes any interpolated values inside it) and gets
 * injected raw into the layout — nothing user-controlled ever reaches the
 * layout render step directly. */
export function renderPage(view: string, data: PageData): string {
  const body = eta.render(`./${view}`, data) as string;
  return eta.render("./layout", { ...data, body }) as string;
}

/** For embedding data inside `<script type="application/json">…</script>`.
 * JSON.stringify doesn't escape `<`, so a stored value containing the literal
 * string `</script>` could otherwise terminate the tag early and inject
 * arbitrary markup — replacing `<` with its unicode escape keeps the JSON
 * valid (JSON.parse decodes `<` back to `<`) while making that
 * breakout impossible. */
export function toEmbeddableJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
