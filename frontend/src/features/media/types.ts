/** Media feature types — React port of static/js/media.js (books/movies/shows
 * backlog). Item shape mirrors routes/media.py's media.json records. */

export const MEDIA_TYPES = ['book', 'movie', 'show', 'podcast', 'article', 'game', 'other'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export interface MediaItem {
  id: string;
  title: string;
  /** One of MEDIA_TYPES; anything unknown renders as "Other". */
  type: string;
  author?: string;
  recommended_by?: string;
  notes?: string;
  /** YYYY-MM-DD, or null for "undated". */
  date?: string | null;
  done?: boolean;
}

/** GET /api/data/media response — _common_data() plus the media file. Only
 * the media slice is consumed here; dev/idea notes come through the pill's
 * own endpoints, and the tab-todos strip is a known unported gap. */
export interface MediaData {
  media?: { items?: MediaItem[] };
  server_date?: string;
}

export type MediaSortKey = 'date' | 'title' | 'type';

export interface MediaFilterState {
  /** 'all' or a MediaType. */
  type: string;
  sort: MediaSortKey;
  query: string;
}
