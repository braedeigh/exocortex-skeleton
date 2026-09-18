/**
 * fileTypes.ts — which kind of file a path is, and the colour GitHub gives
 * that kind. This is the lookup behind the terrain's "Types" toggle, which
 * paints every file dot by its type instead of by its heat.
 *
 * The colours are GitHub's own — the ones in the language bar on any repo
 * page, published in its open-source Linguist project (languages.yml). They
 * are kept here exactly as GitHub ships them. Several are too dark to see on
 * a dark sky (Markdown is navy, JSON is near-black); making them legible is
 * the painter's job, not this table's — see typeDotColor in terrainCanvas.ts,
 * which lifts a colour toward the text ink until it clears the surface.
 *
 * Used by terrainCanvas.ts (the dots) and TerrainPage.tsx (the legend). Pure
 * data and one lookup, so it's tested directly in fileTypes.test.ts.
 *
 * Prompt that produced it: "a toggle to color the dots by file type like with
 * the github scheme … a toggle that overrides the other colors when i toggle
 * it on".
 */

export interface FileType {
  /** The name shown in the legend, as GitHub spells it. */
  label: string;
  /** GitHub's colour for it, a #rrggbb hex. */
  color: string;
}

/** Every file GitHub has no colour for — images, fonts, lockfiles, anything
 * without an extension. A neutral grey, so they read as "not code" rather
 * than borrowing a language's colour. */
export const OTHER_FILE_TYPE: FileType = { label: 'Other', color: '#8b8b8b' };

// GitHub Linguist's colours, keyed by the type's name.
const TYPES = {
  python: { label: 'Python', color: '#3572A5' },
  typescript: { label: 'TypeScript', color: '#3178c6' },
  javascript: { label: 'JavaScript', color: '#f1e05a' },
  css: { label: 'CSS', color: '#663399' },
  scss: { label: 'SCSS', color: '#c6538c' },
  html: { label: 'HTML', color: '#e34c26' },
  markdown: { label: 'Markdown', color: '#083fa1' },
  json: { label: 'JSON', color: '#292929' },
  yaml: { label: 'YAML', color: '#cb171e' },
  toml: { label: 'TOML', color: '#9c4221' },
  shell: { label: 'Shell', color: '#89e051' },
  sql: { label: 'SQL', color: '#e38c00' },
  rust: { label: 'Rust', color: '#dea584' },
  elixir: { label: 'Elixir', color: '#6e4a7e' },
  go: { label: 'Go', color: '#00ADD8' },
  ruby: { label: 'Ruby', color: '#701516' },
  svg: { label: 'SVG', color: '#ff9900' },
  jupyter: { label: 'Jupyter Notebook', color: '#DA5B0B' },
  tex: { label: 'TeX', color: '#3D6117' },
  ini: { label: 'INI', color: '#d1dbe0' },
  csv: { label: 'CSV', color: '#237346' },
  dockerfile: { label: 'Dockerfile', color: '#384d54' },
  makefile: { label: 'Makefile', color: '#427819' },
} as const satisfies Record<string, FileType>;

// Which extensions belong to which type. Lower-case, without the dot.
const BY_EXTENSION: Record<string, FileType> = {
  py: TYPES.python,
  pyi: TYPES.python,
  ts: TYPES.typescript,
  tsx: TYPES.typescript,
  mts: TYPES.typescript,
  cts: TYPES.typescript,
  js: TYPES.javascript,
  jsx: TYPES.javascript,
  mjs: TYPES.javascript,
  cjs: TYPES.javascript,
  css: TYPES.css,
  scss: TYPES.scss,
  html: TYPES.html,
  htm: TYPES.html,
  md: TYPES.markdown,
  markdown: TYPES.markdown,
  mdx: TYPES.markdown,
  json: TYPES.json,
  jsonl: TYPES.json,
  webmanifest: TYPES.json,
  yml: TYPES.yaml,
  yaml: TYPES.yaml,
  toml: TYPES.toml,
  sh: TYPES.shell,
  bash: TYPES.shell,
  zsh: TYPES.shell,
  sql: TYPES.sql,
  rs: TYPES.rust,
  ex: TYPES.elixir,
  exs: TYPES.elixir,
  go: TYPES.go,
  rb: TYPES.ruby,
  svg: TYPES.svg,
  ipynb: TYPES.jupyter,
  tex: TYPES.tex,
  ini: TYPES.ini,
  cfg: TYPES.ini,
  conf: TYPES.ini,
  service: TYPES.ini,
  csv: TYPES.csv,
  tsv: TYPES.csv,
};

// Files GitHub recognises by their whole name rather than an extension.
const BY_FILENAME: Record<string, FileType> = {
  dockerfile: TYPES.dockerfile,
  makefile: TYPES.makefile,
};

/**
 * Work out a file's type from its path. The whole filename is tried first
 * (Dockerfile, Makefile), then the text after the last dot, case ignored.
 * Anything unrecognised — and a dotfile like `.gitignore`, whose "extension"
 * is really its name — is OTHER_FILE_TYPE.
 */
export function fileTypeOf(path: string): FileType {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const named = BY_FILENAME[name];
  if (named) return named;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return OTHER_FILE_TYPE;
  return BY_EXTENSION[name.slice(dot + 1)] ?? OTHER_FILE_TYPE;
}

/**
 * Count the types across a set of paths, for the legend. Most common first,
 * with Other always last however many there are — the named types are the
 * ones worth reading, and Other is the remainder.
 */
export function fileTypeCounts(paths: Iterable<string>): { type: FileType; count: number }[] {
  const counts = new Map<FileType, number>();
  for (const path of paths) {
    const type = fileTypeOf(path);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => {
      if (a.type === OTHER_FILE_TYPE) return 1;
      if (b.type === OTHER_FILE_TYPE) return -1;
      return b.count - a.count || a.type.label.localeCompare(b.type.label);
    });
}
