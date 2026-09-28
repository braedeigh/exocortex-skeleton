/**
 * statementMerchant.ts — reads the merchant out of one raw bank-statement line.
 *
 * A Bank of America line wraps the merchant in noise: a card processor's prefix
 * ("TST*", "SQ *"), the purchase date, "MOBILE PURCHASE", the city, store and
 * confirmation numbers, or for bank transfers a whole ACH block ("DES:… ID:…
 * INDN:… CO ID:…"). This finds the merchant inside and returns two things:
 *
 *   - `name` — a readable guess at what the thing is ("Cosmic Coffee", "Uber"),
 *     which the statement preview offers in its "What is it?" box;
 *   - `key`  — the lowercase stretch of the line that identifies the merchant,
 *     used as the match for learned rules. It is always a piece of the line
 *     exactly as the bank wrote it, because the server matches a rule by
 *     checking whether its key appears inside the line.
 *
 * The statement's counterpart of the receipt scanner's suggestCatalogName
 * (kitchen/receiptHelpers.ts). Used by csvImport.ts.
 * Prompt: "i want to be able to identify things from a statement similar to
 * how i identify objects from the receipt scanner."
 */

export interface StatementMerchant {
  key: string;
  name: string;
}

/** Card processors that put their own tag in front of the merchant. */
const PROCESSOR_PREFIX = /^(?:tst\* ?|sq \*|sqsp\* ?|py \*|psp\*|pyl\*|ic\* ?|pl\*|paypal \*|dd \*|sp \*)/;

/** Payment apps whose ACH line names the real payee in its ID: field. */
const PAYMENT_APPS = new Set(['paypal', 'venmo', 'cash app']);

export function readStatementMerchant(desc: string): StatementMerchant {
  const lower = (desc || '').toLowerCase().trim();
  if (!lower) return { key: '', name: '' };

  // Zelle: the person after "to"/"from" is who it is; the key keeps the whole
  // "zelle payment to …" phrase so it only ever matches that person's Zelles.
  const zelle = /^(zelle payment (?:to|from) )(.+?)(?= conf|$)/.exec(lower);
  if (zelle) {
    return { key: zelle[0].trim(), name: titleCase(zelle[2]) };
  }

  // Bank transfers (ACH): the payer/payee sits before " des:". PayPal and Venmo
  // put the real merchant in "id:" when it's a word ("id:uber"), not a number.
  const achAt = lower.indexOf(' des:');
  if (achAt > 0) {
    const payer = lower.slice(0, achAt).trim();
    const idWord = /\bid:([a-z][a-z .&'-]*?) +indn:/.exec(lower);
    if (PAYMENT_APPS.has(payer) && idWord) {
      return { key: `id:${idWord[1]}`, name: titleCase(idWord[1]) };
    }
    return finish(stripPrefix(payer), lower);
  }

  // Card purchases: the merchant ends where the date, a confirmation number,
  // or "purchase" begins.
  const cut = lower.search(/ \d\d\/\d\d\b| conf(?:irmation)?#| (?:mobile )?purchase\b/);
  let core = cut > 0 ? lower.slice(0, cut) : lower;

  // Peel off the noise around the name, working inward from both ends:
  // processor prefix, an order code after "*" ("amazon mktpl*eb9hf1in3"), a
  // store number after "#", and a cut-off location after " - " ("cosmic coffee - eas").
  core = stripPrefix(core);
  core = core.replace(/\* ?\S*\d.*$/, '');
  core = core.replace(/ ?#.*$/, '');
  core = core.replace(/ - .*$/, '');

  // Drop store numbers from both ends: trailing words that carry a digit
  // ("shell oil 57544800006", "spotify p421e56497") and leading all-number
  // words ("064 torchys"), keeping at least one word so "7-eleven" survives.
  const words = core.split(' ').filter(Boolean);
  while (words.length > 1 && /\d/.test(words[words.length - 1])) words.pop();
  while (words.length > 1 && /^[\d.#-]+$/.test(words[0])) words.shift();
  return finish(words.join(' '), lower);
}

function stripPrefix(text: string): string {
  return text.replace(PROCESSOR_PREFIX, '');
}

/** Tidy the ends, and fall back to the line's first two words when too little
 * is left to be a safe key (a 1–2 letter key would match half the statement). */
function finish(core: string, lower: string): StatementMerchant {
  const key = core.replace(/^[\s*.,-]+|[\s*.,-]+$/g, '');
  if (key.length >= 3) return { key, name: titleCase(key) };
  const fallback = lower.split(/\s+/).slice(0, 2).join(' ');
  return { key: fallback, name: titleCase(fallback) };
}

/** Capitalize each word, and each part of a hyphenated one ("h-e-b" → "H-E-B"). */
function titleCase(text: string): string {
  return text.trim().replace(/(^|[\s\-/*])([a-z])/g, (_match, before: string, letter: string) => before + letter.toUpperCase());
}
