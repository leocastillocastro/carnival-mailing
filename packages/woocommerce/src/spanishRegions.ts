// Spain's postal codes are assigned by province, and the first two digits are
// the province's own fixed numeric code (01-52) — a much more reliable way to
// derive "comunidad autónoma" than matching free-text city names, which are
// typed inconsistently (see normalizeCityName) and would need an exhaustive,
// error-prone town-name gazetteer instead of this fixed 52-entry table.
const PROVINCE_PREFIX_TO_COMUNIDAD: Record<string, string> = {
  "01": "País Vasco",
  "02": "Castilla-La Mancha",
  "03": "Comunidad Valenciana",
  "04": "Andalucía",
  "05": "Castilla y León",
  "06": "Extremadura",
  "07": "Illes Balears",
  "08": "Cataluña",
  "09": "Castilla y León",
  "10": "Extremadura",
  "11": "Andalucía",
  "12": "Comunidad Valenciana",
  "13": "Castilla-La Mancha",
  "14": "Andalucía",
  "15": "Galicia",
  "16": "Castilla-La Mancha",
  "17": "Cataluña",
  "18": "Andalucía",
  "19": "Castilla-La Mancha",
  "20": "País Vasco",
  "21": "Andalucía",
  "22": "Aragón",
  "23": "Andalucía",
  "24": "Castilla y León",
  "25": "Cataluña",
  "26": "La Rioja",
  "27": "Galicia",
  "28": "Comunidad de Madrid",
  "29": "Andalucía",
  "30": "Región de Murcia",
  "31": "Comunidad Foral de Navarra",
  "32": "Galicia",
  "33": "Principado de Asturias",
  "34": "Castilla y León",
  "35": "Canarias",
  "36": "Galicia",
  "37": "Castilla y León",
  "38": "Canarias",
  "39": "Cantabria",
  "40": "Castilla y León",
  "41": "Andalucía",
  "42": "Castilla y León",
  "43": "Cataluña",
  "44": "Aragón",
  "45": "Castilla-La Mancha",
  "46": "Comunidad Valenciana",
  "47": "Castilla y León",
  "48": "País Vasco",
  "49": "Castilla y León",
  "50": "Aragón",
  "51": "Ceuta",
  "52": "Melilla",
};

// Returns null for anything that isn't a plausible Spanish postcode (missing,
// too short, non-numeric prefix, or an out-of-range province code) rather
// than guessing — a wrong region is worse than no region for segmentation.
export function comunidadAutonomaFromPostcode(postcode: string | undefined | null): string | null {
  if (!postcode) return null;
  const prefix = postcode.trim().slice(0, 2);
  if (!/^\d{2}$/.test(prefix)) return null;
  return PROVINCE_PREFIX_TO_COMUNIDAD[prefix] ?? null;
}
