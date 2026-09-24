import Handlebars from "handlebars";

export interface ContactData {
  firstName: string | null;
  lastName: string | null;
  email: string;
  attributes: Record<string, unknown>;
}

export interface TemplateData {
  contact: ContactData;
  unsubscribeUrl: string;
  /** Per-campaign content — the promo title, price, dates, etc. a template
   * author leaves as a variable slot (`{{campaign.titulo}}`) instead of
   * hardcoding, so the same template can be reused for a new promotion
   * without editing HTML. Distinct from `contact`, which varies per
   * recipient, not per send. Defaults to `{}` so a template preview with no
   * campaign context yet still renders (a missing field renders blank, same
   * as a missing contact attribute). */
  campaign?: Record<string, string>;
}

// A dedicated instance with no custom helpers registered — templates only get
// Handlebars' built-ins (#if/#unless/#each/#with), never arbitrary JS. Listmonk's
// docs flag its unsandboxed Go templates as a real risk requiring trusted authors
// only; since these templates may eventually be edited by a non-developer, we
// avoid that exposure instead of retrofitting a sandbox later.
const handlebars = Handlebars.create();

/** GrapesJS's merge-tag blocks are inserted as editable text — selecting just
 * part of a tag (e.g. only "campaign" inside {{campaign.titulo}}) and applying
 * bold/color from the Style Manager can split it across an HTML tag boundary
 * (`<b>{{campaign</b>.titulo}}`), which Handlebars.parse rejects as invalid
 * syntax. Every other check in this file gives a specific, actionable Spanish
 * message; a bare Handlebars.Exception (a technical, English "Parse error on
 * line N" with no mention of a merge tag at all) would be the one confusing
 * exception to that, so every Handlebars.parse call in this module goes
 * through here instead of calling it directly. */
function parseHandlebarsOrThrowFriendly(html: string): hbs.AST.Program {
  try {
    return Handlebars.parse(html);
  } catch (err) {
    throw new Error(
      `El template tiene una variable {{...}} rota o incompleta — a veces pasa al aplicarle negrita/color a una variable en el editor visual, partiéndola en dos. Revisá que cada {{...}} esté completo y sin formato aplicado por dentro. (Detalle técnico: ${(err as Error).message})`,
    );
  }
}

/** Walks the parsed template looking for `{{{expr}}}`/`{{&expr}}` — Handlebars'
 * raw/unescaped output forms — which `noEscape` doesn't touch (that flag turns
 * escaping off for *everything*, the opposite of what's needed). Left enabled,
 * either form would let contact-controlled data (a WooCommerce billing name,
 * a custom attribute) inject raw HTML/script into an outgoing email, defeating
 * the whole reason this package avoids a full templating language. */
class RawOutputDetector extends Handlebars.Visitor {
  foundRawOutput = false;

  override MustacheStatement(mustache: hbs.AST.MustacheStatement): void {
    if (mustache.escaped === false) this.foundRawOutput = true;
    super.MustacheStatement(mustache);
  }
}

export function assertNoRawOutput(html: string): void {
  const detector = new RawOutputDetector();
  detector.accept(parseHandlebarsOrThrowFriendly(html));
  if (detector.foundRawOutput) {
    throw new Error(
      "El template usa salida sin escapar ({{{...}}} o {{&...}}), no permitida por seguridad — usá {{...}} (dos llaves).",
    );
  }
}

const KNOWN_EXACT_PATHS = new Set([
  "contact.firstName",
  "contact.lastName",
  "contact.email",
  "contact.attributes",
  // Bare "campaign" (e.g. {{#each campaign}}), same allowance already given
  // to bare "contact.attributes" above — both are dynamic, per-template
  // objects whose keys aren't known in advance.
  "campaign",
  "unsubscribeUrl",
]);

function isKnownMergeTagPath(original: string): boolean {
  return (
    KNOWN_EXACT_PATHS.has(original) ||
    original.startsWith("contact.attributes.") ||
    original.startsWith("campaign.")
  );
}

/** Walks the parsed template collecting every data reference — `{{path}}` and
 * `{{#if path}}`/`{{#unless path}}` conditions — and checks each against the
 * known fields this app actually supports. `renderTemplate` compiles with
 * `strict: false` (a contact legitimately missing an attribute must render
 * blank, not throw), which means a *misspelled* field (`{{contact.FirstName}}`)
 * silently renders blank too, identically to a correct-but-empty one — with no
 * way to tell them apart at send time. This catches the typo at save time
 * instead, before it ever reaches a real contact's inbox. Deliberately static
 * (checking the path itself, not rendering against sample data): rendering
 * against an "empty attributes" sample contact would flag `contact.attributes.city`
 * as "resolves empty" even though that's a real, valid field that's simply
 * blank for many real contacts — a false positive this approach avoids. */
