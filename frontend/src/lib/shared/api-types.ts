// Response shapes of the HEALTH-11 API (backend/app/*_api.py), only the
// fields the website reads.

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
