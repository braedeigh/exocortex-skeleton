/**
 * syntax.ts — syntax colouring for the code the terrain shows (FileCodeBody):
 * keywords, strings, comments, numbers, names, each in its own colour, so the
 * shape of a file reads at a glance the way it does in an editor.
 *
 * The tokens come from Shiki, which runs the same TextMate grammars VS Code
 * does. The COLOURS do not: a stock editor theme is a fixed set of hexes that
 * would clash with the lavender/indigo skies and lean on red, and red is the
 * map's edit ramp. So the "theme" handed to Shiki is a set of placeholder
 * colours that mean ROLES (keyword, string, comment…), `roleForColor` turns
 * each token's placeholder back into its role, and FileCodeBody.module.css
 * paints the role from the app's own runtime variables — accent, evening,
 * ongoing, the text tones — so the sky engine keeps driving the code's
 * colours through sunrise and sunset like everything else. No red, no
 * orange, no gold: those channels are spoken for elsewhere.
 *
 * Nothing here is in the main bundle's critical path: Shiki's core, the
 * regex engine and each grammar are dynamic imports, fetched the first time
 * a file of that language opens and cached for the session. A language
 * without a grammar here (`langForPath` → null), a file too big to be worth
 * it, or a grammar that fails to load all fall back to plain text — the
 * pane never waits on colour to show the code.
 *
 * Prompt that produced it: "are there other color things i can do with the
 * code? like vscode probably has colors for different things? to make it
 * easier to read stuff" → syntax highlighting, comments distinct, colours
 * from the theme rather than a stock editor theme.
 */
import type { HighlighterCore, ThemedToken } from 'shiki/core';

/** The roles a token can wear — each is a class in FileCodeBody.module.css. */
export type SyntaxRole =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'property'
  | 'tag'
  | 'punctuation'
  | 'heading'
  | 'link';

export interface SyntaxToken {
  content: string;
  /** undefined = plain text in the default colour. */
  role?: SyntaxRole;
}

/** One entry per line, in file order; each line is its run of tokens. */
export type SyntaxLines = SyntaxToken[][];

/** Files bigger than this show plain — tokenizing a quarter-megabyte in the
 * browser is a stall, and nobody reads a file that size for its colours. */
export const SYNTAX_MAX_CHARS = 160_000;

// -- which grammar a path gets ----------------------------------------------

/** Grammar name by extension. Only what this codebase and the vault
 * actually contain; anything else is plain text. */
const LANG_BY_EXT: Record<string, string> = {
  py: 'python',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  css: 'css',
  json: 'json',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  html: 'html',
  sql: 'sql',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  ini: 'ini',
  cfg: 'ini',
  env: 'ini',
};

/** The grammar for a path, or null for plain text. Matches on the last
 * extension only — `.test.ts` is TypeScript, `.module.css` is CSS. */
export function langForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANG_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

// -- the placeholder theme ---------------------------------------------------

/** Placeholder hex per role. Shiki only needs them to be distinct; the real
 * colour is looked up by role in CSS. Near-black on purpose, so if one ever
 * leaked through unmapped it would read as ordinary ink, not a wrong hue. */
const ROLE_COLOR: Record<SyntaxRole, string> = {
  keyword: '#000001',
  string: '#000002',
  comment: '#000003',
  number: '#000004',
  function: '#000005',
  type: '#000006',
  property: '#000007',
  tag: '#000008',
  punctuation: '#000009',
  heading: '#00000a',
  link: '#00000b',
};

const COLOR_ROLE: Record<string, SyntaxRole> = Object.fromEntries(
  (Object.entries(ROLE_COLOR) as [SyntaxRole, string][]).map(([role, hex]) => [hex, role]),
);

/** A token's placeholder colour back to its role; undefined for plain. */
export function roleForColor(color: string | undefined): SyntaxRole | undefined {
  if (!color) return undefined;
  return COLOR_ROLE[color.toLowerCase().slice(0, 7)];
}

/**
 * TextMate scopes → roles. In a TextMate theme the most specific matching
 * scope wins, and among equals the LATER rule wins, which is why
 * `keyword.operator` (→ punctuation) sits after `keyword` (→ keyword), and a
 * Python docstring (a `string.quoted.docstring`) sits after `string` so it
 * reads as the comment it really is.
 */
