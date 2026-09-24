import { parseRuleGroup, type Condition, type RuleGroup } from "./types.js";

export type SegmentCategory =
  | "Audiencia general"
  | "Actividad de compra"
  | "Antigüedad de suscripción"
  | "Método de entrega"
  | "Ubicación del contacto"
  | "Otros";

/** Front-to-back order for grouping segments in any picker (the campaign
 * form's "elegí un segmento" select) — broadest audience first, narrowest
 * slice last, so whoever's about to send a campaign scans from "everyone"
 * down instead of an alphabetical shuffle that puts "Todos" last and groups
 * unrelated segments side by side. */
export const SEGMENT_CATEGORY_ORDER: SegmentCategory[] = [
  "Audiencia general",
  "Actividad de compra",
  "Antigüedad de suscripción",
  "Método de entrega",
  "Ubicación del contacto",
  "Otros",
];

function conditionCategory(condition: Condition): SegmentCategory | null {
  switch (condition.kind) {
    case "contact_field":
      return condition.field === "createdAt" ? "Antigüedad de suscripción" : "Audiencia general";
    case "order_exists":
      return condition.shippingMethod ? "Método de entrega" : "Actividad de compra";
    case "event_exists":
      return "Actividad de compra";
    case "contact_attribute":
      return "Ubicación del contacto";
    case "list_membership":
      return "Audiencia general";
    default:
      return null;
  }
}

/** Picks one category for a whole segment from the categories of its
 * conditions (walking nested groups too, since a RuleGroup's own conditions
 * can themselves be groups) — when a segment mixes condition kinds that map
 * to different categories, the most specific one (last in
 * SEGMENT_CATEGORY_ORDER) wins, since that's the one that actually narrows
 * who ends up on the list. No real segment mixes categories today, but a
 * segment built later might. */
export function categorizeSegment(rule: RuleGroup): SegmentCategory {
  const found = new Set<SegmentCategory>();
  function walk(node: Condition | RuleGroup): void {
    if ("conditions" in node) {
      node.conditions.forEach(walk);
      return;
    }
    const category = conditionCategory(node);
    if (category) found.add(category);
  }
  walk(rule);

  for (let i = SEGMENT_CATEGORY_ORDER.length - 1; i >= 0; i--) {
    if (found.has(SEGMENT_CATEGORY_ORDER[i])) return SEGMENT_CATEGORY_ORDER[i];
  }
  return "Otros";
}

export interface SegmentOption {
  id: number;
  name: string;
}

export interface SegmentOptionGroup {
  category: SegmentCategory;
  segments: SegmentOption[];
}

/** Groups segments for display in a picker, ordered by category
 * (SEGMENT_CATEGORY_ORDER) and alphabetically by name within each category.
 * A segment whose stored definition no longer parses (hand-edited row, a
 * future schema change) falls back to "Otros" instead of breaking the whole
 * picker — the campaign form has to render either way. */
export function groupSegmentsForPicker(
  segments: { id: number; name: string; definition: unknown }[],
): SegmentOptionGroup[] {
  const byCategory = new Map<SegmentCategory, SegmentOption[]>();
  for (const segment of segments) {
    let category: SegmentCategory = "Otros";
    try {
      category = categorizeSegment(parseRuleGroup(segment.definition));
    } catch {
      // keep "Otros"
    }
    const bucket = byCategory.get(category) ?? [];
    bucket.push({ id: segment.id, name: segment.name });
    byCategory.set(category, bucket);
  }

  return SEGMENT_CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
    category,
    segments: byCategory.get(category)!.sort((a, b) => a.name.localeCompare(b.name, "es")),
  }));
}
