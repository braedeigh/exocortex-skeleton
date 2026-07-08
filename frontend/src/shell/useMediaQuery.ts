import { useEffect, useState } from 'react';

/** Small reactive wrapper around window.matchMedia — shared by SplitLayout and TopTabs
 * so the desktop/mobile breakpoint (769px) is defined in exactly one place. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const DESKTOP_QUERY = '(min-width: 769px)';