const TOKEN_COLORS: { scope: string[]; settings: { foreground: string } }[] = [
  { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: ROLE_COLOR.comment } },
  {
    scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'variable.language'],
    settings: { foreground: ROLE_COLOR.keyword },
  },
  { scope: ['keyword.operator'], settings: { foreground: ROLE_COLOR.punctuation } },
  { scope: ['string', 'punctuation.definition.string', 'string.template'], settings: { foreground: ROLE_COLOR.string } },
  { scope: ['string.quoted.docstring'], settings: { foreground: ROLE_COLOR.comment } },
  {
    scope: ['constant.numeric', 'constant.language', 'keyword.other.unit', 'support.constant'],
    settings: { foreground: ROLE_COLOR.number },
  },
  {
    scope: [
      'entity.name.function',
      'support.function',
      'meta.function-call.generic',
      'meta.decorator',
      'entity.name.function.decorator',
      'punctuation.definition.decorator',
    ],
    settings: { foreground: ROLE_COLOR.function },
  },
  {
    scope: [
      'entity.name.type',
      'entity.name.class',
      'support.type',
      'support.class',
      'entity.other.inherited-class',
      'entity.other.attribute-name.class.css',
      'entity.other.attribute-name.id.css',
    ],
    settings: { foreground: ROLE_COLOR.type },
  },
  {
    scope: [
      'variable.other.property',
      'variable.other.object.property',
      'support.type.property-name',
      'entity.other.attribute-name',
      'meta.object-literal.key',
      'variable.other.normal.shell',
      'support.type.custom-property',
      'variable.css',
      'markup.raw',
      'markup.inline.raw',
    ],
    settings: { foreground: ROLE_COLOR.property },
  },
  { scope: ['entity.name.tag'], settings: { foreground: ROLE_COLOR.tag } },
  { scope: ['punctuation', 'meta.brace'], settings: { foreground: ROLE_COLOR.punctuation } },
  { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: ROLE_COLOR.heading } },
  { scope: ['markup.underline.link', 'string.other.link', 'constant.other.reference.link'], settings: { foreground: ROLE_COLOR.link } },
  { scope: ['markup.bold', 'markup.italic'], settings: { foreground: ROLE_COLOR.keyword } },
];

const THEME_NAME = 'exocortex-roles';

const THEME = {
  name: THEME_NAME,
  type: 'light' as const,
  colors: { 'editor.foreground': '#000000', 'editor.background': '#ffffff' },
  settings: [{ settings: { foreground: '#000000', background: '#ffffff' } }, ...TOKEN_COLORS],
  tokenColors: TOKEN_COLORS,
};

// -- the lazy highlighter ----------------------------------------------------

/** Grammar loaders by name, each its own chunk. Static strings so Vite can
 * see and split them. */
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  python: () => import('shiki/langs/python.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
      return createHighlighterCore({
        themes: [THEME],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

async function ensureLang(hl: HighlighterCore, lang: string): Promise<boolean> {
  const loader = GRAMMARS[lang];
  if (!loader) return false;
  if (!loadedLangs.has(lang)) {
    loadedLangs.set(
      lang,
      hl.loadLanguage(loader() as Parameters<HighlighterCore['loadLanguage']>[0]).catch((err) => {
        loadedLangs.delete(lang); // let a later open retry
        throw err;
      }),
    );
  }
  await loadedLangs.get(lang);
  return true;
}

function toLines(tokens: ThemedToken[][]): SyntaxLines {
  return tokens.map((line) =>
    line.map((tok) => {
      const role = roleForColor(tok.color);
      return role ? { content: tok.content, role } : { content: tok.content };
    }),
  );
}

/**
 * Tokenize a file. Resolves to null when there's nothing to colour — no
 * grammar for the language, the file is over the size cap, or the
 * highlighter couldn't load — and the caller shows plain text. The result's
 * line count matches `code.split('\n')`, so callers index it by line.
 */
export async function tokenizeCode(code: string, lang: string | null): Promise<SyntaxLines | null> {
  if (!lang || code.length > SYNTAX_MAX_CHARS) return null;
  try {
    const hl = await highlighter();
    if (!(await ensureLang(hl, lang))) return null;
    return toLines(hl.codeToTokensBase(code, { lang, theme: THEME_NAME }));
  } catch {
    return null;
  }
}
