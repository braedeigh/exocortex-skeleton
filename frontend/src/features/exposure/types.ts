/**
 * types.ts — the shapes routes/exposure.py sends: a food's exposure scores
 * with their per-pesticide working, the study numbers beside them, and one
 * contaminant's facts and findings. Field names match exposurestore.py.
 */
import type { OrganicVerdict, VerdictReview } from '../kitchen/types';

export type SampleClaim = 'conventional' | 'organic' | 'all';

export interface ExposureTerm {
  pesticide_code: string;
  pesticide: string;
  hazard_id: number | null;
  samples_tested: number;
  samples_detected: number;
  mean_ppb: number;
  max_ppb: number | null;
  dose: number | null;
  dose_fact_id: number | null;
  dri: number | null;
}

export interface OrganicLine {
  samples_over: number;
  detections_without_tolerance: number;
  share_of_tolerance: number;
}

export interface ScoreReference {
  body_kg: number;
  serving_g: number;
  racc_g: number;
  serving_share: number;
  codes: [string, string][];
  organic_line: OrganicLine;
  bands: [number, OrganicVerdict][];
}

export interface ExposureScore {
  id: number;
  food_id: number;
  method: string;
  claim: SampleClaim;
  years: string;
  sample_count: number;
  pesticide_count: number;
  detected_count: number;
  no_dose_count: number;
  total_dri: number;
  max_dri: number;
  verdict: OrganicVerdict;
  reference: ScoreReference;
  computed_at: string;
  terms?: ExposureTerm[];
}

export interface StudyMeasure {
  id: number;
  food_id: number;
  food: string;
  hazard_id: number;
  hazard: string;
  measure: string;
  amount: number;
  unit: string;
  sample_size: number | null;
  basis: string | null;
  year: number | null;
  source_id: string | null;
  source: string | null;
  source_url: string | null;
  review: VerdictReview;
}

export interface ExposureMethod {
  name: string;
  body_kg: number;
  serving_share: number;
  bands: [number, OrganicVerdict][];
  organic_tolerance_share: number;
  verdicts: Record<OrganicVerdict, string>;
  facts: Record<string, string>;
}

export interface FoodExposure {
  food_id: number;
  name: string;
  codes: [string, string][];
  scores: ExposureScore[];
  headline: Partial<Record<SampleClaim, ExposureScore>>;
  years: string[];
  measures: StudyMeasure[];
}

export interface ContaminantFact {
  id: number;
  hazard_id: number;
  fact: string;
  label: string;
  value: string;
  amount: number | null;
  unit: string | null;
  basis: string | null;
  source_id: string | null;
  annotation_id: string | null;
  url: string | null;
  note: string | null;
  author: 'code' | 'llm' | 'owner';
  review: VerdictReview;
}

export interface ContaminantFinding {
  score_id: number;
  food_id: number;
  food: string;
  claim: SampleClaim;
  years: string;
  sample_count: number;
  samples_tested: number;
  samples_detected: number;
  mean_ppb: number;
  max_ppb: number | null;
  dose: number | null;
  dri: number | null;
  method: string;
}

export interface Contaminant {
  id: number;
  name: string;
  note: string | null;
  parents: string[];
  names: string[];
  facts: ContaminantFact[];
  found_in: ContaminantFinding[];
  measures: StudyMeasure[];
}

export interface ContaminantListItem {
  id: number;
  name: string;
  parents: string | null;
  foods: number;
  facts: number;
  max_dri: number | null;
}
