// Response shapes of the HEALTH-11 API (backend/app/*_api.py), only the
// fields the website reads.

import type { Mobility, RunMap } from "./live.ts";

export type Role = "Administrator" | "Emergency Commander" | "Staff User";

export type User = {
  id: number;
  organization_id: number;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
};

export type Page<T> = { items: T[]; total: number; limit: number; offset: number };

export type RunSummary = {
  id: number;
  scenario_id: number;
  building_id: number | null;
  algorithm: string;
  status: string;
  created_at: string;
  updated_at: string;
  summary: {
    total: number;
    evacuated: number;
    needs_assistance: number;
    reached_by_hazard: number;
    all_evacuated: boolean;
    evacuation_time_s: number | null;
  } | null;
};

export type Bottleneck = { edge_id: number; label: string; reasons: string[] };

export type Dashboard = {
  hospitals: number;
  scenarios: number;
  last_evacuation_time_s: number | null;
  bottlenecks: Bottleneck[];
  last_run: RunSummary | null;
  note: string | null;
};

export type ScenarioName = { id: number; name: string };

export type Alerts = {
  message: string | null;
  alerts: { run_id: number; reason: string; kind: "anomaly" | "safety" | "bottleneck" }[];
  method: string;
  runs_considered: number;
};

export type Hospital = {
  id: number;
  name: string;
  address: string | null;
  timezone: string;
  latitude: number | null;   // decimal degrees (WGS 84), both or neither
  longitude: number | null;
  created_at: string;
  updated_at: string;
};

/** GET /hospitals/{id}/weather (Open-Meteo); every value may be missing. */
export type WeatherNow = {
  source: string;
  attribution: string;
  attribution_url: string;
  note: string;
  fetched_at: string;
  valid_at: string;            // local time at the hospital, e.g. 2026-10-21T14:15
  utc_offset_seconds: number;
  interval_seconds: number | null;
  temperature_c: number | null;
  humidity_percent: number | null;
  wind_speed_kmh: number | null;
  wind_gusts_kmh: number | null;
  wind_direction_deg: number | null;
  wind_from: string | null;
  smoke_drifts_toward: string | null;
};

export type Building = {
  id: number;
  hospital_id: number;
  name: string;
  description: string | null;
};

export type Floor = {
  id: number;
  building_id: number;
  floor_number: number;
  name: string;
  elevation_metres: number | null;
};

export type GraphNode = {
  id: number;
  floor_id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  capacity: number;
  is_blocked: boolean;
  is_evacuation_lift: boolean;
  /** Size in metres for the floor-plan drawing (both or neither). */
  width_m: number | null;
  length_m: number | null;
};

export type GraphEdge = {
  id: number;
  from_node_id: number;
  to_node_id: number;
  distance: number;
  width: number;
  max_flow: number;
  wheelchair_accessible: boolean;
  stretcher_accessible: boolean;
  is_blocked: boolean;
};

export type FloorGraph = { floor_id: number; nodes: GraphNode[]; edges: GraphEdge[] };

export type FloorImportResult = { floor_id: number; nodes_imported: number; edges_imported: number };

/** POST /patients/import and /staff/import: what the file changes (applied=false: only checked). */
export type PeopleImportResult = {
  applied: boolean; rows: number; added: number; updated: number; removed: number; unchanged: number;
};

export type HazardType = "fire" | "smoke" | "hazmat" | "structural";

export type Hazard = {
  id: number;
  name: string;
  type: HazardType;
  origin_node_id: number;
  spread_rate: number;
  severity: number;
  is_active: boolean;
};

export type Scenario = {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  hazards: Hazard[];
  created_at: string;
  updated_at: string;
};

export type InjectedHazard = {
  id: number;
  name: string;
  type: HazardType;
  origin_node_id: number;
  severity: number;
  spread_rate: number;
  start_minutes: number;
};

export type RunDetail = RunSummary & {
  recommendations: { severity: string; text: string }[];
  injected_hazards: InjectedHazard[];
  map: RunMap;
  /** The model values the run used (speeds, tick, ...), with their sources. */
  parameters_used: ParameterUsed[];
  /** Counts sampled every simulation_frame_seconds, plus the final moment. */
  timeline: { t: number; evacuated: number; active: number; needs_assistance: number; reached_by_hazard: number }[];
};

/** One row of POST /compare. */
export type Comparison = {
  algorithm: string;
  evacuation_time_s: number | null;
  distance_m: number | null;
  risk: number | null;
  all_evacuated: boolean;
  evacuated: number;
  total: number;
  needs_assistance: number;
  reached_by_hazard: number;
};

export type Patient = {
  id: number;
  patient_code: string;
  mobility: Mobility;
  criticality: number;
  node_id: number | null;
  is_synthetic: boolean;
};

export type StaffMember = {
  id: number;
  staff_code: string;
  full_name: string;
  role: string;
  node_id: number | null;
  is_synthetic: boolean;
};

export type ParameterUsed = { name: string; value: number; unit: string | null; source: string | null; meaning: string | null };

/** GET /patient_priority (backend/app/services/priority.py). */
export type PriorityRow = {
  rank: number;
  patient_id: number;
  patient_code: string;
  mobility: string;
  criticality: number;
  node_id: number | null;
  node_name: string | null;
  is_synthetic: boolean;
  score: number;
  breakdown: {
    mobility: { value: string; factor: number; weight: number; points: number };
    criticality: { value: number; factor: number; weight: number; points: number };
    hazard: { distance_m: number | null; factor: number; weight: number; points: number; explanation: string };
  };
};

export type PriorityResult = Page<PriorityRow> & {
  scenario_id: number | null;
  building_id: number | null;
  method: string;
  parameters_used: ParameterUsed[];
};

/** POST /predict (backend/app/ai_api.py). */
export type Prediction = {
  predicted_time_s: number | null;
  method: string;
  mae: number | null;
  r2: number | null;
  note: string;
  about: {
    model_id: number;
    trained_at: string | null;
    training_runs: number;
    test_runs: number;
    baseline_mae_s: number;
    model: string;
    features: string[];
  } | null;
};

export type DraftHazard = {
  name: string;
  type: HazardType;
  origin_node_id: number;
  origin_node_name: string;
  severity: number;
  spread_rate: number;
};

/** POST /assistant (backend/app/assistant_api.py). */
export type AssistantDraft = {
  floor_id: number;
  method: string;
  data_notice: string | null;
  note: string | null;
} & (
  | { scenario: { name: string; description: string | null; hazards: DraftHazard[] }; clarification?: undefined }
  | { clarification: string; unknown_names: string[]; scenario?: undefined }
);

/** POST /assistant/summary. */
export type AssistantSummary = {
  run_id: number;
  summary: string;
  source: "ai" | "standard";
  note: string;
  method: string;
  data_notice: string | null;
};

/** GET /users (Administrators). */
export type ManagedUser = User & { created_at: string; updated_at: string };

/** GET /audit_log (Administrators). */
export type AuditEntry = {
  id: number;
  created_at: string;
  actor_user_id: number | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
};

/** GET /parameters and GET /parameters/specs. */
export type StoredParameter = { id: number; name: string; value: string; unit: string | null; source: string };
export type ParameterSpec = { name: string; default: number; unit: string; minimum: number; maximum: number; meaning: string };
