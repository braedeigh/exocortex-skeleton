/**
 * api.ts — typed reads for the Wiring room: the code graph, one file's
 * neighbours, and the captured traces.
 *
 * Three server layers, three shapes, deliberately not blended here (see
 * WiringView's header for what each one can and cannot say):
 *   - GET /api/observatory/terrain/graph        — the static import graph
 *   - GET /api/observatory/terrain/graph/file   — one file's in/out edges
 *   - GET /api/observatory/terrain/trace[/<id>] — captured request traces
 *   - POST/DELETE .../trace/arm                 — arm or clear the next capture
 *
 * The whole-graph query is fetched ONCE and cached hard (the parse behind it
 * is TTL'd server-side anyway); the neighbour query is the one that moves as
 * she clicks around, so it's keyed per file and stays small. Arming is the
 * only write on this page, and after it lands the trace list polls — that
 * poll is the only timer here, and it stops the moment a new trace shows up.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { startJourney, stopJourney } from '../../api/journey';

/** One code file as a graph node. `parse_error` is non-null when the parser
 * choked — kept as a row rather than dropped, so "what is unreachable" can't
 * be answered by omission. */
export interface WiringFile {
  repo: string;
  path: string;
  lang: string;
  lines: number;
  out_degree: number;
  in_degree: number;
  parse_error: string | null;
}

/** A static dependency. `observed` is present when the runtime sensor has
 * actually seen this call happen — evidence laid over the map, never the map.
 * Its absence proves nothing (framework-mediated calls leave no trace). */
export interface WiringEdge {
  repo: string;
  src: string;
  dst_repo: string;
  dst: string;
  kind: string;
  symbols: string[];
  observed?: { last: number | null; windows: number };
}

export interface WiringGraph {
  files: WiringFile[];
  edges: WiringEdge[];
  observed_only: {
    src_repo: string;
    src: string;
    dst_repo: string;
    dst: string;
    windows: number;
  }[];
  counts: { files: number; edges: number; observed: number; observed_only: number };
  watching: boolean;
}

export interface WiringNeighbors {
  repo: string;
  path: string;
  imports: { dst_repo: string; dst: string; kind: string; symbols: string[] }[];
  imported_by: { repo: string; src: string; kind: string; symbols: string[] }[];
}

/** One hop in a trace. `src` null means the call arrived from outside our code
 * — the framework dispatched into us, which is the row that answers "where
 * does this actually get in". */
export interface TraceSpan {
  seq: number;
  depth: number;
  src_repo: string | null;
  src: string | null;
  src_func: string | null;
  dst_repo: string;
  dst: string;
  dst_func: string;
  t0_us: number;
  t1_us: number | null;
  static?: boolean;
  children?: TraceSpan[];
}

export interface TraceHead {
  id: string;
  label: string;
  kind: string;
  entry: string;
  started_at: string;
  duration_us: number;
  span_count: number;
  truncated: number;
}

/** One thing the agent itself did inside a turn — a Read, Edit, Bash — from
 * the conversation transcript, placed by wall clock. `repo`/`rel` are set when
 * the path falls inside a known repo. */
export interface AgentCall {
  seq: number;
  name: string;
  path: string;
  repo?: string | null;
  rel?: string | null;
  ts: number;
  t0_us: number;
}

export interface TracePart extends TraceHead {
  pid: number | null;
  parent_id: string | null;
  spans: TraceSpan[];
  tree: TraceSpan[];
  agent_calls?: AgentCall[];
}

export interface TraceDetail extends TraceHead {
  pid: number | null;
  spans: TraceSpan[];
  tree: TraceSpan[];
  /** Every continuation under this trace, flat and in start order: another
   * process (kind 'turn'), another request in the same journey ('http'), or
   * the browser's own events ('browser'). Each is its own recording with its
   * own clock, which is why none is spliced into `spans`. */
  parts: TracePart[];
  /** Store writes the journal saw inside the trace's window, oldest first —
   * what the journey did to the DATA, whoever made each write. */
  writes?: TraceWrite[];
}

export interface TraceWrite {
  ts: string;
  caller: string | null;
  collection: string | null;
  verb: string | null;
  t0_us: number;
}

export interface JourneyRec {
  id: string;
  label: string;
  armed_at: string;
  /** epoch seconds */
  until: number;
  seconds: number;
}

export function useWiringGraph() {
  return useQuery({
    queryKey: ['wiring', 'graph'],
    queryFn: () => api.get<WiringGraph>('/api/observatory/terrain/graph'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useWiringNeighbors(repo: string | null, path: string | null) {
  return useQuery({
    queryKey: ['wiring', 'neighbors', repo, path],
    queryFn: () =>
      api.get<WiringNeighbors>(
        `/api/observatory/terrain/graph/file?repo=${encodeURIComponent(repo!)}&path=${encodeURIComponent(path!)}`,
      ),
    enabled: Boolean(repo && path),
  });
}

export function useTraces() {
  return useQuery({
    queryKey: ['wiring', 'traces'],
    queryFn: () =>
      api.get<{
        traces: TraceHead[];
        armed: { id: string; label: string } | null;
        journey: JourneyRec | null;
        keep: number;
      }>(
        '/api/observatory/terrain/trace',
      ),
    // Polls ONLY while a capture is pending, and reads that from the response
    // rather than from a prop — arming is what starts the timer and the
    // capture landing (`armed` going null) is what stops it, so an open page
    // with nothing armed costs nothing. react-query's own default keeps even
    // the armed poll from firing in a backgrounded tab, which is the rest of
    // the house battery contract.
    refetchInterval: (query) => (query.state.data?.armed ? 2000 : false),
  });
}

export function useTrace(id: string | null) {
  return useQuery({
    queryKey: ['wiring', 'trace', id],
    queryFn: () => api.get<TraceDetail>(`/api/observatory/terrain/trace/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });
}

export function useArmTrace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) =>
      api.post<{ armed: boolean; id: string }>('/api/observatory/terrain/trace/arm', { label }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wiring', 'traces'] }),
  });
}

/** Open a journey window: every request the browser makes for `seconds`
 * joins one record, along with the browser's own taps and fetches. The hook
 * also starts the browser half (api/journey.ts) the moment the arm lands. */
export function useArmJourney() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (seconds: number) =>
      api.post<{ armed: boolean; id: string; journey: JourneyRec }>(
        '/api/observatory/terrain/trace/arm',
        { journey: true, seconds },
      ),
    onSuccess: (data) => {
      startJourney(data.journey.id, data.journey.until * 1000);
      qc.invalidateQueries({ queryKey: ['wiring', 'traces'] });
    },
  });
}

export function useDisarmTrace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ armed: boolean }>('/api/observatory/terrain/trace/arm'),
    onSuccess: () => {
      stopJourney();
      qc.invalidateQueries({ queryKey: ['wiring', 'traces'] });
    },
  });
}
