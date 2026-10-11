/**
 * measureMath.ts — reading "1.5 cup" / "2 tbsp" / "1 large" as grams, and writing grams back as "≈ ¾ cup".
 *
 * What this file does: the Nutrients page lets her type a meal amount in
 * household measures instead of grams (AmountInput.tsx), and shows "What to
 * add" amounts in cups and spoons beside the grams (MealPrepPlan.tsx). The
 * weight of one cup, tablespoon, egg… of each food comes from the server
 * (measures.py: USDA's portion weights, with missing spoons worked out by
 * NIST's kitchen volumes); this file only does the reading and the rounding.
 *
 * Prompt that produced this file: "be able to estimate amounts by cups and
 * tablespoons and convert them to grams" — built as both: typing, and showing.
 */
import type { Measure } from './types';

export type ParsedAmount =
  | { grams: number; measure?: Measure; quantity: number; text: string }
  | { error: string };

// The unicode fractions a phone keyboard or a recipe might hand over.
const GLYPHS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

// Every way of writing a unit, folded to the key measures.py uses.
const UNIT_ALIASES: Record<string, string> = {
  c: 'cup', cup: 'cup', cups: 'cup',
  t: 'tsp', tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  T: 'tbsp', tbsp: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  floz: 'floz', 'fl oz': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',
  g: 'g', gram: 'g', grams: 'g', gr: 'g',
};

/** Read the number at the front: "1 1/2", "1/2", "1.5", "1½", "½". Returns [quantity, the rest] or null. */
export function readQuantity(text: string): [number, string] | null {
  const mixed = text.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)\s*(.*)$/s);
  if (mixed && Number(mixed[3])) return [Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]), mixed[4]];
  const fraction = text.match(/^(\d+)\s*\/\s*(\d+)\s*(.*)$/s);
  if (fraction && Number(fraction[2])) return [Number(fraction[1]) / Number(fraction[2]), fraction[3]];
  const decimal = text.match(/^(\d+(?:\.\d*)?|\.\d+)?\s*([½¼¾⅓⅔⅛])?\s*(.*)$/s);
  if (decimal && (decimal[1] || decimal[2])) {
    return [(decimal[1] ? Number(decimal[1]) : 0) + (decimal[2] ? GLYPHS[decimal[2]] : 0), decimal[3]];
  }
  return null;
}

/** The unit key for the words after the number: "Tbsp" -> "tbsp", "cloves" -> "clove", "" -> "g". */
export function unitKey(words: string): string {
  const trimmed = words.trim().replace(/\.$/, '');
  if (!trimmed) return 'g';
  // A lone capital T is a tablespoon and a lone t a teaspoon, as in recipes; everything else ignores case.
  if (trimmed === 'T' || trimmed === 't') return UNIT_ALIASES[trimmed];
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('fl oz') || lower.startsWith('fluid ounce')) return 'floz';
  const first = lower.split(/[\s,]+/)[0];
  if (first in UNIT_ALIASES) return UNIT_ALIASES[first];
  return first.length > 3 && first.endsWith('s') ? first.slice(0, -1) : first;
}

/**
 * Turn what she typed into grams, using this food's measures.
 *
 * Plain numbers and "g" are grams. Any other unit must be one USDA (or NIST,
 * from USDA's) gives for this food; when a food has two cups ("cup, whole" and
 * "cup, sliced"), extra words pick one ("1 cup sliced"), otherwise the first
 * USDA lists is used.
 */
export function parseAmount(text: string, measures: Measure[] | undefined): ParsedAmount {
  const cleaned = text.trim();
  const read = readQuantity(cleaned);
  if (!read) return { error: 'Start with a number: 150, 1.5 cup, 2 tbsp, ½ cup.' };
  const [quantity, rest] = read;
  const key = unitKey(rest);
  if (key === 'g') return { grams: round(quantity), quantity, text: cleaned };
  const options = (measures ?? []).filter((measure) => measure.unit === key);
  if (!options.length) {
    const known = [...new Set((measures ?? []).map((measure) => measure.unit))];
    return {
      error: measures
        ? `USDA gives no ${rest.trim()} for this food.${known.length ? ` Try ${known.map(unitName).join(', ')}, or grams.` : ' Grams only.'}`
        : 'Still loading this food’s measures — try again in a moment, or type grams.',
    };
  }
  // Extra words after the unit ("cup sliced") choose between two cups of the same food.
  const extra = rest.trim().toLowerCase().split(/[\s,]+/).slice(1).filter(Boolean);
  const measure = options.find((option) => extra.length && extra.every((word) => option.label.includes(word))) ?? options[0];
  return { grams: round(quantity * measure.grams), measure, quantity, text: cleaned };
}

/** A unit key as a person writes it: 'floz' -> 'fl oz'. */
export function unitName(key: string): string {
  return key === 'floz' ? 'fl oz' : key;
}

/** A quantity to the nearest quarter, written with fraction glyphs: 0.75 -> "¾", 1.5 -> "1½". */
export function formatQuarters(quantity: number): string {
  const quarters = Math.round(quantity * 4);
  const whole = Math.floor(quarters / 4);
  const part = ['', '¼', '½', '¾'][quarters % 4];
  return whole ? `${whole}${part}` : part || '0';
}

/**
 * Grams written as a kitchen measure: "¾ cup", "2½ tbsp", "2 large", or null.
 *
 * Cups when there's at least a quarter cup, tablespoons down to half of one,
 * then teaspoons; a food with no cup or spoon uses its first USDA count
 * measure ("1 large" egg). Rounded to the nearest quarter, so it's an
 * estimate for a measuring cup, never a replacement for the grams.
 */
export function toHousehold(grams: number, measures: Measure[] | undefined): { text: string; measure: Measure } | null {
  if (!measures || grams <= 0) return null;
  const find = (unit: string) => measures.find((measure) => measure.unit === unit);
  const cup = find('cup');
  const tbsp = find('tbsp');
  const tsp = find('tsp');
  // Pick the biggest volume that still reads as a sensible amount.
  if (cup && grams / cup.grams >= 0.25) return { text: `${formatQuarters(grams / cup.grams)} cup`, measure: cup };
  if (tbsp && grams / tbsp.grams >= 0.5) return { text: `${formatQuarters(grams / tbsp.grams)} tbsp`, measure: tbsp };
  if (tsp && grams / tsp.grams >= 0.25) return { text: `${formatQuarters(grams / tsp.grams)} tsp`, measure: tsp };
  // No volume at all: a count, like eggs or cloves, when USDA gives one.
  const count = measures.find((measure) => measure.kind === 'usda' && !['cup', 'tbsp', 'tsp', 'floz', 'oz'].includes(measure.unit));
  if (count && grams / count.grams >= 0.25) return { text: `${formatQuarters(grams / count.grams)} ${count.unit}`, measure: count };
  return null;
}

function round(grams: number): number {
  return Math.round(grams * 10) / 10;
}
