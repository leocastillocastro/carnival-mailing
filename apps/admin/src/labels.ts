// Spanish labels for the raw Postgres enum values shown in views — without
// this, campaign/send status and list optin type render as the literal
// English enum tokens ("sending", "bounced", "double") straight from the DB.

const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  scheduled: "Programada",
  sending: "Enviando",
  sent: "Enviada",
  paused: "Pausada",
};

const SEND_STATUS_LABELS: Record<string, string> = {
  queued: "En cola",
  sending: "Enviando",
  sent: "Enviado",
  failed: "Fallido",
  bounced: "Rebotado",
  suppressed: "Suprimido",
  complained: "Marcó como spam",
};

const LIST_OPTIN_LABELS: Record<string, string> = {
  single: "Simple",
  double: "Doble",
};

const CONTACT_STATUS_LABELS: Record<string, string> = {
  subscribed: "Suscrito",
  unsubscribed: "Dado de baja",
  bounced: "Rebotado",
  complained: "Marcó como spam",
};

// Kept in sync by hand with campaign-content-fields.js's own FIELD_LABELS —
// that one renders the field's own input label in the browser; this one
// names the same field in the "Completá estos campos" server-side error
// message, which used to show the raw {{campaign.*}} tag name instead
// (e.g. "precio" was fine, but "diferenciador" or "condiciones" read as
// jargon to someone who's never seen the template's merge tags).
const CAMPAIGN_FIELD_LABELS: Record<string, string> = {
  eyebrow: "Categoría / línea superior",
  titulo: "Título",
  precio: "Precio",
  preheader: "Vista previa en la bandeja de entrada (preheader)",
  imagen: "Foto del producto",
  texto: "Texto de la promo",
  condiciones: "Condiciones / vigencia",
  descuento: "Descuento (%)",
  diferenciador: "Qué te hace distinto",
  incentivo: "Incentivo para venir a la tienda",
};

export function campaignStatusLabel(status: string): string {
  return CAMPAIGN_STATUS_LABELS[status] ?? status;
}

export function sendStatusLabel(status: string): string {
  return SEND_STATUS_LABELS[status] ?? status;
}

export function listOptinLabel(optin: string): string {
  return LIST_OPTIN_LABELS[optin] ?? optin;
}

export function contactStatusLabel(status: string): string {
  return CONTACT_STATUS_LABELS[status] ?? status;
}

export function campaignFieldLabel(name: string): string {
  return CAMPAIGN_FIELD_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}