class UnknownPathDetector extends Handlebars.Visitor {
  unknownPaths: string[] = [];

  private check(path: hbs.AST.Expression): void {
    if (path.type !== "PathExpression") return;
    const expr = path as hbs.AST.PathExpression;
    if (expr.data || expr.original === "this" || expr.original === ".") return;
    if (!isKnownMergeTagPath(expr.original)) this.unknownPaths.push(expr.original);
  }

  override MustacheStatement(mustache: hbs.AST.MustacheStatement): void {
    this.check(mustache.path);
    super.MustacheStatement(mustache);
  }

  override BlockStatement(block: hbs.AST.BlockStatement): void {
    for (const param of block.params) this.check(param);
    super.BlockStatement(block);
  }
}

export function assertKnownMergeTags(html: string): void {
  const detector = new UnknownPathDetector();
  detector.accept(parseHandlebarsOrThrowFriendly(html));
  if (detector.unknownPaths.length > 0) {
    const tags = [...new Set(detector.unknownPaths)].map((path) => `{{${path}}}`).join(", ");
    throw new Error(
      `El template usa un campo desconocido: ${tags} — los campos disponibles son {{contact.firstName}}, {{contact.lastName}}, {{contact.email}}, {{contact.attributes.*}}, {{campaign.*}} (cualquier nombre — se completa al armar la campaña) y {{unsubscribeUrl}}.`,
    );
  }
}

// Matches the bracket-placeholder convention already used across every real
// template ("[Ej: contale brevemente qué te hace distinto...]", "[DESCUENTO]%",
// "[PRECIO] € / kg") — instructional text left in place of the real copy.
const PLACEHOLDER_PATTERN = /\[[^[\]\n]{1,200}\]/g;

// Square brackets DO show up in valid email HTML outside of real placeholder
// text: Outlook conditional comments ("<!--[if mso]-->...<!--[endif]-->", a
// standard technique for Outlook-only fixes) and CSS attribute selectors
// ("a[href^=\"tel:\"]", a common hack to stop iOS/Gmail auto-linking phone
// numbers). Stripping comments and <style> blocks before scanning means a
// future template using either doesn't get blocked as "unfinished" — the
// placeholder text this check actually cares about only ever lives in the
// visible body content, never inside a comment or a stylesheet.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const STYLE_BLOCK_RE = /<style[^>]*>[\s\S]*?<\/style>/gi;

export function assertNoUnresolvedPlaceholders(html: string): void {
  const visibleContent = html.replace(HTML_COMMENT_RE, "").replace(STYLE_BLOCK_RE, "");
  const matches = [...visibleContent.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[0]);
  if (matches.length > 0) {
    const list = [...new Set(matches)].join(", ");
    throw new Error(
      `El template todavía tiene texto de relleno sin completar: ${list} — reemplazalo por el contenido real antes de guardar.`,
    );
  }
}

/** Walks the parsed template collecting every distinct `{{campaign.*}}` field
 * name it references (in declaration order) — how the campaign form knows
 * which fields to show for whichever template is selected, without either
 * side hardcoding a fixed list. A template author adds a new field just by
 * using a new `{{campaign.whatever}}` tag; no schema change needed. */
class CampaignFieldCollector extends Handlebars.Visitor {
  fields: string[] = [];

  private check(path: hbs.AST.Expression): void {
    if (path.type !== "PathExpression") return;
    const expr = path as hbs.AST.PathExpression;
    if (expr.data || !expr.original.startsWith("campaign.")) return;
    const field = expr.original.slice("campaign.".length);
    if (field && !this.fields.includes(field)) this.fields.push(field);
  }

  override MustacheStatement(mustache: hbs.AST.MustacheStatement): void {
    this.check(mustache.path);
    super.MustacheStatement(mustache);
  }

  override BlockStatement(block: hbs.AST.BlockStatement): void {
    for (const param of block.params) this.check(param);
    super.BlockStatement(block);
  }
}

export function extractCampaignFieldNames(html: string): string[] {
  const collector = new CampaignFieldCollector();
  collector.accept(parseHandlebarsOrThrowFriendly(html));
  return collector.fields;
}

export function renderTemplate(html: string, data: TemplateData): string {
  assertNoRawOutput(html);
  assertKnownMergeTags(html);
  assertNoUnresolvedPlaceholders(html);
  const compiled = handlebars.compile(html, { strict: false });
  return compiled(data);
}
