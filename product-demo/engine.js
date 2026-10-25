// Hazard-aware evacuation routing prototype: simulation engine.
//
// Follows the four layers of the seminar's proposed approach:
//   Sensing    smoke, heat and CO sensors (with noise and faults), people counts, building graph
//   Situation  risk index and FED, live estimate of where the hazard will arrive, crowd density
//   Decision   unsafe-area filter with fallback, time-dependent congestion-aware routes,
//              the commander confirms alerts
//   Guidance   exit signs, phone messages, rescue-team routes
// and repeats the loop every replan_s seconds.
//
// Pure functions, no browser code: the same file runs in the page and in `node --test`.
// Distances are metres, times seconds, speeds m/s.

// ---------------------------------------------------------------------------
// Sources and parameters
// ---------------------------------------------------------------------------

export const SOURCES = {
  NIST1722: {
    short: "NIST TN 1722 (SFPE hydraulic model)",
    full: "P. A. Reneke, P. Tofilo, R. D. Peacock, B. L. Hoskins, \"Simple Estimates of Combined Stairwell / Elevator Egress in Buildings\", NIST Technical Note 1722, 2013. Restates the SFPE speed-density relation S = k (1 - a D) with a = 0.266 and k = 1.40 m/s on level floors; below 0.54 people/m2 people walk at S(0.54).",
    url: "https://www.govinfo.gov/content/pkg/GOVPUB-C13-44695726b38382de9cb5d09b30afe045/pdf/GOVPUB-C13-44695726b38382de9cb5d09b30afe045.pdf",
  },
  PATHFINDER: {
    short: "Pathfinder SFPE technical reference",
    full: "Thunderhead Engineering, Pathfinder Technical Reference, SFPE mode: minimum speed fraction 0.15, maximum density 3.55 people/m2, stair k = 1.08 m/s for 7 in risers and 11 in treads.",
    url: "https://www.thunderheadeng.com/docs/2026-1/pathfinder/appendices/technical-reference/sfpe",
  },
  ALONSO2016: {
    short: "Alonso-Gutierrez & Ronchi 2016",
    full: "V. Alonso-Gutierrez, E. Ronchi, \"The simulation of assisted evacuation in hospitals\", Fire and Evacuation Modeling Technical Conference, 2016. Patient preparation times, staff reaction time, walking and transport speeds, two staff per bed.",
    url: "https://files.thunderheadeng.com/femtc/2016_d2-05-alonso-paper.pdf",
  },
  ISO13571: {
    short: "ISO 13571 (FED)",
    full: "ISO 13571, Life-threatening components of fire. Fractional effective dose: CO term = sum of CO concentration (ppm) x time (min) / 35000; convected heat: time to incapacitation t = 5 x 10^7 T^-3.4 min (T in degC); a dose of 1 means incapacitation. Here the CO term leaves out the CO2 breathing factor. Summarised in the NIPV comparison of ISO 13571, the SFPE Handbook and AEGL.",
    url: "https://archief.nipv.nl/documenten/appendix-1-comparison-between-the-iso-standard-sfpe-handbook-and-aegl",
  },
  JIN: {
    short: "Jin's visibility relation",
    full: "Visibility in smoke V = C / K (K = extinction coefficient, 1/m); C about 3 for light-reflecting and about 8 for light-emitting signs (Jin). Rasbash gives 10 m visibility for safe escape. As summarised in arXiv 2404.11439.",
    url: "https://arxiv.org/abs/2404.11439",
  },
  PAPERS: {
    short: "Seminar papers [1]-[8]",
    full: "Method choices follow the surveyed papers: risk indices [3], FED [4], spread-rate prediction [6], [7], most-exposed groups first [4], gamma-efficient alternative paths [8], rescue-team routing [2].",
    url: "",
  },
  ASSUMED: { short: "Assumed, to be validated", full: "No published value was found for this prototype; replace it with a measured or design value.", url: "" },
  DERIVED: { short: "Derived", full: "Calculated from the sourced values.", url: "" },
  POLICY: { short: "Planner setting", full: "A choice of the person running the plan, not a physical constant.", url: "" },
};

// kind: sourced | derived | assumed | policy
export const PARAMS = [
  // Crowd movement
  { key: "sfpe_a", group: "Crowd movement", label: "Speed-density constant a", value: 0.266, unit: "m2/person", source: "NIST1722", kind: "sourced" },
  { key: "k_level", group: "Crowd movement", label: "k on level floors (also the k of v = k(1 - 0.266 rho))", value: 1.40, unit: "m/s", source: "NIST1722", kind: "sourced" },
  { key: "k_stair", group: "Crowd movement", label: "k on stairs (7 in riser, 11 in tread)", value: 1.08, unit: "m/s", source: "PATHFINDER", kind: "sourced" },
  { key: "d_free", group: "Crowd movement", label: "Density below which people walk freely", value: 0.54, unit: "people/m2", source: "NIST1722", kind: "sourced" },
  { key: "min_speed_fraction", group: "Crowd movement", label: "Slowest speed in a crowd, as a fraction of free speed", value: 0.15, unit: "-", source: "PATHFINDER", kind: "sourced" },
  { key: "d_max", group: "Crowd movement", label: "Most people per m2 (also sets place capacity)", value: 3.55, unit: "people/m2", source: "PATHFINDER", kind: "sourced" },
  { key: "boundary_layer", group: "Crowd movement", label: "Width lost at each side of a path (effective width = width - 2 x this)", value: 0.15, unit: "m", source: "ASSUMED", kind: "assumed" },
  // Speeds
  { key: "speed_staff", group: "Speeds", label: "Staff walking speed (mean)", value: 1.35, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_staff_sd", group: "Speeds", label: "Staff walking speed (standard deviation)", value: 0.25, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_patient_min", group: "Speeds", label: "Walking patient speed, lowest", value: 0.84, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_patient_max", group: "Speeds", label: "Walking patient speed, highest", value: 1.40, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_visitor", group: "Speeds", label: "Visitor speed: 1.40 x (1 - 0.266 x 0.54)", value: 1.199, unit: "m/s", source: "DERIVED", kind: "derived" },
  { key: "speed_wheelchair", group: "Speeds", label: "Wheelchair pushed by staff (mean)", value: 0.63, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_bed", group: "Speeds", label: "Stretcher or bed moved by staff (mean)", value: 0.40, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  { key: "speed_transport_sd", group: "Speeds", label: "Wheelchair and bed speed (standard deviation)", value: 0.04, unit: "m/s", source: "ALONSO2016", kind: "sourced" },
  // Delays
  { key: "staff_premove_mean", group: "Delays", label: "Staff reaction time after the alarm (log-normal mean)", value: 71, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "staff_premove_sd", group: "Delays", label: "Staff reaction time (log-normal standard deviation)", value: 60, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_ambulatory_mean", group: "Delays", label: "Walking patient preparation (mean, range 30-90 s)", value: 60, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_ambulatory_sd", group: "Delays", label: "Walking patient preparation (standard deviation)", value: 20, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_wheelchair_mean", group: "Delays", label: "Wheelchair patient preparation (mean, range 100-120 s)", value: 110, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_wheelchair_sd", group: "Delays", label: "Wheelchair patient preparation (standard deviation)", value: 36, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_bed_mean", group: "Delays", label: "Bed patient preparation (mean, range 180-900 s)", value: 360, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "prep_bed_sd", group: "Delays", label: "Bed patient preparation (standard deviation)", value: 40, unit: "s", source: "ALONSO2016", kind: "sourced" },
  { key: "visitor_premove_mean", group: "Delays", label: "Visitor reaction time (mean)", value: 60, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "visitor_premove_sd", group: "Delays", label: "Visitor reaction time (standard deviation)", value: 20, unit: "s", source: "ASSUMED", kind: "assumed" },
  // Staff help and lifts
  { key: "escort_wheelchair", group: "Staff help and lifts", label: "Staff needed for a wheelchair patient", value: 1, unit: "staff", source: "ASSUMED", kind: "assumed" },
  { key: "escort_bed", group: "Staff help and lifts", label: "Staff needed for a bed patient", value: 2, unit: "staff", source: "ALONSO2016", kind: "sourced" },
  { key: "space_wheelchair", group: "Staff help and lifts", label: "Space of a wheelchair and helper (walking people)", value: 2, unit: "people", source: "ASSUMED", kind: "assumed" },
  { key: "space_bed", group: "Staff help and lifts", label: "Space of a bed and its staff (walking people)", value: 4, unit: "people", source: "ASSUMED", kind: "assumed" },
  { key: "lift_capacity", group: "Staff help and lifts", label: "Lift load per trip (walking people)", value: 4, unit: "people", source: "ASSUMED", kind: "assumed" },
  { key: "lift_speed", group: "Staff help and lifts", label: "Lift speed", value: 1.0, unit: "m/s", source: "ASSUMED", kind: "assumed" },
  { key: "lift_door_s", group: "Staff help and lifts", label: "Lift loading and unloading per trip", value: 20, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "floor_height", group: "Staff help and lifts", label: "Height of one floor", value: 4, unit: "m", source: "ASSUMED", kind: "assumed" },
  // Fire and smoke (the "real" hazard in a run)
  { key: "smoke_T_max", group: "Fire and smoke", label: "Hottest smoke at the fire (falls with distance)", value: 120, unit: "degC", source: "ASSUMED", kind: "assumed" },
  { key: "co_max", group: "Fire and smoke", label: "Highest CO in smoke at the fire", value: 2000, unit: "ppm", source: "ASSUMED", kind: "assumed" },
  { key: "k_max", group: "Fire and smoke", label: "Thickest smoke at the fire (extinction coefficient)", value: 1.5, unit: "1/m", source: "ASSUMED", kind: "assumed" },
  { key: "grow_s", group: "Fire and smoke", label: "Time for smoke in a place to reach its full level", value: 120, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "decay_m", group: "Fire and smoke", label: "Distance over which smoke weakens to 37%", value: 40, unit: "m", source: "ASSUMED", kind: "assumed" },
  { key: "fire_T", group: "Fire and smoke", label: "Temperature in a burning place", value: 600, unit: "degC", source: "ASSUMED", kind: "assumed" },
  { key: "fire_co", group: "Fire and smoke", label: "CO in a burning place", value: 8000, unit: "ppm", source: "ASSUMED", kind: "assumed" },
  { key: "door_factor", group: "Fire and smoke", label: "Spread speed through a room door (fraction)", value: 0.6, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "fire_door_factor", group: "Fire and smoke", label: "Spread speed through a closed fire door (fraction)", value: 0.3, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "protected_breach_s", group: "Fire and smoke", label: "Time before smoke gets into a protected stair or lift", value: 900, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "true_rate_low", group: "Fire and smoke", label: "Real spread speed, lowest multiple of the design value", value: 0.7, unit: "x", source: "ASSUMED", kind: "assumed" },
  { key: "true_rate_high", group: "Fire and smoke", label: "Real spread speed, highest multiple of the design value", value: 1.5, unit: "x", source: "ASSUMED", kind: "assumed" },
  { key: "true_edge_sd", group: "Fire and smoke", label: "Path-to-path variation of real spread speed (log-normal sd)", value: 0.25, unit: "-", source: "ASSUMED", kind: "assumed" },
  // Dose and tenability
  { key: "fed_co_ct", group: "Dose and tenability", label: "CO dose for incapacitation", value: 35000, unit: "ppm min", source: "ISO13571", kind: "sourced" },
  { key: "heat_a", group: "Dose and tenability", label: "Heat: t = a T^-b, constant a", value: 5e7, unit: "min", source: "ISO13571", kind: "sourced" },
  { key: "heat_b", group: "Dose and tenability", label: "Heat: t = a T^-b, power b", value: 3.4, unit: "-", source: "ISO13571", kind: "sourced" },
  { key: "fed_incap", group: "Dose and tenability", label: "FED of incapacitation", value: 1.0, unit: "-", source: "ISO13571", kind: "sourced" },
  { key: "fed_harm", group: "Dose and tenability", label: "FED counted as harmed (reached by the hazard)", value: 0.3, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "jin_c_reflect", group: "Dose and tenability", label: "Visibility factor C, light-reflecting signs", value: 3, unit: "-", source: "JIN", kind: "sourced" },
  { key: "jin_c_emit", group: "Dose and tenability", label: "Visibility factor C, light-emitting exit signs", value: 8, unit: "-", source: "JIN", kind: "sourced" },
  { key: "visibility_limit", group: "Dose and tenability", label: "Visibility for safe escape", value: 10, unit: "m", source: "JIN", kind: "sourced" },
  { key: "temp_limit", group: "Dose and tenability", label: "Air temperature counted as untenable in the risk index", value: 60, unit: "degC", source: "ASSUMED", kind: "assumed" },
  { key: "risk_window_min", group: "Dose and tenability", label: "Risk 1 = a dose of 1 within this many minutes", value: 10, unit: "min", source: "POLICY", kind: "policy" },
  { key: "visibility_risk_cap", group: "Dose and tenability", label: "Most risk that poor visibility alone can give", value: 0.8, unit: "-", source: "POLICY", kind: "policy" },
  { key: "avoid_k", group: "Dose and tenability", label: "Smoke people see and avoid (extinction coefficient)", value: 0.5, unit: "1/m", source: "ASSUMED", kind: "assumed" },
  { key: "report_k", group: "Dose and tenability", label: "Smoke people notice and report by phone", value: 0.1, unit: "1/m", source: "ASSUMED", kind: "assumed" },
  { key: "sign_read_m", group: "Dose and tenability", label: "A sign is read if the visibility is at least", value: 5, unit: "m", source: "ASSUMED", kind: "assumed" },
  // Sensors and alarm
  { key: "sample_s", group: "Sensors and alarm", label: "Sensor reading interval", value: 5, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "net_delay_s", group: "Sensors and alarm", label: "Network delay of a reading", value: 2, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "thr_smoke", group: "Sensors and alarm", label: "Smoke detector alarm level", value: 0.05, unit: "1/m", source: "ASSUMED", kind: "assumed" },
  { key: "thr_heat", group: "Sensors and alarm", label: "Heat detector alarm level", value: 57, unit: "degC", source: "ASSUMED", kind: "assumed" },
  { key: "thr_co", group: "Sensors and alarm", label: "CO detector alarm level", value: 50, unit: "ppm", source: "ASSUMED", kind: "assumed" },
  { key: "noise_smoke", group: "Sensors and alarm", label: "Smoke reading noise (sd)", value: 0.015, unit: "1/m", source: "ASSUMED", kind: "assumed" },
  { key: "noise_heat", group: "Sensors and alarm", label: "Heat reading noise (sd)", value: 1.5, unit: "degC", source: "ASSUMED", kind: "assumed" },
  { key: "noise_co", group: "Sensors and alarm", label: "CO reading noise (sd)", value: 8, unit: "ppm", source: "ASSUMED", kind: "assumed" },
  { key: "debounce_m", group: "Sensors and alarm", label: "Readings above the level needed (out of the last 3)", value: 2, unit: "of 3", source: "POLICY", kind: "policy" },
  { key: "p_dead", group: "Sensors and alarm", label: "Share of sensors that send nothing", value: 0.05, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "p_stuck", group: "Sensors and alarm", label: "Share of sensors stuck at one value", value: 0.03, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "p_drift", group: "Sensors and alarm", label: "Share of sensors that read too high (40% of the alarm level)", value: 0.03, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "p_flaky", group: "Sensors and alarm", label: "Share of sensors that lose readings", value: 0.05, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "flaky_loss", group: "Sensors and alarm", label: "Readings lost by a flaky sensor", value: 0.4, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "sensor_burn_T", group: "Sensors and alarm", label: "A sensor stops working above", value: 150, unit: "degC", source: "ASSUMED", kind: "assumed" },
  { key: "confirm_delay_s", group: "Sensors and alarm", label: "Commander confirmation time (automatic mode)", value: 20, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "discovery_delay_s", group: "Sensors and alarm", label: "Time for people to raise the alarm after finding the hazard", value: 30, unit: "s", source: "ASSUMED", kind: "assumed" },
  // Guidance and people's behaviour (imperfect information)
  { key: "phone_patient", group: "Guidance and behaviour", label: "Walking patients who get phone messages", value: 0.5, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "phone_visitor", group: "Guidance and behaviour", label: "Visitors who get phone messages", value: 0.8, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "compliance", group: "Guidance and behaviour", label: "People who follow phone messages and signs", value: 0.75, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "familiar_share", group: "Guidance and behaviour", label: "Non-followers heading for the exit they know", value: 0.7, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "phone_delay_s", group: "Guidance and behaviour", label: "Delay of a phone message", value: 5, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "msg_loss", group: "Guidance and behaviour", label: "Phone messages that do not arrive", value: 0.05, unit: "-", source: "ASSUMED", kind: "assumed" },
  { key: "sign_fail", group: "Guidance and behaviour", label: "Dynamic exit signs that do not work", value: 0.05, unit: "-", source: "ASSUMED", kind: "assumed" },
  // Routing
  { key: "replan_s", group: "Routing", label: "Re-plan every (delta t)", value: 10, unit: "s", source: "POLICY", kind: "policy" },
  { key: "alpha", group: "Routing", label: "alpha: seconds of route cost per unit of dose", value: 3000, unit: "s", source: "POLICY", kind: "policy" },
  { key: "theta", group: "Routing", label: "theta: places at this risk or more are filtered out", value: 0.6, unit: "0-1", source: "POLICY", kind: "policy" },
  { key: "gamma", group: "Routing", label: "gamma: keep alternatives up to this multiple of the best cost", value: 1.25, unit: "x", source: "PAPERS", kind: "policy" },
  { key: "k_alt", group: "Routing", label: "Most alternative routes kept per group", value: 2, unit: "routes", source: "POLICY", kind: "policy" },
  { key: "jam_wait_s", group: "Routing", label: "Switch to an alternative after waiting", value: 8, unit: "s", source: "POLICY", kind: "policy" },
  { key: "bucket_s", group: "Routing", label: "Time slot of the congestion forecast", value: 5, unit: "s", source: "POLICY", kind: "policy" },
  { key: "horizon_s", group: "Routing", label: "Congestion forecast horizon", value: 900, unit: "s", source: "POLICY", kind: "policy" },
  { key: "refuge_cost_s", group: "Routing", label: "Extra cost of a refuge instead of an exit (horizontal evacuation)", value: 60, unit: "s", source: "POLICY", kind: "policy" },
  { key: "sign_lookahead_s", group: "Routing", label: "Signs look this far ahead for hazard", value: 60, unit: "s", source: "POLICY", kind: "policy" },
  // Live hazard estimate
  { key: "est_v_min", group: "Live hazard estimate", label: "Slowest spread speed considered", value: 0.01, unit: "m/s", source: "POLICY", kind: "policy" },
  { key: "est_v_max", group: "Live hazard estimate", label: "Fastest spread speed considered", value: 1.0, unit: "m/s", source: "POLICY", kind: "policy" },
  { key: "est_sigma_s", group: "Live hazard estimate", label: "Expected timing error of one detection", value: 15, unit: "s", source: "POLICY", kind: "policy" },
  { key: "est_min_detections", group: "Live hazard estimate", label: "Detections needed before people in a refuge are moved again on a forecast (one alone may be a faulty sensor; a commander's confirmation in manual mode also counts)", value: 2, unit: "-", source: "POLICY", kind: "policy" },
  { key: "est_window_s", group: "Live hazard estimate", label: "Detections confirm each other only within", value: 300, unit: "s", source: "POLICY", kind: "policy" },
  { key: "est_default_rate", group: "Live hazard estimate", label: "Spread speed assumed before two detections exist (if no design value)", value: 0.1, unit: "m/s", source: "POLICY", kind: "policy" },
  // Rescue teams
  { key: "rescue_arrival_s", group: "Rescue teams", label: "Fire brigade arrives after the alarm", value: 480, unit: "s", source: "ASSUMED", kind: "assumed" },
  { key: "rescue_teams", group: "Rescue teams", label: "Rescue teams", value: 2, unit: "teams", source: "ASSUMED", kind: "assumed" },
  { key: "rescue_team_size", group: "Rescue teams", label: "Firefighters per team", value: 2, unit: "people", source: "ASSUMED", kind: "assumed" },
  { key: "rescue_speed", group: "Rescue teams", label: "Firefighter speed in gear", value: 1.0, unit: "m/s", source: "ASSUMED", kind: "assumed" },
  { key: "carry_speed", group: "Rescue teams", label: "Speed while carrying a person", value: 0.5, unit: "m/s", source: "ASSUMED", kind: "assumed" },
  { key: "theta_rescue", group: "Rescue teams", label: "Teams in breathing apparatus enter places below this risk (1 = untenable for occupants; fire is never entered)", value: 10, unit: "x untenable", source: "POLICY", kind: "policy" },
  { key: "time_limit_s", group: "Rescue teams", label: "Longest time simulated", value: 3600, unit: "s", source: "POLICY", kind: "policy" },
];

export function defaultParams() {
  return Object.fromEntries(PARAMS.map((p) => [p.key, p.value]));
}

export const PLACE_TYPES = ["room", "ward", "icu", "corridor", "stair", "ramp", "lift", "exit", "assembly"];
export const MOBILITIES = ["ambulatory", "wheelchair", "stretcher", "ventilator"];
export const SENSOR_KINDS = ["smoke", "heat", "co"];
export const METHODS = {
  nearest: { label: "Nearest exit (static plan)", short: "Nearest exit" },
  safe: { label: "Shortest safe path (hazard filter only)", short: "Shortest safe" },
  congestion: { label: "Congestion-aware (no hazard forecast)", short: "Congestion" },
  proposed: { label: "Proposed: time-dependent, congestion and dose aware", short: "Proposed" },
};
export const HAZARD_INFO = {
  live: "Live estimate from sensor readings",
  offline: "Fire model run before the event (not updated)",
  perfect: "Perfect knowledge (upper bound)",
};

// ---------------------------------------------------------------------------
// Random numbers (seeded, so every run can be repeated)
// ---------------------------------------------------------------------------

export function makeRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(random, mean, sd) {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function logNormal(random, mean, sd) {
  const s2 = Math.log(1 + (sd / mean) ** 2);
  const mu = Math.log(mean) - s2 / 2;
  return Math.exp(normal(random, mu, Math.sqrt(s2)));
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function round(v, d = 0) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Crowd movement: v = k (1 - a rho)
// ---------------------------------------------------------------------------

// Fraction of free speed at density rho (people/m2). Free speed is reached at
// d_free and below; never below min_speed_fraction.
export function speedFraction(rho, p) {
  if (rho <= p.d_free) return 1;
  const f = (1 - p.sfpe_a * rho) / (1 - p.sfpe_a * p.d_free);
  return Math.max(p.min_speed_fraction, f);
}

// Speed from the seminar formula v = k (1 - 0.266 rho), with the SFPE floor.
export function sfpeSpeed(rho, k, p) {
  return k * (1 - p.sfpe_a * p.d_free) * speedFraction(rho, p);
}

// Highest flow per metre of effective width: max of k(1 - aD)D is k / (4a).
export function maxSpecificFlow(k, p) {
  return k / (4 * p.sfpe_a);
}

// ---------------------------------------------------------------------------
// Fire, smoke and dose
// ---------------------------------------------------------------------------

const AMBIENT = 20;

// Conditions in a place at time t, given when smoke (aS) and fire (aF) get
// there and how far it is from the origin (d, effective metres).
// A burning place heats up over grow_s; it counts as fire (impassable) once
// the air passes the untenable temperature.
export function conditionsAt(t, aS, aF, d, p) {
  let T = AMBIENT;
  let CO = 0;
  let K = 0;
  let smoke = false;
  if (t >= aS) {
    const g = Math.min(1, (t - aS) / p.grow_s);
    const dec = Math.exp(-d / p.decay_m);
    T = AMBIENT + (p.smoke_T_max - AMBIENT) * g * dec;
    CO = p.co_max * g * dec;
    K = p.k_max * g * dec;
    smoke = true;
  }
  if (t >= aF) {
    const g = Math.min(1, (t - aF) / p.grow_s);
    T = Math.max(T, AMBIENT + (p.fire_T - AMBIENT) * g);
    CO = Math.max(CO, p.fire_co * g);
    K = Math.max(K, p.k_max * Math.min(1, 2 * g));
    smoke = true;
    return { T, CO, K, fire: T >= p.temp_limit * 2, smoke };
  }
  return { T, CO, K, fire: false, smoke };
}

// FED gained per second in these conditions (ISO 13571 asphyxiant CO term + convected heat).
export function fedPerSecond(c, p) {
  if (!c.smoke) return 0;
  const co = c.CO / p.fed_co_ct; // per minute
  const heat = c.T > AMBIENT ? 1 / (p.heat_a * c.T ** -p.heat_b) : 0; // per minute
  return (co + heat) / 60;
}

// Risk index (Kamoun-style, built from FED rate, temperature and visibility).
// 1 = untenable: a dose of 1 within risk_window_min, or air at temp_limit.
// Above 1 the raw value keeps growing so the fallback can still pick the
// least bad way; a burning place is 99. riskIndex() is the 0..1 display value.
export const FIRE_RISK = 99;
export function riskRaw(c, p) {
  if (c.fire) return FIRE_RISK;
  if (!c.smoke) return 0;
  const dose = fedPerSecond(c, p) * 60 * p.risk_window_min;
  const heat = (c.T - AMBIENT) / (p.temp_limit - AMBIENT);
  const kLimit = p.jin_c_reflect / p.visibility_limit;
  const vis = Math.min(p.visibility_risk_cap, c.K / kLimit);
  return Math.max(0, dose, heat, vis);
}
export function riskIndex(c, p) {
  return clamp(riskRaw(c, p), 0, 1);
}

export function visibility(K, C) {
  return K <= 1e-9 ? Infinity : C / K;
}

// ---------------------------------------------------------------------------
// Building model
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(message);
}
function num(value, what, { min = -Infinity, max = Infinity, positive = false } = {}) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) fail(`${what} must be a number`);
  if (positive && n <= 0) fail(`${what} must be more than 0`);
  if (n < min || n > max) fail(`${what} must be between ${min} and ${max}`);
  return n;
}
function text(value, what, max = 80) {
  const s = String(value ?? "").trim();
  if (!s) fail(`${what} is missing`);
  if (s.length > max) fail(`${what} is longer than ${max} characters`);
  return s;
}
function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(s)) return true;
  if (["false", "no", "0", "n"].includes(s)) return false;
  fail(`"${value}" is not yes or no`);
}

export const LIMITS = { places: 2000, paths: 5000, people: 5000, sensors: 3000 };

export function buildModel(data, params = {}) {
  const p = { ...defaultParams(), ...params };
  if (!data || typeof data !== "object") fail("The building file is empty");
  const name = text(data.name ?? "Imported building", "Building name", 120);
  const places = Array.isArray(data.places) ? data.places : fail("The file has no places");
  const paths = Array.isArray(data.paths) ? data.paths : fail("The file has no paths");
  if (places.length > LIMITS.places) fail(`Too many places (most ${LIMITS.places})`);
  if (paths.length > LIMITS.paths) fail(`Too many paths (most ${LIMITS.paths})`);

  const nodes = [];
  const index = new Map();
  for (const [i, raw] of places.entries()) {
    const id = text(raw.id ?? raw.name, `Place ${i + 1}: name`);
    if (index.has(id)) fail(`Place "${id}" appears twice`);
    const type = text(raw.type, `Place "${id}": type`).toLowerCase();
    if (!PLACE_TYPES.includes(type)) fail(`Place "${id}": type "${type}" is not one of ${PLACE_TYPES.join(", ")}`);
    const w = num(raw.w ?? 4, `Place "${id}": width`, { positive: true, max: 1000 });
    const l = num(raw.l ?? 4, `Place "${id}": length`, { positive: true, max: 1000 });
    const node = {
      i: nodes.length,
      id,
      type,
      floor: Math.round(num(raw.floor ?? 0, `Place "${id}": floor`, { min: -10, max: 200 })),
      x: num(raw.x, `Place "${id}": x`, { min: -10000, max: 10000 }),
      y: num(raw.y, `Place "${id}": y`, { min: -10000, max: 10000 }),
      w,
      l,
      area: w * l,
      capacity: raw.capacity !== undefined ? Math.round(num(raw.capacity, `Place "${id}": capacity`, { min: 0, max: 100000 })) : Math.floor(w * l * p.d_max),
      compartment: String(raw.compartment ?? "main").slice(0, 40),
      refuge: bool(raw.refuge, false),
      sign: bool(raw.sign, false),
      evacLift: bool(raw.evacLift, false),
      blocked: bool(raw.blocked, false),
    };
    node.protected = type === "stair" || type === "lift";
    index.set(id, node.i);
    nodes.push(node);
  }

  const edges = [];
  const adj = nodes.map(() => []);
  const seen = new Set();
  const addEdge = (edge) => {
    edge.i = edges.length;
    edges.push(edge);
    adj[edge.u].push(edge.i);
    adj[edge.v].push(edge.i);
    return edge;
  };
  for (const [i, raw] of paths.entries()) {
    const a = text(raw.a ?? raw.from, `Path ${i + 1}: from`);
    const b = text(raw.b ?? raw.to, `Path ${i + 1}: to`);
    if (!index.has(a)) fail(`Path ${i + 1}: place "${a}" does not exist`);
    if (!index.has(b)) fail(`Path ${i + 1}: place "${b}" does not exist`);
    if (a === b) fail(`Path ${i + 1}: a path cannot join "${a}" to itself`);
    const key = [a, b].sort().join("\u0000");
    if (seen.has(key)) fail(`Path ${a} - ${b} appears twice`);
    seen.add(key);
    const u = index.get(a);
    const v = index.get(b);
    const nu = nodes[u];
    const nv = nodes[v];
    let kind = "flat";
    if (nu.type === "stair" && nv.type === "stair" && nu.floor !== nv.floor) kind = "stair";
    else if (nu.type === "lift" && nv.type === "lift" && nu.floor !== nv.floor) kind = "lift";
    else if (nu.floor !== nv.floor) fail(`Path ${a} - ${b} joins two floors but is not stair-to-stair or lift-to-lift`);
    const width = num(raw.width ?? 1.2, `Path ${a} - ${b}: width`, { positive: true, max: 100 });
    const isRoom = (n) => !["corridor", "stair", "lift", "exit", "assembly", "ramp"].includes(n.type);
    addEdge({
      u,
      v,
      kind,
      length: num(raw.length, `Path ${a} - ${b}: length`, { positive: true, max: 10000 }),
      width,
      effWidth: Math.max(0.3, width - 2 * p.boundary_layer),
      wheelchair: bool(raw.wheelchair, kind !== "stair"),
      stretcher: bool(raw.stretcher, kind !== "stair"),
      fireDoor: bool(raw.fireDoor, false),
      roomDoor: kind === "flat" && (isRoom(nu) || isRoom(nv)),
      blocked: bool(raw.blocked, false),
    });
  }
  // Lift cars pass floors inside the shaft: join every pair of stops in one shaft.
  const shaftOf = new Int32Array(nodes.length).fill(-1);
  const shafts = [];
  for (const n of nodes) {
    if (n.type !== "lift" || shaftOf[n.i] >= 0) continue;
    const members = [];
    const stack = [n.i];
    shaftOf[n.i] = shafts.length;
    while (stack.length) {
      const x = stack.pop();
      members.push(x);
      for (const ei of adj[x]) {
        const e = edges[ei];
        if (e.kind !== "lift") continue;
        const y = e.u === x ? e.v : e.u;
        if (shaftOf[y] < 0) {
          shaftOf[y] = shafts.length;
          stack.push(y);
        }
      }
    }
    shafts.push(members);
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const a = members[x];
        const b = members[y];
        if (adj[a].some((ei) => edges[ei].u === b || edges[ei].v === b)) continue;
        addEdge({ u: a, v: b, kind: "lift", virtual: true, length: Math.abs(nodes[a].floor - nodes[b].floor) * p.floor_height, width: 1.2, effWidth: Math.max(0.3, 1.2 - 2 * p.boundary_layer), wheelchair: true, stretcher: true, fireDoor: false, roomDoor: false, blocked: false });
      }
    }
  }

  const exits = nodes.filter((n) => n.type === "exit").map((n) => n.i);
  if (!exits.length) fail("The building has no exit");
  const refuges = nodes.filter((n) => n.refuge).map((n) => n.i);
  const familiar = data.familiarExit && index.has(data.familiarExit) ? index.get(data.familiarExit) : exits[0];

  const place = (value, what) => {
    const id = text(value, what);
    if (!index.has(id)) fail(`${what}: place "${id}" does not exist`);
    return index.get(id);
  };
  const people = [];
  const codes = new Set();
  const addCode = (code) => {
    if (codes.has(code)) fail(`Code "${code}" is used twice`);
    codes.add(code);
  };
  for (const [i, raw] of (data.patients ?? []).entries()) {
    const code = text(raw.code, `Patient ${i + 1}: code`, 40);
    addCode(code);
    const mobility = text(raw.mobility, `Patient ${code}: mobility`).toLowerCase();
    if (!MOBILITIES.includes(mobility)) fail(`Patient ${code}: mobility "${mobility}" is not one of ${MOBILITIES.join(", ")}`);
    people.push({ kind: "patient", code, mobility, criticality: Math.round(num(raw.criticality ?? 1, `Patient ${code}: criticality`, { min: 1, max: 5 })), home: place(raw.place, `Patient ${code}`) });
  }
  for (const [i, raw] of (data.staff ?? []).entries()) {
    const code = text(raw.code, `Staff ${i + 1}: code`, 40);
    addCode(code);
    people.push({ kind: "staff", code, role: String(raw.role ?? "staff").slice(0, 40), mobility: "ambulatory", criticality: 1, home: place(raw.place, `Staff ${code}`) });
  }
  if (people.length > LIMITS.people) fail(`Too many people (most ${LIMITS.people})`);

  const sensors = [];
  const ids = new Set();
  for (const [i, raw] of (data.sensors ?? []).entries()) {
    const id = text(raw.id, `Sensor ${i + 1}: id`, 40);
    if (ids.has(id)) fail(`Device "${id}" appears twice`);
    ids.add(id);
    let kind = text(raw.kind, `Sensor ${id}: kind`).toLowerCase();
    if (kind === "gas") kind = "co";
    if (!SENSOR_KINDS.includes(kind)) fail(`Sensor ${id}: kind "${kind}" is not one of ${SENSOR_KINDS.join(", ")}`);
    sensors.push({ i: sensors.length, id, kind, node: place(raw.place, `Sensor ${id}`) });
  }
  const cameras = [];
  for (const [i, raw] of (data.cameras ?? []).entries()) {
    const id = text(raw.id, `Camera ${i + 1}: id`, 40);
    if (ids.has(id)) fail(`Device "${id}" appears twice`);
    ids.add(id);
    cameras.push({ id, node: place(raw.place, `Camera ${id}`), count: Math.round(num(raw.count ?? 0, `Camera ${id}: count`, { min: 0, max: 2000 })) });
  }
  if (sensors.length + cameras.length > LIMITS.sensors) fail(`Too many devices (most ${LIMITS.sensors})`);

  const scenarios = [];
  for (const [i, raw] of (data.scenarios ?? []).entries()) scenarios.push(normaliseScenario(raw, index, i));

  const floors = [...new Set(nodes.map((n) => n.floor))].sort((a, b) => a - b);
  const model = { name, synthetic: bool(data.synthetic, false), note: String(data.note ?? ""), nodes, edges, adj, index, exits, refuges, familiar, people, sensors, cameras, floors, scenarios, shaftOf, shafts };
  model.spread = spreadDistances(model, p);
  return model;
}

export function normaliseScenario(raw, index, i = 0) {
  const name = text(raw.name ?? `Scenario ${i + 1}`, `Scenario ${i + 1}: name`, 120);
  const origin = raw.origin === null || raw.origin === undefined || raw.origin === "" ? null : text(raw.origin, `Scenario ${name}: origin`);
  if (origin !== null && !index.has(origin)) fail(`Scenario ${name}: origin "${origin}" does not exist`);
  const closed = (raw.closed ?? []).map((c) => {
    if (!index.has(c)) fail(`Scenario ${name}: closed place "${c}" does not exist`);
    return c;
  });
  const alarm = raw.alarm === "start" ? "start" : "sensors";
  return {
    name,
    alarm,
    origin,
    start: num(raw.start ?? 0, `Scenario ${name}: start`, { min: 0, max: 3600 }),
    smokeRate: origin === null ? 0 : num(raw.smokeRate ?? 0.1, `Scenario ${name}: smoke spread speed`, { positive: true, max: 5 }),
    fireRate: origin === null ? 0 : num(raw.fireRate ?? 0.01, `Scenario ${name}: fire spread speed`, { positive: true, max: 5 }),
    closed,
    note: String(raw.note ?? "").slice(0, 300),
  };
}

export function other(edge, node) {
  return edge.u === node ? edge.v : edge.u;
}

export class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, value) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (k[parent] <= key) break;
      k[i] = k[parent];
      v[i] = v[parent];
      i = parent;
    }
    k[i] = key;
    v[i] = value;
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const topK = k[0];
    const topV = v[0];
    const lastK = k.pop();
    const lastV = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

// Spread factor of a path for smoke: closed fire doors and room doors slow it.
function spreadFactor(e, p) {
  if (e.fireDoor) return p.fire_door_factor;
  if (e.roomDoor) return p.door_factor;
  return 1;
}

// For every possible origin: effective spread distance to each place and how
// many protected enclosures (stairs, lift shafts) smoke must break into.
// Ordered by (breaches, distance). Used by the live estimator and for smoke decay.
export function spreadDistances(model, p) {
  const nN = model.nodes.length;
  const D = [];
  const B = [];
  for (let o = 0; o < nN; o++) {
    const d = new Float64Array(nN).fill(Infinity);
    const b = new Int8Array(nN).fill(99);
    d[o] = 0;
    b[o] = model.nodes[o].protected ? 1 : 0;
    const heap = new MinHeap();
    heap.push(b[o] * 1e6, o);
    while (heap.size) {
      const [key, u] = heap.pop();
      if (key > b[u] * 1e6 + d[u] + 1e-9) continue;
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        const v = other(e, u);
        if (model.nodes[v].type === "exit") continue;
        const nb = b[u] + (model.nodes[v].protected && !model.nodes[u].protected ? 1 : 0);
        const nd = d[u] + e.length / spreadFactor(e, p);
        if (nb < b[v] || (nb === b[v] && nd < d[v] - 1e-9)) {
          b[v] = nb;
          d[v] = nd;
          heap.push(nb * 1e6 + nd, v);
        }
      }
    }
    D.push(d);
    B.push(b);
  }
  return { D, B };
}

// ---------------------------------------------------------------------------
// The real hazard in one run (unknown to the routing, except in "perfect" mode)
// ---------------------------------------------------------------------------

export function makeTruth(model, scenario, p, random) {
  const nN = model.nodes.length;
  const smokeArr = new Float64Array(nN).fill(Infinity);
  const fireArr = new Float64Array(nN).fill(Infinity);
  const decay = new Float64Array(nN).fill(Infinity);
  if (scenario.origin === null) return { none: true, smokeArr, fireArr, decay, rateFactor: 1, smokeRate: 0, origin: null };
  const o = model.index.get(scenario.origin);
  const rateFactor = p.true_rate_low + random() * (p.true_rate_high - p.true_rate_low);
  const mult = model.edges.map(() => logNormal(random, 1, p.true_edge_sd));
  const run = (rate, arr, intoProtected) => {
    arr[o] = scenario.start;
    const heap = new MinHeap();
    heap.push(arr[o], o);
    while (heap.size) {
      const [t, u] = heap.pop();
      if (t > arr[u] + 1e-9) continue;
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        const v = other(e, u);
        const nv = model.nodes[v];
        if (nv.type === "exit") continue;
        if (nv.protected && !intoProtected) continue;
        let nt = t + e.length / (rate * mult[ei] * spreadFactor(e, p));
        if (nv.protected && !model.nodes[u].protected) nt += p.protected_breach_s;
        if (nt < arr[v]) {
          arr[v] = nt;
          heap.push(nt, v);
        }
      }
    }
  };
  run(scenario.smokeRate * rateFactor, smokeArr, true);
  run(scenario.fireRate * rateFactor, fireArr, false);
  const D = model.spread.D[o];
  for (let n = 0; n < nN; n++) decay[n] = D[n];
  return { none: false, origin: o, smokeArr, fireArr, decay, rateFactor, smokeRate: scenario.smokeRate * rateFactor, fireRate: scenario.fireRate * rateFactor, mult };
}

export function truthConditions(truth, n, t, p) {
  return conditionsAt(t, truth.smokeArr[n], truth.fireArr[n], truth.decay[n], p);
}

// ---------------------------------------------------------------------------
// Sensors: noisy readings, faults, debounced detection, health checks
// ---------------------------------------------------------------------------

const KIND_QUANTITY = { smoke: "K", heat: "T", co: "CO" };

export function sensorThreshold(kind, p) {
  return kind === "smoke" ? p.thr_smoke : kind === "heat" ? p.thr_heat : p.thr_co;
}
function sensorNoise(kind, p) {
  return kind === "smoke" ? p.noise_smoke : kind === "heat" ? p.noise_heat : p.noise_co;
}
function sensorBase(kind) {
  return kind === "heat" ? AMBIENT : 0;
}
// Value a sensor would read at the full smoke level, at decay distance d.
function sensorPeak(kind, d, p) {
  const dec = Math.exp(-d / p.decay_m);
  if (kind === "smoke") return p.k_max * dec;
  if (kind === "heat") return AMBIENT + (p.smoke_T_max - AMBIENT) * dec;
  return p.co_max * dec;
}
// Expected time from smoke arrival to detection at distance d (Infinity if never).
export function detectionLag(kind, d, p, threshold = sensorThreshold(kind, p)) {
  const base = sensorBase(kind);
  const peak = sensorPeak(kind, d, p);
  const g = (threshold - base) / (peak - base);
  if (!(g > 0) || g > 1) return Infinity;
  return g * p.grow_s + (p.debounce_m - 0.5) * p.sample_s;
}

export function createSensorNet(model, truth, p, random, { perfect = false, faults = true, falseAlarms = [] } = {}) {
  const sensors = model.sensors.map((s) => {
    let fault = "ok";
    const r0 = random();
    if (!perfect && faults) {
      const r = r0;
      if (r < p.p_dead) fault = "dead";
      else if (r < p.p_dead + p.p_stuck) fault = "stuck";
      else if (r < p.p_dead + p.p_stuck + p.p_drift) fault = "biased";
      else if (r < p.p_dead + p.p_stuck + p.p_drift + p.p_flaky) fault = "flaky";
    }
    return {
      ...s,
      fault,
      burnt: false,
      stuckValue: sensorBase(s.kind) + (s.kind === "smoke" ? 0.004 : s.kind === "heat" ? 1.2 : 3),
      history: [], // [t, value] delivered
      recent: [], // last three delivered values above threshold flags
      lastAt: -Infinity,
      detectedAt: null, // sample time of detection
      status: "ok", // ok | no data | stuck | burnt
      latest: null,
    };
  });
  const queue = []; // readings in the network: {at, s, t, value}
  const spikes = falseAlarms.map((f) => ({ ...f }));
  const net = { sensors, newDetections: [] };

  net.sample = (t) => {
    if (t % p.sample_s !== 0) return;
    for (const s of sensors) {
      if (s.fault === "dead" || s.burnt) continue;
      const c = truth.none ? { T: AMBIENT, CO: 0, K: 0, smoke: false } : truthConditions(truth, s.node, t, p);
      if (c.T > p.sensor_burn_T) {
        s.burnt = true;
        continue;
      }
      if (s.fault === "flaky" && random() < p.flaky_loss) continue;
      let value;
      if (s.fault === "stuck") value = s.stuckValue;
      else {
        value = c[KIND_QUANTITY[s.kind]] + (perfect ? 0 : normal(random, 0, sensorNoise(s.kind, p)));
        if (s.fault === "biased") value += 0.4 * (sensorThreshold(s.kind, p) - sensorBase(s.kind));
        for (const f of spikes) if (f.sensor === s.id && t >= f.t && t < f.t + 30) value = Math.max(value, sensorThreshold(s.kind, p) * 1.6 + sensorBase(s.kind) * 0.5);
      }
      queue.push({ at: t + p.net_delay_s, s: s.i, t, value });
    }
  };

  // Readings that arrive by time now; returns new detections.
  net.deliver = (now) => {
    net.newDetections = [];
    let k = 0;
    while (k < queue.length) {
      const r = queue[k];
      if (r.at > now) {
        k++;
        continue;
      }
      queue.splice(k, 1);
      const s = sensors[r.s];
      s.lastAt = r.t;
      s.latest = r.value;
      s.history.push([r.t, r.value]);
      if (s.history.length > 400) s.history.shift();
      s.recent.push(r.value >= sensorThreshold(s.kind, p));
      if (s.recent.length > 3) s.recent.shift();
      if (s.detectedAt === null && s.recent.filter(Boolean).length >= p.debounce_m) {
        s.detectedAt = r.t;
        net.newDetections.push(s);
      }
    }
    // Health checks the system can do itself (it cannot see the true fault)
    for (const s of sensors) {
      if (s.burnt && now - s.lastAt > 3 * p.sample_s) s.status = "burnt";
      else if (now - s.lastAt > 3 * p.sample_s + p.net_delay_s) s.status = "no data";
      else if (!perfect && s.history.length >= 12) {
        const last = s.history.slice(-12);
        const same = last.every((h) => h[1] === last[0][1]);
        s.status = same ? "stuck" : "ok";
      } else s.status = "ok";
    }
    return net.newDetections;
  };
  net.addSpike = (sensorId, t) => spikes.push({ sensor: sensorId, t });
  return net;
}

// ---------------------------------------------------------------------------
// Live hazard estimate (situation layer)
// ---------------------------------------------------------------------------

function fitLine(pts, use, s0, sMin, sMax) {
  let sw = 0;
  let sd = 0;
  let sy = 0;
  let n = 0;
  pts.forEach((q, k) => {
    if (!use[k]) return;
    sw += q.w;
    sd += q.w * q.d;
    sy += q.w * q.y;
    n++;
  });
  const md = sd / sw;
  const my = sy / sw;
  let sdd = 0;
  let sdy = 0;
  pts.forEach((q, k) => {
    if (!use[k]) return;
    sdd += q.w * (q.d - md) ** 2;
    sdy += q.w * (q.d - md) * (q.y - my);
  });
  let s = n >= 2 && sdd > 25 ? sdy / sdd : s0;
  if (!(s > 0)) s = s0;
  s = clamp(s, sMin, sMax);
  return { t0: my - s * md, s };
}

// detections: [{node, t, kind, w, threshold?}], silent: [{node, kind, threshold?}]
// (healthy sensors that have not detected), now, prior slowness s0 (s/m).
// Fits, for every candidate origin o, arrival(n) = t0 + s * D[o][n] (+ breach),
// with detection lag from the smoke growth model. Returns the best fit and a
// conservative arrival estimate (earliest among plausible origins).
export function estimateHazard(model, allDetections, silent, now, p, s0, lagOf = null) {
  const nN = model.nodes.length;
  const lagFn = lagOf ?? ((kind, thr, o, n) => detectionLag(kind, model.spread.D[o][n], p, thr));
  if (!allDetections.length) return null;
  // The earliest detections fix the origin; later ones mostly the speed.
  // Use the first 12 and an even sample of up to 12 more (keeps the fit fast).
  const sorted = [...allDetections].sort((a, b) => a.t - b.t);
  let detections = sorted.slice(0, 12);
  const rest = sorted.slice(12);
  if (rest.length) {
    const step = Math.max(1, rest.length / 12);
    for (let k = 0; k < rest.length && detections.length < 24; k += step) detections.push(rest[Math.floor(k)]);
  }
  const { D, B } = model.spread;
  const sMin = 1 / p.est_v_max;
  const sMax = 1 / p.est_v_min;
  const sig2 = p.est_sigma_s ** 2;
  const cap2 = (8 * p.est_sigma_s) ** 2;
  const tol = 2 * p.sample_s + p.net_delay_s + p.est_sigma_s;
  const fits = [];
  for (let o = 0; o < nN; o++) {
    const no = model.nodes[o];
    if (no.type === "exit" || no.protected) continue;
    const Do = D[o];
    const Bo = B[o];
    // first pass: lags, regress y = t0 + s d
    const pts = [];
    let bad = 0;
    for (const det of detections) {
      const d = Do[det.node];
      if (!Number.isFinite(d)) {
        bad += det.w;
        continue;
      }
      const lag = lagFn(det.kind, det.threshold, o, det.node);
      if (!Number.isFinite(lag)) {
        bad += det.w;
        continue;
      }
      pts.push({ d, y: det.t - lag - Bo[det.node] * p.protected_breach_s, w: det.w, det });
    }
    if (!pts.length) continue;
    // Robust line fit: drop detections that disagree by more than 3 sigma
    // (a faulty sensor, a false alarm), at most a third of them.
    let use = pts.map(() => true);
    let fit = fitLine(pts, use, s0, sMin, sMax);
    const maxDrop = Math.min(4, Math.floor(pts.length / 3));
    for (let drop = 0; drop < maxDrop; drop++) {
      let worst = -1;
      let worstR = 3 * p.est_sigma_s;
      pts.forEach((q, k) => {
        if (!use[k]) return;
        const r = Math.abs(q.y - fit.t0 - fit.s * q.d);
        if (r > worstR) {
          worstR = r;
          worst = k;
        }
      });
      if (worst < 0) break;
      use[worst] = false;
      fit = fitLine(pts, use, s0, sMin, sMax);
    }
    const { t0, s } = fit;
    let score = bad * cap2;
    pts.forEach((q, k) => {
      score += use[k] ? q.w * Math.min(cap2, (q.y - t0 - s * q.d) ** 2) : q.w * 9 * sig2;
    });
    for (const sil of silent) {
      const d = Do[sil.node];
      if (!Number.isFinite(d)) continue;
      const lag = lagFn(sil.kind, sil.threshold, o, sil.node);
      if (!Number.isFinite(lag)) continue;
      const pred = t0 + s * d + Bo[sil.node] * p.protected_breach_s + lag;
      if (pred < now - tol) score += Math.min(cap2, (now - tol - pred) ** 2) * 0.5;
    }
    score += sig2 * ((s - s0) / s0) ** 2 * 0.25; // weak pull to the design speed
    fits.push({ o, t0, s, score, outliers: pts.filter((_, k) => !use[k]).map((q) => q.det) });
  }
  if (!fits.length) return null;
  fits.sort((a, b) => a.score - b.score);
  const best = fits[0];
  const plausible = fits.filter((f) => f.score <= best.score + 4 * sig2).slice(0, 6);
  const arrival = new Float64Array(nN).fill(Infinity);
  const fireArrival = new Float64Array(nN).fill(Infinity);
  const decay = new Float64Array(nN).fill(Infinity);
  for (const f of plausible) {
    const Do = D[f.o];
    const Bo = B[f.o];
    const sFire = f.s * (p._fireSlownessRatio ?? 8);
    for (let n = 0; n < nN; n++) {
      if (!Number.isFinite(Do[n])) continue;
      const a = f.t0 + f.s * Do[n] + Bo[n] * p.protected_breach_s;
      if (a < arrival[n]) {
        arrival[n] = a;
        decay[n] = Do[n];
      }
      if (!model.nodes[n].protected) fireArrival[n] = Math.min(fireArrival[n], f.t0 + sFire * Do[n]);
    }
  }
  // Places where a detection that fits happened: the hazard is there.
  for (const det of allDetections) {
    if (best.outliers.includes(det)) continue;
    const lag = lagFn(det.kind, det.threshold, best.o, det.node);
    const a = Number.isFinite(lag) ? det.t - lag : det.t;
    if (a < arrival[det.node]) arrival[det.node] = a;
    if (!Number.isFinite(decay[det.node])) decay[det.node] = D[best.o][det.node];
  }
  return { origin: best.o, t0: best.t0, slowness: best.s, rate: 1 / best.s, score: best.score, outliers: best.outliers.map((d) => d.node), plausible: plausible.map((f) => ({ o: f.o, rate: 1 / f.s, t0: f.t0 })), arrival, fireArrival, decay };
}

// Hazard picture used by the planner: arrival, fire arrival, decay distance per place.
function offlinePicture(model, scenario, p) {
  const nN = model.nodes.length;
  const arrival = new Float64Array(nN).fill(Infinity);
  const fireArrival = new Float64Array(nN).fill(Infinity);
  const decay = new Float64Array(nN).fill(Infinity);
  if (scenario.origin === null) return { arrival, fireArrival, decay, origin: null };
  const o = model.index.get(scenario.origin);
  const { D, B } = model.spread;
  for (let n = 0; n < nN; n++) {
    if (!Number.isFinite(D[o][n])) continue;
    arrival[n] = scenario.start + D[o][n] / scenario.smokeRate + B[o][n] * p.protected_breach_s;
    if (!model.nodes[n].protected) fireArrival[n] = scenario.start + D[o][n] / scenario.fireRate;
    decay[n] = D[o][n];
  }
  return { arrival, fireArrival, decay, origin: o, rate: scenario.smokeRate, t0: scenario.start };
}

// ---------------------------------------------------------------------------
// Movement rules per mobility class
// ---------------------------------------------------------------------------

export const STEP_FREE = new Set(["wheelchair", "stretcher", "ventilator"]);
export function mobilityClass(mobility) {
  if (mobility === "wheelchair") return "chair";
  if (mobility === "stretcher" || mobility === "ventilator") return "bed";
  return "walk";
}

// Can a group of this class use edge e to reach node `to`?
export function edgeAllowed(model, e, to, cls, closed) {
  if (e.blocked || closed.has(to)) return false;
  // Wheelchairs and beds never pass through a stair place (HEALTH-11 rule).
  if ((cls === "chair" || cls === "bed") && model.nodes[to].type === "stair") return false;
  if (e.kind === "stair") return cls === "walk" || cls === "rescue" || cls === "carry";
  if (e.kind === "lift") {
    if (cls !== "chair" && cls !== "bed") return false;
    return model.nodes[e.u].evacLift && model.nodes[e.v].evacLift;
  }
  if (cls === "chair" && !e.wheelchair) return false;
  if (cls === "bed" && !e.stretcher) return false;
  return true;
}

export function escortsNeeded(mobility, p) {
  if (mobility === "wheelchair") return Math.max(1, Math.round(p.escort_wheelchair));
  if (mobility === "stretcher" || mobility === "ventilator") return Math.max(1, Math.round(p.escort_bed));
  return 0;
}

// Plain shortest distance path (used for "nearest exit", people without
// guidance and the PROJECT test case). avoid: Set of nodes not to enter.
export function shortestPath(model, from, targets, cls, avoid = new Set(), closed = new Set()) {
  const nN = model.nodes.length;
  const dist = new Float64Array(nN).fill(Infinity);
  const prevE = new Int32Array(nN).fill(-1);
  dist[from] = 0;
  const heap = new MinHeap();
  heap.push(0, from);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (targets.has(u) && u !== from) return unwind(model, from, u, prevE, d);
    if (targets.has(u) && u === from) return { nodes: [from], edges: [], length: 0 };
    for (const ei of model.adj[u]) {
      const e = model.edges[ei];
      const v = other(e, u);
      if (avoid.has(v) && !targets.has(v)) continue;
      if (!edgeAllowed(model, e, v, cls, closed)) continue;
      const nd = d + e.length;
      if (nd < dist[v] - 1e-9) {
        dist[v] = nd;
        prevE[v] = ei;
        heap.push(nd, v);
      }
    }
  }
  return null;
}

// The four algorithms of the main HEALTH-11 app, for a static plan:
// bfs = fewest steps, dfs = first way found going deep (not shortest),
// dijkstra = shortest distance, astar = shortest distance guided by straight-line distance.
export const CLASSIC = ["bfs", "dfs", "dijkstra", "astar"];
export function classicRoute(model, from, targets, cls, algorithm, closed = new Set(), avoid = new Set(), floorHeight = 4) {
  if (targets.has(from)) return { nodes: [from], edges: [], length: 0, explored: 1 };
  const ok = (e, v) => !(avoid.has(v) && !targets.has(v)) && edgeAllowed(model, e, v, cls, closed);
  const nN = model.nodes.length;
  const prevE = new Int32Array(nN).fill(-1);
  const seen = new Uint8Array(nN);
  let explored = 0;
  if (algorithm === "bfs") {
    const queue = [from];
    seen[from] = 1;
    while (queue.length) {
      const u = queue.shift();
      explored++;
      if (targets.has(u)) return { ...unwind(model, from, u, prevE, 0), explored };
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        const v = other(e, u);
        if (seen[v] || !ok(e, v)) continue;
        seen[v] = 1;
        prevE[v] = ei;
        queue.push(v);
      }
    }
    return null;
  }
  if (algorithm === "dfs") {
    const stack = [from];
    while (stack.length) {
      const u = stack.pop();
      if (seen[u]) continue;
      seen[u] = 1;
      explored++;
      if (targets.has(u)) return { ...unwind(model, from, u, prevE, 0), explored };
      const next = model.adj[u].slice().reverse();
      for (const ei of next) {
        const e = model.edges[ei];
        const v = other(e, u);
        if (seen[v] || !ok(e, v)) continue;
        prevE[v] = ei;
        stack.push(v);
      }
    }
    return null;
  }
  // dijkstra and astar
  const tlist = [...targets].map((t) => model.nodes[t]);
  const h = (u) => {
    if (algorithm !== "astar") return 0;
    const a = model.nodes[u];
    let best = Infinity;
    for (const b of tlist) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y, (a.floor - b.floor) * floorHeight));
    return best;
  };
  const dist = new Float64Array(nN).fill(Infinity);
  dist[from] = 0;
  const heap = new MinHeap();
  heap.push(h(from), from);
  while (heap.size) {
    const [f, u] = heap.pop();
    if (seen[u]) continue;
    seen[u] = 1;
    explored++;
    void f;
    if (targets.has(u)) return { ...unwind(model, from, u, prevE, dist[u]), explored };
    for (const ei of model.adj[u]) {
      const e = model.edges[ei];
      const v = other(e, u);
      if (!ok(e, v)) continue;
      const nd = dist[u] + e.length;
      if (nd < dist[v] - 1e-9) {
        dist[v] = nd;
        prevE[v] = ei;
        heap.push(nd + h(v), v);
      }
    }
  }
  return null;
}

function unwind(model, from, to, prevE, cost) {
  const nodes = [to];
  const edges = [];
  let x = to;
  while (x !== from) {
    const ei = prevE[x];
    edges.push(ei);
    x = other(model.edges[ei], x);
    nodes.push(x);
  }
  nodes.reverse();
  edges.reverse();
  let length = 0;
  for (const ei of edges) length += model.edges[ei].length;
  return { nodes, edges, length, cost };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

const TERMINAL = new Set(["out", "refuge", "incapacitated"]);

export function createSimulation(model, scenarioIn, options = {}) {
  const p = { ...defaultParams(), ...(options.params ?? {}) };
  const method = options.method ?? "proposed";
  if (!METHODS[method]) fail(`Unknown method "${method}"`);
  const perfectInfo = options.info === "perfect";
  const hazardInfo = perfectInfo ? "perfect" : options.hazardInfo ?? "live";
  if (!HAZARD_INFO[hazardInfo]) fail(`Unknown hazard information "${hazardInfo}"`);
  const strategy = options.strategy ?? "horizontal";
  const algorithm = options.algorithm ?? "dijkstra";
  if (!CLASSIC.includes(algorithm)) fail(`Unknown algorithm "${algorithm}"`);
  const confirmMode = options.confirm ?? "auto";
  const useRescue = options.rescue !== false;
  const frameEvery = options.frameEvery ?? 0;
  const scenario = scenarioIn.closed !== undefined ? scenarioIn : normaliseScenario(scenarioIn, model.index);
  const random = makeRandom(options.seed ?? 1);
  const behaviourRandom = makeRandom((options.seed ?? 1) * 7919 + 13);
  const nN = model.nodes.length;
  const nE = model.edges.length;
  const exitSet = new Set(model.exits);
  const closed = new Set(scenario.closed.map((c) => model.index.get(c)));
  for (const n of model.nodes) if (n.blocked) closed.add(n.i);
  p._fireSlownessRatio = scenario.fireRate > 0 && scenario.smokeRate > 0 ? scenario.smokeRate / scenario.fireRate : 8;
  const s0 = 1 / (scenario.smokeRate > 0 ? scenario.smokeRate : p.est_default_rate);

  // ----- the real hazard and sensors
  const truth = makeTruth(model, scenario, p, random);
  const net = createSensorNet(model, truth, p, random, { perfect: perfectInfo, faults: options.sensorFaults !== false, falseAlarms: options.falseAlarms ?? [] });
  const offline = offlinePicture(model, scenario, p);
  const cond = new Array(nN);
  const updateConditions = (t) => {
    for (let n = 0; n < nN; n++) cond[n] = truth.none ? { T: AMBIENT, CO: 0, K: 0, fire: false, smoke: false } : truthConditions(truth, n, t, p);
  };
  updateConditions(0);

  // ----- edges and flow
  const edgeState = model.edges.map((e) => {
    const k = e.kind === "stair" ? p.k_stair : p.k_level;
    return {
      load: 0,
      tokens: 0,
      rate: maxSpecificFlow(k, p) * e.effWidth,
      storage: Math.max(4, e.length * e.effWidth * p.d_max),
      maxDensity: 0,
      maxQueue: 0,
      used: 0,
      waiting: 0,
      area: e.length * e.effWidth,
    };
  });
  const biggest = Math.max(1, p.space_bed, p.space_wheelchair);
  const nBuckets = Math.ceil(p.horizon_s / p.bucket_s);
  const reserved = new Float32Array(nE * nBuckets);
  let reservedAt = 0;

  // ----- lifts
  const shafts = model.shafts.map((members, id) => {
    const ground = members.reduce((a, b) => (model.nodes[a].floor <= model.nodes[b].floor ? a : b));
    return { id, members, carFloor: model.nodes[ground].floor, freeAt: 0, queue: [], trips: 0 };
  });

  // ----- people
  const agents = [];
  const newAgent = (props) => {
    const a = {
      id: agents.length, state: "waiting", node: props.home, route: null, ri: 0, edge: -1, pos: 0,
      waitSince: 0, startAt: Infinity, fed: 0, maxRisk: 0, reachedByHazard: false, outAt: null, safeAt: null, exit: null,
      helpers: [], helping: -1, needs: 0, coming: [], prep: 0, trips: 0, space: 1, lift: null, seen: new Set(),
      guidance: "signs", target: null, routeChanges: 0, lastMsg: -1, waitingEdgeSince: null, alternatives: null,
      rescuedBy: -1, carrying: -1, ...props,
    };
    agents.push(a);
    return a;
  };
  for (const person of model.people) {
    const a = newAgent({ kind: person.kind, code: person.code, role: person.role, mobility: person.mobility, criticality: person.criticality, home: person.home });
    if (a.kind === "staff") {
      a.free = clamp(normal(random, p.speed_staff, p.speed_staff_sd), 0.65, 2.05);
      a.premove = logNormal(random, p.staff_premove_mean, p.staff_premove_sd);
      a.guidance = "radio";
    } else if (a.mobility === "ambulatory") {
      a.free = p.speed_patient_min + random() * (p.speed_patient_max - p.speed_patient_min);
      a.premove = clamp(normal(random, p.prep_ambulatory_mean, p.prep_ambulatory_sd), 30, 90);
    } else if (a.mobility === "wheelchair") {
      a.free = Math.max(0.1, normal(random, p.speed_wheelchair, p.speed_transport_sd));
      a.prep = clamp(normal(random, p.prep_wheelchair_mean, p.prep_wheelchair_sd), 100, 120);
      a.needs = escortsNeeded("wheelchair", p);
      a.space = p.space_wheelchair;
      a.guidance = "radio";
    } else {
      a.free = Math.max(0.1, normal(random, p.speed_bed, p.speed_transport_sd));
      a.prep = clamp(normal(random, p.prep_bed_mean, p.prep_bed_sd), 180, 900);
      a.needs = escortsNeeded(a.mobility, p);
      a.space = p.space_bed;
      a.guidance = "radio";
    }
  }
  if (options.visitors !== false) {
    for (const cam of model.cameras) {
      const count = options.cameraCounts?.[cam.id] ?? cam.count;
      for (let k = 0; k < count; k++) {
        newAgent({ kind: "visitor", code: `${cam.id}-V${k + 1}`, mobility: "ambulatory", criticality: 1, home: cam.node, free: p.speed_visitor, premove: Math.max(0, normal(random, p.visitor_premove_mean, p.visitor_premove_sd)) });
      }
    }
  }
  // Imperfect information: who has a phone, who follows guidance, which exit they know.
  for (const a of agents) {
    if (a.kind === "staff" || a.needs > 0) continue;
    const phoneShare = a.kind === "visitor" ? p.phone_visitor : p.phone_patient;
    const complies = perfectInfo || behaviourRandom() < p.compliance;
    const phone = perfectInfo || behaviourRandom() < phoneShare;
    a.guidance = !complies ? "none" : phone ? "phone" : "signs";
    a.knownExit = behaviourRandom() < p.familiar_share ? model.familiar : null;
  }
  const people = agents.length;
  const signWorks = new Map();
  for (const n of model.nodes) if (n.sign) signWorks.set(n.i, perfectInfo || behaviourRandom() >= p.sign_fail);

  // Rescue teams (created when they arrive)
  const teams = [];

  // ----- state
  const alerts = [];
  const sim = {
    model, p, method, hazardInfo, strategy, scenario, truth, net, agents, alerts, teams, shafts, edgeState,
    t: 0, alarmAt: scenario.alarm === "start" ? 0 : null, alarmReason: scenario.alarm === "start" ? "Alarm at the start (drill or reported fire)" : null,
    events: [], frames: [], curve: [[0, 0]], estimates: [], done: false,
    estimate: null, picture: null, signs: new Map(), signChanges: 0, messages: 0, alternativeSwitches: 0, fallbackAgents: new Set(), shelters: 0,
    reports: [], dismissedSensors: new Set(), exitCount: new Map(model.exits.map((x) => [x, 0])), people, nextPlan: 0, planVersion: 0,
    groupRoutes: [],
  };
  const log = (message, kind = "info") => sim.events.push({ t: sim.t, message, kind });
  const startAll = () => {
    for (const a of agents) if (a.kind !== "rescue") a.startAt = sim.alarmAt + (a.premove ?? 0);
  };
  if (sim.alarmAt === 0) startAll();
  const raiseAlarm = (reason) => {
    if (sim.alarmAt !== null) return;
    sim.alarmAt = sim.t;
    sim.alarmReason = reason;
    log(`Alarm: ${reason}`, "alarm");
    startAll();
    sim.nextPlan = sim.t;
  };

  // ----- alerts (the commander confirms)
  const confirmAlert = (id) => {
    const al = alerts.find((x) => x.id === id);
    if (!al || al.status !== "new") return false;
    al.status = "confirmed";
    al.decidedAt = sim.t;
    log(`Commander confirmed the ${al.kind} alert at ${model.nodes[al.node].id}`, "alert");
    raiseAlarm(`${al.kind} alert at ${model.nodes[al.node].id} confirmed`);
    sim.nextPlan = sim.t;
    return true;
  };
  const dismissAlert = (id) => {
    const al = alerts.find((x) => x.id === id);
    if (!al || al.status !== "new") return false;
    al.status = "dismissed";
    al.decidedAt = sim.t;
    sim.dismissedSensors.add(al.sensor);
    log(`Commander dismissed the ${al.kind} alert at ${model.nodes[al.node].id}`, "alert");
    return true;
  };
  sim.confirm = confirmAlert;
  sim.plannerRisk = (n, t = sim.t) => Math.min(1, riskAt(n, t));
  sim.dismiss = dismissAlert;
  // A new hazard during the run: a place becomes impassable now (dynamic re-routing).
  sim.blockPlace = (n, reason = "blocked") => {
    if (n < 0 || n >= nN || exitSet.has(n) && model.exits.length <= 1) return false;
    closed.add(n);
    knownBlocked.add(n);
    log(`${model.nodes[n].id} is ${reason}: routes are planned again`, "alarm");
    for (const a of agents) if (a.route && a.route.nodes.slice(a.ri + 1).includes(n)) a.needsReroute = true;
    updateMeasured();
    sim.nextPlan = sim.t;
    return true;
  };
  sim.algorithm = algorithm;
  sim.injectFalseAlarm = (sensorId) => net.addSpike(sensorId, sim.t + (p.sample_s - (sim.t % p.sample_s)));

  // ----- hazard picture for the planner
  const knownBlocked = new Set(); // places people saw full of smoke or fire
  const lagTables = {};
  const lagOf = (kind, thr, o, n) => {
    const key = thr === undefined ? kind : `${kind}:${thr}`;
    let tab = lagTables[key];
    if (!tab) {
      tab = new Float64Array(nN * nN).fill(NaN);
      lagTables[key] = tab;
    }
    const i = o * nN + n;
    let v = tab[i];
    if (Number.isNaN(v)) {
      v = detectionLag(kind, model.spread.D[o][n], p, thr);
      tab[i] = v;
    }
    return v;
  };
  const detectionsForEstimate = () => {
    const det = [];
    const silent = [];
    for (const s of net.sensors) {
      if (sim.dismissedSensors.has(s.id)) continue;
      if (s.detectedAt !== null && s.status !== "stuck") det.push({ node: s.node, t: s.detectedAt, kind: s.kind, w: 1 });
      else if (s.status === "ok") silent.push({ node: s.node, kind: s.kind });
    }
    for (const r of sim.reports) det.push({ node: r.node, t: r.t, kind: "smoke", w: 0.5, threshold: p.report_k });
    return { det, silent };
  };
  const updatePicture = () => {
    if (hazardInfo === "perfect") {
      sim.picture = truth.none ? null : { arrival: truth.smokeArr, fireArrival: truth.fireArr, decay: truth.decay, origin: truth.origin, rate: truth.smokeRate };
    } else if (hazardInfo === "offline") {
      sim.picture = offline.origin === null ? null : offline;
    } else {
      const { det, silent } = detectionsForEstimate();
      // Coincidence check: one detection alone (often a faulty sensor) raises the
      // alarm and is used for routing, but people already safe in a refuge are only
      // moved again on a forecast after a second detection close in time, a phone
      // report or a commander's confirmation (otherwise only on what is measured there).
      const confirmedByCommander = confirmMode === "manual" && alerts.some((x) => x.status === "confirmed");
      // Detections count together only when they come within est_window_s of each other
      // (faulty sensors in different places hours apart do not confirm each other).
      const times = det.map((d) => d.t).sort((a, b) => a - b);
      let together = times.length ? 1 : 0;
      for (let i = 0, j = 0; j < times.length; j++) {
        while (times[j] - times[i] > p.est_window_s) i++;
        together = Math.max(together, j - i + 1);
      }
      const corroborated = together >= p.est_min_detections || confirmedByCommander;
      const est = estimateHazard(model, det, silent, sim.t, p, s0, lagOf);
      sim.corroborated = corroborated;
      sim.estimate = est;
      sim.picture = est;
    }
    if (sim.picture && !truth.none) {
      // How good is the picture? Mean absolute error of arrival times (places the smoke really reaches).
      let se = 0;
      let k = 0;
      for (let n = 0; n < nN; n++) {
        if (model.nodes[n].protected || model.nodes[n].type === "exit") continue;
        const real = truth.smokeArr[n];
        const est = sim.picture.arrival[n];
        if (!Number.isFinite(real) || real > p.time_limit_s) continue;
        se += Math.abs((Number.isFinite(est) ? est : p.time_limit_s * 2) - real);
        k++;
      }
      const originErr = sim.picture.origin === null || sim.picture.origin === undefined ? null : model.spread.D[truth.origin][sim.picture.origin];
      sim.estimates.push({ t: sim.t, mae: k ? se / k : null, origin: sim.picture.origin, originError: Number.isFinite(originErr) ? originErr : null, rate: sim.picture.rate ?? null, trueRate: truth.smokeRate });
    }
    pictureVersion++;
  };

  // Predicted conditions (planner's view) at place n, time t.
  const predicted = (n, t) => {
    const pic = sim.picture;
    if (!pic) return null;
    return conditionsAt(t, pic.arrival[n], pic.fireArrival[n], Number.isFinite(pic.decay[n]) ? pic.decay[n] : 0, p);
  };
  const measuredRisk = new Float64Array(nN);
  const updateMeasured = () => {
    measuredRisk.fill(0);
    for (const s of net.sensors) {
      // Only sensors that have passed the (debounced) alarm level count: noise below it is ignored.
      if (s.status !== "ok" || s.latest === null || s.detectedAt === null || sim.dismissedSensors.has(s.id)) continue;
      const c = { T: AMBIENT, CO: 0, K: 0, fire: false, smoke: true };
      c[KIND_QUANTITY[s.kind]] = s.latest;
      const r = s.kind === "heat" && s.latest > 200 ? FIRE_RISK : riskRaw(c, p);
      measuredRisk[s.node] = Math.max(measuredRisk[s.node], r);
    }
    for (const n of knownBlocked) measuredRisk[n] = Math.max(measuredRisk[n], 1);
    pictureVersion++;
  };
  const usePrediction = method === "proposed";
  // Risk and dose rate the planner expects at place n, time t. Cached per
  // place and 5 s slot until the time or the hazard picture changes.
  const nSlots = Math.ceil(p.horizon_s / p.bucket_s) + 1;
  const riskCache = new Float64Array(nN * nSlots);
  const fedCache = new Float64Array(nN * nSlots);
  let cacheT = -1;
  let cacheVersion = -1;
  let pictureVersion = 0;
  const fill = (n, slot, t) => {
    let r = measuredRisk[n];
    let f = Math.min(measuredRisk[n], 5) / (p.risk_window_min * 60);
    if (sim.picture && (usePrediction || method === "safe")) {
      const c = predicted(n, usePrediction ? t : sim.t);
      if (c) {
        r = Math.max(r, riskRaw(c, p));
        if (usePrediction) f = Math.max(f, fedPerSecond(c, p));
      }
    }
    riskCache[n * nSlots + slot] = r;
    fedCache[n * nSlots + slot] = f;
  };
  const slotOf = (n, t) => {
    if (cacheT !== sim.t || cacheVersion !== pictureVersion) {
      riskCache.fill(NaN);
      cacheT = sim.t;
      cacheVersion = pictureVersion;
    }
    const slot = clamp(Math.floor((t - sim.t) / p.bucket_s), 0, nSlots - 1);
    if (Number.isNaN(riskCache[n * nSlots + slot])) fill(n, slot, sim.t + slot * p.bucket_s);
    return n * nSlots + slot;
  };
  // Risk the planner believes place n will have at time t.
  const riskAt = (n, t) => (model.nodes[n].type === "exit" ? 0 : riskCache[slotOf(n, t)]);
  const fedRateAt = (n, t) => (model.nodes[n].type === "exit" ? 0 : fedCache[slotOf(n, t)]);

  // ----- congestion forecast (reservations)
  const bucketOf = (t) => Math.floor((t - reservedAt) / p.bucket_s);
  const reservedSpace = (ei, t) => {
    const b = bucketOf(t);
    if (b < 0 || b >= nBuckets) return 0;
    return reserved[ei * nBuckets + b];
  };
  const reserve = (route, times, space) => {
    for (let k = 0; k < route.edges.length; k++) {
      const ei = route.edges[k];
      const b0 = Math.max(0, bucketOf(times[k]));
      const b1 = Math.min(nBuckets - 1, bucketOf(times[k + 1]));
      for (let b = b0; b <= b1; b++) reserved[ei * nBuckets + b] += space;
    }
  };

  // Representative free speed of a group of class cls.
  const classSpeed = (cls) => (cls === "chair" ? p.speed_wheelchair : cls === "bed" ? p.speed_bed : cls === "rescue" ? p.rescue_speed : cls === "carry" ? p.carry_speed : p.speed_visitor);

  // Time to cross edge e entered at time t by class cls (forecast).
  const crossTime = (e, t, cls, useForecast) => {
    const es = edgeState[e.i];
    if (e.kind === "lift") {
      const sh = shafts[model.shaftOf[e.u]];
      const cycle = (2 * Math.abs(model.nodes[e.u].floor - model.nodes[e.v].floor) * p.floor_height) / p.lift_speed + p.lift_door_s;
      const waiting = sh.queue.length + (useForecast ? reservedSpace(e.i, t) / Math.max(1, p.space_bed) : 0);
      return Math.max(0, sh.freeAt - sim.t) + Math.ceil(waiting / Math.max(1, p.lift_capacity / p.space_bed)) * cycle + cycle / 2;
    }
    let rho = 0;
    if (useForecast) {
      rho = (reservedSpace(e.i, t) + (t - sim.t < p.bucket_s ? es.load : 0)) / es.area;
    }
    let v = classSpeed(cls) * speedFraction(Math.min(rho, p.d_max), p);
    if (e.kind === "stair") v *= p.k_stair / p.k_level;
    let tt = e.length / v;
    if (useForecast && rho >= p.d_max) tt += p.bucket_s;
    return tt;
  };

  // Forward time-dependent search from `from` at time t0 to a virtual exit
  // node joined to all targets (targetCost: node -> extra cost or undefined).
  // mode: method name or "rescue". Returns {nodes, edges, times, cost, maxRisk} or null.
  const search = (from, t0, cls, targetCost, opts = {}) => {
    const theta = opts.theta ?? p.theta;
    const penal = opts.penalty ?? null;
    const avoid = opts.avoid ?? null;
    const mode = opts.mode ?? method;
    const forecast = mode === "proposed" || mode === "congestion" || mode === "rescue";
    const exposure = mode === "proposed" || mode === "rescue";
    const filter = mode !== "nearest";
    const alpha = mode === "rescue" ? p.alpha / 10 : p.alpha;
    const cost = new Float64Array(nN).fill(Infinity);
    const time = new Float64Array(nN).fill(Infinity);
    const prevE = new Int32Array(nN).fill(-1);
    cost[from] = 0;
    time[from] = t0;
    const heap = new MinHeap();
    heap.push(0, from);
    let best = Infinity;
    let bestNode = -1;
    while (heap.size) {
      const [c, u] = heap.pop();
      if (c > cost[u] + 1e-9) continue;
      if (c >= best) break;
      const tc = targetCost(u);
      if (tc !== undefined && c + tc < best) {
        best = c + tc;
        bestNode = u;
      }
      if (u !== from && exitSet.has(u)) continue;
      for (const ei of model.adj[u]) {
        const e = model.edges[ei];
        const v = other(e, u);
        if (!edgeAllowed(model, e, v, cls, closed)) continue;
        if (avoid && avoid.has(v) && targetCost(v) === undefined) continue;
        const tu = time[u];
        const dur = mode === "nearest" ? e.length / classSpeed(cls) : mode === "safe" ? crossTime(e, tu, cls, false) : crossTime(e, tu, cls, forecast);
        const tv = tu + dur;
        if (filter && !exitSet.has(v)) {
          const r = riskAt(v, tv);
          if (r >= theta && v !== from) continue;
        }
        if (mode === "nearest" && knownBlocked.has(v)) continue;
        let step = mode === "nearest" || mode === "safe" ? (mode === "nearest" ? e.length : dur) : dur;
        if (exposure) step += alpha * ((fedRateAt(u, tu) + fedRateAt(v, tv)) / 2) * dur;
        if (penal && penal.has(ei)) step *= penal.get(ei);
        const nc = c + step;
        if (nc < cost[v] - 1e-9) {
          cost[v] = nc;
          time[v] = tv;
          prevE[v] = ei;
          heap.push(nc, v);
        }
      }
    }
    if (opts.all) return { cost, time, prevE };
    if (bestNode < 0) return null;
    const r = unwind(model, from, bestNode, prevE, best);
    r.times = r.nodes.map((n) => time[n]);
    r.cost = best;
    r.end = bestNode;
    let mr = 0;
    for (let k = 1; k < r.nodes.length; k++) mr = Math.max(mr, riskAt(r.nodes[k], r.times[k]));
    r.maxRisk = mr;
    return r;
  };

  // Least-risk fallback: smallest theta that still connects (bottleneck search on risk).
  const leastRiskTheta = (from, t0, cls, targetCost, mode) => {
    const levels = [0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 10, 30];
    for (const th of levels) {
      if (th <= p.theta) continue;
      const r = search(from, t0, cls, targetCost, { theta: th, mode });
      if (r) return { route: r, theta: th };
    }
    return null;
  };
  // Dose the planner expects along a route.
  const routeDose = (r) => {
    let d = 0;
    for (let k = 0; k < r.edges.length; k++) {
      const dur = r.times[k + 1] - r.times[k];
      d += ((fedRateAt(r.nodes[k], r.times[k]) + fedRateAt(r.nodes[k + 1], r.times[k + 1])) / 2) * dur;
    }
    return d;
  };

  // Which compartments hold the hazard (planner's view)?
  const hazardCompartments = () => {
    const s = new Set();
    if (sim.picture) for (let n = 0; n < nN; n++) if (sim.picture.arrival[n] <= sim.t + 300) s.add(`${model.nodes[n].floor}:${model.nodes[n].compartment}`);
    for (let n = 0; n < nN; n++) if (measuredRisk[n] > 0.1) s.add(`${model.nodes[n].floor}:${model.nodes[n].compartment}`);
    return s;
  };

  // Targets for a group
  const targetsFor = (cls, hazComp) => {
    const refugeOk = (cls === "chair" || cls === "bed") && strategy === "horizontal" && (sim.picture || hazComp.size);
    return (n) => {
      if (exitSet.has(n)) return 0;
      if (refugeOk && model.nodes[n].refuge) {
        const key = `${model.nodes[n].floor}:${model.nodes[n].compartment}`;
        if (!hazComp.has(key) && riskAt(n, sim.t + 600) < 0.1) return p.refuge_cost_s;
      }
      return undefined;
    };
  };
  const shelterTargets = (n) => (model.nodes[n].protected || model.nodes[n].refuge || exitSet.has(n) ? 0 : undefined);

  // Route one group (or one person) to safety following the method; with fallback.
  const routeToSafety = (from, t0, cls, hazComp, mode = method) => {
    const tc = targetsFor(cls, hazComp);
    if (mode === "nearest") {
      // Static plan with one of the classic algorithms (avoids only places seen blocked).
      const targets = new Set();
      for (let n = 0; n < nN; n++) if (tc(n) !== undefined) targets.add(n);
      const cr = classicRoute(model, from, targets, cls, algorithm, closed, knownBlocked, p.floor_height);
      if (!cr) return null;
      let t = t0;
      cr.times = [t0];
      for (const ei of cr.edges) {
        t += model.edges[ei].length / classSpeed(cls);
        cr.times.push(t);
      }
      cr.cost = cr.length;
      cr.end = cr.nodes[cr.nodes.length - 1];
      cr.maxRisk = 0;
      return { route: cr, kind: "normal" };
    }
    let r = search(from, t0, cls, tc, { mode });
    if (r) return { route: r, kind: "normal" };
    if (mode === "nearest") return null;
    // Disconnected: reinstate the least-risk way out if its expected dose is
    // small, otherwise shelter in a protected area; if neither works, take the least-risk way.
    const lr = leastRiskTheta(from, t0, cls, tc, mode);
    if (lr && routeDose(lr.route) < p.fed_harm) return { route: lr.route, kind: "fallback", theta: lr.theta };
    r = search(from, t0, cls, shelterTargets, { theta: 1.0, mode });
    if (r) return { route: r, kind: "shelter" };
    if (lr) return { route: lr.route, kind: "fallback", theta: lr.theta };
    return null;
  };

  // gamma-efficient alternatives (penalty method), same start, same rules.
  const alternativesFor = (best, from, t0, cls, hazComp) => {
    const alts = [];
    if (!best.edges.length) return alts;
    const penalty = new Map();
    for (const ei of best.edges) penalty.set(ei, 1.6);
    const tc = targetsFor(cls, hazComp);
    for (let k = 0; k < p.k_alt; k++) {
      const r = search(from, t0, cls, tc, { penalty, mode: "proposed" });
      if (!r) break;
      // true cost of r without penalty: re-evaluate along its edges
      const trueCost = evalCost(r, t0, cls);
      const same = r.edges.filter((ei) => best.edges.includes(ei)).length / Math.max(1, r.edges.length);
      if (r.edges.length && r.edges.join() !== best.edges.join() && trueCost <= p.gamma * best.cost + 1e-9 && same < 0.8 && !alts.some((x) => x.edges.join() === r.edges.join())) {
        r.cost = trueCost;
        alts.push(r);
      }
      for (const ei of r.edges) penalty.set(ei, (penalty.get(ei) ?? 1) * 1.6);
    }
    return alts;
  };
  const evalCost = (r, t0, cls) => {
    let t = t0;
    let c = 0;
    for (let k = 0; k < r.edges.length; k++) {
      const e = model.edges[r.edges[k]];
      const dur = crossTime(e, t, cls, true);
      const u = r.nodes[k];
      const v = r.nodes[k + 1];
      c += dur + p.alpha * ((fedRateAt(u, t) + fedRateAt(v, t + dur)) / 2) * dur;
      t += dur;
    }
    const tcost = targetsFor(cls, hazardCompartments())(r.end);
    return c + (tcost ?? 0);
  };

  // ----- signs: one search backward from a virtual exit node (time snapshot)
  let staticSigns = null;
  const computeSigns = () => {
    const look = sim.t + p.sign_lookahead_s;
    const dynamic = method !== "nearest";
    if (!dynamic && staticSigns) return staticSigns;
    const cost = new Float64Array(nN).fill(Infinity);
    const next = new Int32Array(nN).fill(-1);
    const heap = new MinHeap();
    for (const x of model.exits) {
      if (closed.has(x)) continue;
      cost[x] = 0;
      heap.push(0, x);
    }
    while (heap.size) {
      const [c, v] = heap.pop();
      if (c > cost[v] + 1e-9) continue;
      for (const ei of model.adj[v]) {
        const e = model.edges[ei];
        const u = other(e, v);
        if (!edgeAllowed(model, e, v, "walk", closed) || closed.has(u)) continue;
        if (exitSet.has(u)) continue;
        let step = e.length;
        if (dynamic) {
          if (riskAt(v, look) >= p.theta && !exitSet.has(v)) continue;
          if (method === "safe") step = e.length / p.speed_visitor;
          else {
            const es = edgeState[ei];
            const rho = method === "congestion" || method === "proposed" ? es.load / es.area : 0;
            let speed = p.speed_visitor * speedFraction(rho, p);
            if (e.kind === "stair") speed *= p.k_stair / p.k_level;
            step = e.length / speed;
            if (method === "proposed") step += p.alpha * ((fedRateAt(u, look) + fedRateAt(v, look)) / 2) * step;
          }
        }
        const nc = c + step;
        if (nc < cost[u] - 1e-9) {
          cost[u] = nc;
          next[u] = v;
          heap.push(nc, u);
        }
      }
    }
    const field = { next, cost };
    if (!dynamic) staticSigns = field;
    return field;
  };
  const followField = (field, from) => {
    const nodes = [from];
    const edges = [];
    let x = from;
    let guard = 0;
    while (!exitSet.has(x) && guard++ < nN) {
      const y = field.next[x];
      if (y < 0) return null;
      const ei = model.adj[x].find((k) => other(model.edges[k], x) === y);
      if (ei === undefined) return null;
      edges.push(ei);
      nodes.push(y);
      x = y;
    }
    if (!exitSet.has(x)) return null;
    let length = 0;
    for (const ei of edges) length += model.edges[ei].length;
    return { nodes, edges, length };
  };
  let signField = null;
  const updateSigns = () => {
    signField = computeSigns();
    for (const n of model.nodes) {
      if (!n.sign) continue;
      const nx = signField.next[n.i];
      const prev = sim.signs.get(n.i);
      const state = !signWorks.get(n.i) ? { next: -1, failed: true } : nx < 0 ? { next: -1, noRoute: true } : { next: nx };
      if (!prev || prev.next !== state.next || prev.failed !== state.failed) {
        if (prev) sim.signChanges++;
        state.changedAt = sim.t;
      } else state.changedAt = prev.changedAt;
      sim.signs.set(n.i, state);
    }
  };

  // ----- planning cycle
  const plannedGroups = new Map(); // key -> {route, alts, kind}
  const pendingMessages = []; // {at, agent, plan}
  const startOf = (a) => {
    if (a.edge >= 0) {
      const e = model.edges[a.edge];
      const end = a.route.nodes[a.ri + 1];
      const left = e.length - a.pos;
      return { node: end, t: sim.t + left / Math.max(0.1, a.free) };
    }
    return { node: a.node, t: sim.t };
  };
  const slack = (n) => {
    if (!sim.picture) return Infinity;
    return sim.picture.arrival[n] - sim.t;
  };

  const plan = () => {
    sim.planVersion++;
    updateMeasured();
    updatePicture();
    updateSigns();
    reserved.fill(0);
    reservedAt = sim.t;
    plannedGroups.clear();
    sim.groupRoutes = [];
    if (sim.alarmAt === null) return;
    const hazComp = hazardCompartments();
    // Groups that the system routes: staff (radio), escorted patients, phone users.
    const groups = new Map();
    for (const a of agents) {
      if (TERMINAL.has(a.state) || a.kind === "rescue") continue;
      if (a.state === "waiting" || a.state === "needsHelp" || a.state === "prep" || a.state === "lift") continue;
      if (a.state === "escorting" || a.state === "toPatient") continue;
      if (a.carriedBy !== undefined && a.carriedBy >= 0) continue;
      if (!(a.state === "moving" || a.state === "shelter" || a.state === "stuck")) continue;
      if (a.guidance !== "radio" && a.guidance !== "phone") continue;
      const s = startOf(a);
      const cls = a.needs > 0 ? mobilityClass(a.mobility) : "walk";
      const key = `${s.node}|${cls}`;
      if (!groups.has(key)) groups.set(key, { key, node: s.node, t: s.t, cls, members: [] });
      groups.get(key).members.push(a);
    }
    // Most exposed groups first (smallest time before the hazard reaches them), beds and chairs first on ties.
    const order = [...groups.values()].sort((g, h) => slack(g.node) - slack(h.node) || (h.cls !== "walk") - (g.cls !== "walk"));
    for (const g of order) {
      const res = routeToSafety(g.node, g.t, g.cls, hazComp);
      if (!res) {
        plannedGroups.set(g.key, null);
        continue;
      }
      const alts = method === "proposed" && res.kind === "normal" ? alternativesFor(res.route, g.node, g.t, g.cls, hazComp) : [];
      plannedGroups.set(g.key, { ...res, alts });
      if (method === "proposed" || method === "congestion") {
        const space = g.members.reduce((s, a) => s + a.space, 0);
        reserve(res.route, res.route.times, space);
      }
      sim.groupRoutes.push({ from: g.node, cls: g.cls, kind: res.kind, nodes: res.route.nodes, alts: alts.map((x) => x.nodes), size: g.members.length });
      for (const a of g.members) {
        if (a.guidance === "radio") applyPlan(a, g.key);
        else {
          sim.messages++;
          if (perfectInfo || behaviourRandom() >= p.msg_loss) pendingMessages.push({ at: sim.t + p.phone_delay_s, agent: a.id, key: g.key, version: sim.planVersion });
        }
      }
    }
  };

  // Put a planned route on an agent (only between nodes; on an edge, from the edge's end).
  const applyPlan = (a, key) => {
    const pl = plannedGroups.get(key);
    if (!pl) return;
    const r = pl.route;
    const here = a.edge >= 0 ? a.route.nodes[a.ri + 1] : a.node;
    if (r.nodes[0] !== here) return;
    if (pl.kind === "fallback") sim.fallbackAgents.add(a.id);
    const changed = !a.route || a.route.nodes.slice(a.edge >= 0 ? a.ri + 1 : a.ri).join() !== r.nodes.join();
    if (a.edge >= 0) {
      // keep walking the current edge, then follow the new route
      a.route = { nodes: [...a.route.nodes.slice(0, a.ri + 1), ...r.nodes], edges: [...a.route.edges.slice(0, a.ri + 1), ...r.edges] };
    } else {
      a.route = { nodes: [...r.nodes], edges: [...r.edges] };
      a.ri = 0;
    }
    a.alternatives = pl.alts;
    a.planKind = pl.kind;
    if (changed) a.routeChanges++;
    if (pl.kind === "shelter" && a.state !== "shelter") a.shelterPlanned = true;
    else a.shelterPlanned = false;
    if (a.state === "stuck" || (a.state === "shelter" && pl.kind !== "shelter")) a.state = "moving";
  };

  // People without (working) guidance: signs or what they know.
  const routeUnguided = (a) => {
    const here = a.node;
    const avoid = a.seen;
    if (a.guidance === "signs" || a.guidance === "phone") {
      if (model.nodes[here].sign && signWorks.get(here) && cond[here].K <= p.jin_c_emit / p.sign_read_m) {
        const r = followField(signField ?? computeSigns(), here);
        if (r && !r.nodes.slice(1).some((n) => avoid.has(n))) return r;
      }
      if (a.route && a.ri < a.route.nodes.length - 1 && !a.route.nodes.slice(a.ri + 1).some((n) => avoid.has(n))) return null; // keep going
    }
    // the exit they know, else the nearest one they can reach
    if (a.knownExit !== null && a.knownExit !== undefined && !avoid.has(a.knownExit)) {
      const r = shortestPath(model, here, new Set([a.knownExit]), "walk", avoid, closed);
      if (r) return r;
    }
    return shortestPath(model, here, exitSet, "walk", avoid, closed);
  };

  // ----- staff help
  const chooseTask = (s) => {
    const waiting = agents.filter((x) => x.kind === "patient" && x.needs > 0 && (x.state === "needsHelp" || x.state === "waiting" || (x.state === "refuge" && x.threatened)) && x.helpers.length + x.coming.length < x.needs);
    if (!waiting.length) return false;
    // Staff go into smoke to fetch a patient (not into untenable places); the dose term still steers them.
    const all = search(s.node, sim.t, "walk", () => undefined, { mode: method, all: true, avoid: s.seen, theta: 3 });
    let best = null;
    for (const x of waiting) {
      const c = all.cost[x.node];
      if (!Number.isFinite(c)) continue;
      const sameFloor = model.nodes[x.node].floor === model.nodes[s.home].floor ? 1 : 0;
      const partly = x.coming.length + x.helpers.length > 0 ? 1 : 0;
      // Proposed method: the most exposed patients first (Yen [4]); others: highest criticality first.
      const exposed = method === "proposed" ? -Math.min(3600, slack(x.node)) : 0;
      const key = [sameFloor, partly, exposed, x.criticality, -c];
      if (!best || better(key, best.key)) best = { x, key };
    }
    if (!best) return false;
    const target = best.x;
    const r = target.node === s.node ? { nodes: [s.node], edges: [] } : unwind(model, s.node, target.node, all.prevE, all.cost[target.node]);
    target.coming.push(s.id);
    s.helping = target.id;
    s.state = "toPatient";
    s.route = { nodes: r.nodes, edges: r.edges };
    s.ri = 0;
    s.waitSince = sim.t;
    return true;
  };
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] > b[i] + 1e-9) return true;
      if (a[i] < b[i] - 1e-9) return false;
    }
    return false;
  };
  const staffArrives = (s) => {
    const x = agents[s.helping];
    const stillWaiting = x && (x.state === "needsHelp" || x.state === "waiting" || (x.state === "refuge" && x.threatened)) && x.carriedBy === undefined;
    if (!stillWaiting) {
      if (x) x.coming = x.coming.filter((id) => id !== s.id);
      s.helping = -1;
      s.state = "free";
      return;
    }
    x.coming = x.coming.filter((id) => id !== s.id);
    x.helpers.push(s.id);
    s.state = "escorting";
    if (x.helpers.length >= x.needs) {
      const again = x.threatened === true;
      x.state = "prep";
      x.prepEnds = sim.t + (again ? 30 : x.prep);
      x.helpArrivedAt = x.helpArrivedAt ?? sim.t;
    }
  };

  // ----- reaching safety
  const reachSafety = (a, n) => {
    if (exitSet.has(n)) {
      a.state = "out";
      a.outAt = sim.t;
      a.safeAt = a.safeAt ?? sim.t;
      a.exit = n;
      sim.exitCount.set(n, (sim.exitCount.get(n) ?? 0) + 1);
    } else {
      a.state = "refuge";
      a.safeAt = sim.t;
      a.threatened = false;
    }
    releaseHelpers(a, n);
  };
  const releaseHelpers = (a, n) => {
    for (const sid of a.helpers) {
      const st = agents[sid];
      st.node = n;
      st.helping = -1;
      st.trips++;
      st.state = "free";
      st.route = null;
      st.waitSince = sim.t;
    }
    a.helpers = [];
  };

  const releaseEdge = (a) => {
    if (a.edge >= 0) {
      edgeState[a.edge].load -= a.space;
      a.edge = -1;
    }
  };

  // Moves one agent along its route for dt seconds.
  const advance = (a, dt) => {
    let budget = dt;
    let guard = 0;
    while (budget > 1e-9 && guard++ < 50) {
      if (a.edge >= 0) {
        const e = model.edges[a.edge];
        const es = edgeState[a.edge];
        let v = a.free * speedFraction(es.load / es.area, p);
        if (e.kind === "stair") v *= p.k_stair / p.k_level;
        const left = e.length - a.pos;
        if (v * budget < left) {
          a.pos += v * budget;
          return;
        }
        budget -= left / v;
        releaseEdge(a);
        a.node = a.route.nodes[a.ri + 1];
        a.ri++;
        a.pos = 0;
        a.waitSince = sim.t;
        a.waitingEdgeSince = null;
        if (cond[a.node].fire) {
          incapacitate(a);
          return;
        }
        if (a.ri >= a.route.nodes.length - 1) return;
        if (a.needsReroute) return;
      } else {
        if (!a.route || a.ri >= a.route.nodes.length - 1) return;
        const ei = a.route.edges[a.ri];
        const e = model.edges[ei];
        const next = a.route.nodes[a.ri + 1];
        // People see smoke or fire ahead and do not walk into it.
        if ((cond[next].fire || cond[next].K >= p.avoid_k) && !a.seen.has(next) && !exitSet.has(next)) {
          a.seen.add(next);
          if (!knownBlocked.has(next)) {
            knownBlocked.add(next);
            if (a.guidance === "phone" || a.guidance === "radio") sim.reports.push({ node: next, t: sim.t });
          }
          if (sim.alarmAt === null && sim.pendingDiscovery === undefined) sim.pendingDiscovery = sim.t + p.discovery_delay_s;
          a.needsReroute = true;
          return;
        }
        if (e.kind === "lift") {
          let j = a.ri + 1;
          while (j < a.route.edges.length && model.edges[a.route.edges[j]].kind === "lift") j++;
          const shaft = shafts[model.shaftOf[a.node]];
          a.state = "lift";
          a.lift = { shaft: shaft.id, from: a.node, to: a.route.nodes[j], toIndex: j, since: sim.t };
          shaft.queue.push(a.id);
          return;
        }
        const es = edgeState[ei];
        if (es.tokens + 1e-9 < a.space || es.load + a.space > es.storage + 1e-9) {
          es.waiting++;
          if (a.waitingEdgeSince === null) a.waitingEdgeSince = sim.t;
          // Jammed: try a gamma-efficient alternative that passes here.
          if (method === "proposed" && a.alternatives?.length && sim.t - a.waitingEdgeSince >= p.jam_wait_s) {
            for (const alt of a.alternatives) {
              const k = alt.nodes.indexOf(a.node);
              if (k < 0 || k >= alt.nodes.length - 1 || alt.edges[k] === ei) continue;
              a.route = { nodes: alt.nodes.slice(k), edges: alt.edges.slice(k) };
              a.ri = 0;
              a.alternatives = a.alternatives.filter((x) => x !== alt);
              a.waitingEdgeSince = null;
              sim.alternativeSwitches++;
              a.routeChanges++;
              for (const h of a.helpers) agents[h].node = a.node;
              break;
            }
          }
          return;
        }
        es.tokens -= a.space;
        es.load += a.space;
        es.used++;
        a.edge = ei;
        a.pos = 0;
        a.waitingEdgeSince = null;
      }
    }
  };

  const serveLifts = () => {
    for (const sh of shafts) {
      if (sim.t < sh.freeAt) continue;
      sh.queue = sh.queue.filter((id) => agents[id].state === "lift" && !agents[id].lift.riding);
      if (!sh.queue.length) continue;
      const first = agents[sh.queue[0]];
      const fromFloor = model.nodes[first.lift.from].floor;
      const toFloor = model.nodes[first.lift.to].floor;
      let load = 0;
      const riders = [];
      for (const id of sh.queue) {
        const a = agents[id];
        if (a.lift.from !== first.lift.from || a.lift.to !== first.lift.to) continue;
        if (riders.length && load + a.space > p.lift_capacity) break;
        riders.push(a);
        load += a.space;
      }
      const reach = (Math.abs(sh.carFloor - fromFloor) * p.floor_height) / p.lift_speed;
      const ride = (Math.abs(fromFloor - toFloor) * p.floor_height) / p.lift_speed;
      const arriveAt = sim.t + reach + p.lift_door_s + ride;
      for (const a of riders) {
        a.lift.riding = true;
        a.lift.departAt = sim.t + reach + p.lift_door_s / 2;
        a.lift.arriveAt = arriveAt;
      }
      sh.carFloor = toFloor;
      sh.freeAt = arriveAt;
      sh.trips++;
    }
  };

  const incapacitate = (a) => {
    if (TERMINAL.has(a.state)) return;
    releaseEdge(a);
    if (a.state === "lift") return;
    a.state = "incapacitated";
    a.incapAt = sim.t;
    a.wasIncapacitated = true;
    for (const sid of a.helpers) {
      const st = agents[sid];
      st.node = a.node;
      st.helping = -1;
      st.state = "free";
      st.route = null;
    }
    a.helpers = [];
    log(`${a.code} could not go on (dose ${round(a.fed, 2)}) at ${model.nodes[a.node].id}`, "harm");
  };

  // ----- rescue teams
  const spawnTeams = () => {
    const entry = model.exits.find((x) => model.adj[x].length && riskAt(other(model.edges[model.adj[x][0]], x), sim.t) < 0.5) ?? model.familiar;
    for (let k = 0; k < p.rescue_teams; k++) {
      const a = newAgent({ kind: "rescue", code: `Team ${k + 1}`, mobility: "ambulatory", home: entry, node: entry, free: p.rescue_speed, helpersShown: p.rescue_team_size, state: "teamIdle", guidance: "radio", space: p.rescue_team_size });
      a.startAt = sim.t;
      teams.push(a.id);
    }
    log(`${p.rescue_teams} rescue teams arrived at ${model.nodes[entry].id}`, "rescue");
  };
  const rescueTargets = () =>
    agents.filter((x) => x.kind !== "rescue" && x.rescuedBy < 0 && x.carriedBy === undefined && !(x.rescueBlockedUntil > sim.t) && (x.state === "incapacitated" || x.state === "shelter" || x.state === "stuck" || (x.state === "needsHelp" && x.coming.length === 0 && sim.t - x.waitSince > 120) || (x.state === "refuge" && x.threatened)));
  const assignTeam = (team) => {
    if (team.nextTry !== undefined && sim.t < team.nextTry) return false;
    team.nextTry = sim.t + p.replan_s;
    const targets = rescueTargets();
    if (!targets.length) return false;
    const all = search(team.node, sim.t, "rescue", () => undefined, { theta: p.theta_rescue, mode: "rescue", all: true });
    let best = null;
    for (const x of targets) {
      const c = all.cost[x.node];
      if (!Number.isFinite(c)) continue;
      const urgency = x.state === "incapacitated" ? 3 : x.state === "refuge" ? 2 : 1;
      const key = [urgency, x.fed, -c];
      if (!best || better(key, best.key)) best = { x, key };
    }
    if (!best) return false;
    const r = best.x.node === team.node ? { nodes: [team.node], edges: [] } : unwind(model, team.node, best.x.node, all.prevE, all.cost[best.x.node]);
    best.x.rescuedBy = team.id;
    team.helping = best.x.id;
    team.route = { nodes: r.nodes, edges: r.edges };
    team.ri = 0;
    team.state = "teamGoing";
    team.eta = all.time[best.x.node];
    log(`${team.code} sent to ${best.x.code} at ${model.nodes[best.x.node].id} (about ${Math.round(team.eta - sim.t)} s)`, "rescue");
    return true;
  };
  const teamPicksUp = (team) => {
    const x = agents[team.helping];
    if (!x || x.state === "out") {
      team.state = "teamIdle";
      team.helping = -1;
      return;
    }
    // carry out: rescue rules (stairs allowed), back to the safest exit
    const r = search(team.node, sim.t, "carry", (n) => (exitSet.has(n) ? 0 : undefined), { theta: p.theta_rescue, mode: "rescue" });
    if (!r) {
      team.state = "teamIdle";
      x.rescuedBy = -1;
      x.rescueBlockedUntil = sim.t + 60;
      team.helping = -1;
      return;
    }
    releaseEdge(x);
    for (const sid of x.helpers) {
      const st = agents[sid];
      st.helping = -1;
      st.state = "free";
      st.node = x.node;
    }
    x.helpers = [];
    x.carriedBy = team.id;
    x.prevState = x.state;
    x.state = "carried";
    team.free = p.carry_speed;
    team.route = { nodes: r.nodes, edges: r.edges };
    team.ri = 0;
    team.state = "teamCarrying";
    team.carrying = x.id;
  };

  // ----- snapshots
  const snapshotPeople = () =>
    agents
      .filter((a) => a.state !== "escorting" && a.state !== "carried")
      .map((a) => {
        const s = { id: a.id, kind: a.kind, role: a.role, code: a.code, mobility: a.mobility, state: a.state, node: a.node, helpers: a.kind === "rescue" ? (a.helpersShown ?? 2) - 1 : a.helpers.length, fed: round(a.fed, 3), guidance: a.guidance };
        if (a.kind === "rescue" && a.carrying >= 0) s.carrying = agents[a.carrying].mobility;
        if (a.edge >= 0) {
          const e = model.edges[a.edge];
          const forward = e.u === a.node;
          s.edge = a.edge;
          s.frac = forward ? a.pos / e.length : 1 - a.pos / e.length;
        }
        if (a.state === "lift" && a.lift?.riding) s.lift = { from: a.lift.from, to: a.lift.to, frac: clamp((sim.t - a.lift.departAt) / Math.max(1, a.lift.arriveAt - a.lift.departAt), 0, 1) };
        return s;
      });
  const hazardSnapshot = () =>
    cond.map((c, n) => ({ n, smoke: c.smoke ? round(c.K / p.k_max, 2) : 0, fire: c.fire })).filter((x) => x.smoke > 0 || x.fire);
  const predictedSnapshot = () => {
    if (!sim.picture) return [];
    const out = [];
    for (let n = 0; n < nN; n++) {
      const a = sim.picture.arrival[n];
      if (a <= sim.t + 120) out.push({ n, inS: Math.max(0, round(a - sim.t)) });
    }
    return out;
  };
  sim.snapshot = () => ({
    t: sim.t,
    people: snapshotPeople(),
    hazard: hazardSnapshot(),
    predicted: predictedSnapshot(),
    signs: [...sim.signs.entries()].map(([n, s]) => ({ n, ...s })),
    routes: sim.groupRoutes,
    teams: teams.map((id) => ({ id, code: agents[id].code, state: agents[id].state, node: agents[id].node, route: agents[id].route ? agents[id].route.nodes.slice(agents[id].ri) : [], target: agents[id].helping, eta: agents[id].eta ?? null })),
    alerts: alerts.map((x) => ({ ...x })),
    alarmAt: sim.alarmAt,
    estimate: sim.picture ? { origin: sim.picture.origin, rate: sim.picture.rate ?? null, plausible: sim.picture.plausible ?? null } : null,
    sensors: net.sensors.map((s) => ({ id: s.id, kind: s.kind, node: s.node, status: s.status, detected: s.detectedAt !== null, latest: s.latest })),
    density: edgeState.map((es) => es.load / es.area),
  });
  const recordFrame = () => sim.frames.push(sim.snapshot());

  // ----- one tick of dt = 1 s
  sim.step = () => {
    if (sim.done) return sim;
    sim.t += 1;
    const t = sim.t;
    updateConditions(t);

    // Sensing
    net.sample(t);
    const fresh = net.deliver(t);
    for (const s of fresh) {
      if (sim.dismissedSensors.has(s.id)) continue;
      const al = { id: alerts.length + 1, t, sensor: s.id, kind: s.kind, node: s.node, status: "new", decidedAt: null, autoAt: confirmMode === "auto" ? t + p.confirm_delay_s : null };
      alerts.push(al);
      log(`${s.kind} sensor ${s.id} at ${model.nodes[s.node].id} detected the hazard`, "sensor");
      sim.nextPlan = Math.min(sim.nextPlan, t);
    }
    for (const al of alerts) if (al.status === "new" && al.autoAt !== null && t >= al.autoAt) confirmAlert(al.id);
    if (sim.pendingDiscovery !== undefined && sim.alarmAt === null && t >= sim.pendingDiscovery) raiseAlarm("people found the hazard and raised the alarm");

    // People with phones report smoke they can see where they are
    for (const a of agents) {
      if (a.guidance !== "phone" && a.guidance !== "radio") continue;
      if (TERMINAL.has(a.state) || a.edge >= 0 || a.kind === "rescue") continue;
      const c = cond[a.node];
      if (c.K >= p.report_k && !sim.reports.some((r) => r.node === a.node)) {
        sim.reports.push({ node: a.node, t });
        if (sim.alarmAt === null && sim.pendingDiscovery === undefined) sim.pendingDiscovery = t + p.discovery_delay_s;
      }
    }

    // Decision: re-plan every delta t (or at once after new information)
    if (t >= sim.nextPlan) {
      plan();
      sim.nextPlan = t + p.replan_s;
    }
    // Guidance: phone messages that arrive now
    for (let k = pendingMessages.length - 1; k >= 0; k--) {
      const m = pendingMessages[k];
      if (m.at > t) continue;
      pendingMessages.splice(k, 1);
      if (m.version !== sim.planVersion) continue; // replaced by a newer plan
      const a = agents[m.agent];
      if (a.state === "moving" || a.state === "stuck" || a.state === "shelter") {
        a.lastMsg = t;
        applyPlan(a, m.key);
      }
    }

    // Hazard reaches people standing still
    for (const a of agents) {
      if (TERMINAL.has(a.state) || a.kind === "rescue" || a.edge >= 0 || a.state === "escorting" || a.state === "carried") continue;
      if (a.state === "lift" && a.lift?.riding) continue;
      if (cond[a.node].fire) incapacitate(a);
      // People who see smoke where they are react at once, alarm or not.
      else if (a.state === "waiting" && !a.selfAlerted && cond[a.node].K >= p.report_k) {
        a.selfAlerted = true;
        a.startAt = Math.min(a.startAt, t + 5);
      }
    }
    // Refuges can become threatened (planner's view): move people again
    if (t % p.replan_s === 0) {
      if (agents.some((x) => x.state === "needsHelp" && x.coming.length + x.helpers.length < x.needs)) {
        for (const s of agents) {
          if (s.kind === "staff" && s.state === "refuge") {
            s.state = "free";
            s.standby = false;
          }
        }
      }
      for (const a of agents) {
        if (a.state !== "refuge") continue;
        // Before a second detection, only what is measured at the refuge itself moves people again.
        const threat = hazardInfo === "live" && !sim.corroborated ? measuredRisk[a.node] >= p.theta : riskAt(a.node, t + 300) >= p.theta;
        if (threat && !a.threatened) {
          a.threatened = true;
          if (a.needs > 0) {
            a.state = "needsHelp";
            a.waitSince = t;
            log(`Refuge ${model.nodes[a.node].id} is threatened: ${a.code} must move again`, "route");
          } else {
            a.state = "moving";
          }
        }
      }
    }

    // Flow tokens
    for (const es of edgeState) {
      es.tokens = Math.min(es.tokens + es.rate, Math.max(es.rate, biggest));
      es.waiting = 0;
    }

    // Lifts
    serveLifts();
    for (const a of agents) {
      if (a.state !== "lift" || !a.lift?.riding || t < a.lift.arriveAt) continue;
      a.node = a.lift.to;
      a.ri = a.lift.toIndex;
      a.lift = null;
      a.state = "moving";
      for (const h of a.helpers) agents[h].node = a.node;
      if (exitSet.has(a.node) || (a.ri >= a.route.nodes.length - 1 && model.nodes[a.node].refuge)) reachSafety(a, a.node);
    }

    // Rescue teams arrive
    if (useRescue && !teams.length && sim.alarmAt !== null && t >= sim.alarmAt + p.rescue_arrival_s && !truth.none) spawnTeams();

    // People decide and move (longest waiting first)
    const order = agents.filter((a) => !TERMINAL.has(a.state) && a.state !== "escorting" && a.state !== "carried").sort((x, y) => x.waitSince - y.waitSince || x.id - y.id);
    for (const a of order) {
      if (TERMINAL.has(a.state)) continue;
      if (sim.alarmAt === null && !a.selfAlerted) continue;
      if (a.kind === "rescue") {
        stepTeam(a);
        continue;
      }
      if (a.state === "waiting") {
        if (t < a.startAt) continue;
        if (a.kind === "staff") a.state = "free";
        else if (a.needs > 0) {
          a.state = "needsHelp";
          a.waitSince = t;
          continue;
        } else {
          a.state = "moving";
          a.waitSince = t;
          a.route = null;
          a.needsReroute = true;
        }
      }
      if (a.state === "needsHelp" || a.state === "lift" || a.state === "incapacitated" || a.state === "shelter") continue;
      if (a.state === "prep") {
        if (t >= a.prepEnds) {
          a.state = "moving";
          a.route = null;
          a.needsReroute = true;
          log(`${a.code} (${a.mobility}) leaves with ${a.helpers.length} staff`, "move");
        } else continue;
      }
      if (a.state === "free") {
        if (chooseTask(a)) {
          /* walking to a patient */
        } else if (goStandby(a)) {
          /* staying with patients in a refuge */
        } else if (exitSet.has(a.node)) {
          a.state = "out";
          a.outAt = t;
          a.safeAt = t;
          a.exit = a.node;
          sim.exitCount.set(a.node, (sim.exitCount.get(a.node) ?? 0) + 1);
          continue;
        } else {
          a.state = "moving";
          a.route = null;
          a.needsReroute = true;
        }
      }
      if (a.state === "stuck") {
        if (t < (a.retryAt ?? 0) && !a.needsReroute) continue;
        a.state = "moving";
        a.needsReroute = true;
      }
      if (a.state === "toPatient" || a.state === "moving") {
        if (a.edge < 0 && (a.needsReroute || !a.route)) {
          a.needsReroute = false;
          if (!reroute(a)) continue;
        }
        advance(a, 1);
        if (TERMINAL.has(a.state) || a.state === "lift") continue;
        if (a.edge < 0 && a.route && a.ri >= a.route.nodes.length - 1) {
          if (a.state === "toPatient") staffArrives(a);
          else if (exitSet.has(a.node)) reachSafety(a, a.node);
          else if (model.nodes[a.node].refuge && a.needs > 0) reachSafety(a, a.node);
          else if (a.standby && model.nodes[a.node].refuge) {
            a.state = "refuge";
            a.safeAt = a.safeAt ?? t;
          } else if (a.shelterPlanned) {
            a.state = "shelter";
            sim.shelters++;
            log(`${a.code} shelters at ${model.nodes[a.node].id} (no safe route)`, "harm");
          } else a.needsReroute = true;
        }
      }
    }

    // Dose (FED) from the real conditions
    for (const a of agents) {
      if (a.kind === "rescue" || a.state === "out" || a.wasIncapacitated) continue;
      if (a.state === "refuge" && !cond[a.node].smoke) continue;
      let c = cond[a.node];
      if (a.edge >= 0) {
        const e = model.edges[a.edge];
        const c2 = cond[other(e, a.node)];
        c = fedPerSecond(c2, p) > fedPerSecond(c, p) ? c2 : c;
      }
      const f = fedPerSecond(c, p);
      if (f > 0) {
        a.fed += f;
        a.reachedByHazard = true;
      }
      if (a.fed >= p.fed_incap && a.state !== "incapacitated" && a.state !== "carried") incapacitate(a);
    }

    // Measurements
    for (const [i, es] of edgeState.entries()) {
      es.maxDensity = Math.max(es.maxDensity, es.load / es.area);
      es.maxQueue = Math.max(es.maxQueue, es.waiting);
    }
    if (t % 10 === 0) sim.curve.push([t, countSafe()]);
    if (frameEvery && t % frameEvery === 0) recordFrame();

    // Finished?
    // People with no route for 5 minutes shelter where they are (rescue teams look for them).
    for (const a of agents) {
      if (a.state === "stuck" && t - a.stuckSince >= 300) {
        a.state = "shelter";
        sim.shelters++;
        log(`${a.code} has had no route for 5 minutes and shelters at ${model.nodes[a.node].id}`, "harm");
      }
    }
    const staffActive = agents.some((s) => s.kind === "staff" && (!TERMINAL.has(s.state) || s.standby));
    const teamsBusy = teams.some((id) => agents[id].state !== "teamIdle");
    const teamsPending = useRescue && !truth.none && !teams.length && sim.alarmAt !== null;
    const helpPossible = staffActive || teamsBusy || teamsPending || (teams.length > 0 && t % 30 === 0 && rescueTargets().length > 0 && teams.some((id) => agents[id].state === "teamIdle" && assignTeam(agents[id])));
    const busy = agents.some((a) => {
      if (TERMINAL.has(a.state) || a.kind === "rescue") return false;
      if (a.state === "shelter" || a.state === "needsHelp") return helpPossible;
      return true;
    }) || teamsBusy || (teamsPending && agents.some((a) => a.state === "shelter" || a.state === "incapacitated" || a.state === "needsHelp"));
    const waitingForAlarm = sim.alarmAt === null && t < p.time_limit_s;
    if (t >= p.time_limit_s || (!busy && !waitingForAlarm)) {
      sim.done = true;
      if (sim.curve[sim.curve.length - 1][0] !== t) sim.curve.push([t, countSafe()]);
      if (frameEvery) recordFrame();
    }
    return sim;
  };

  const countSafe = () => agents.filter((a) => a.kind !== "rescue" && (a.state === "out" || a.state === "refuge")).length;

  // Staff with no patient left to fetch stay with the patients in a refuge.
  const goStandby = (s) => {
    if (s.kind !== "staff") return false;
    const occupied = new Set(agents.filter((x) => x.kind === "patient" && x.state === "refuge" && !x.threatened).map((x) => x.node));
    if (!occupied.size) return false;
    if (occupied.has(s.node)) {
      s.state = "refuge";
      s.standby = true;
      s.safeAt = s.safeAt ?? sim.t;
      return true;
    }
    const all = search(s.node, sim.t, "walk", () => undefined, { mode: method, all: true, avoid: s.seen });
    let best = -1;
    for (const n of occupied) if (Number.isFinite(all.cost[n]) && (best < 0 || all.cost[n] < all.cost[best])) best = n;
    if (best < 0) return false;
    const r = unwind(model, s.node, best, all.prevE, all.cost[best]);
    s.route = { nodes: r.nodes, edges: r.edges };
    s.ri = 0;
    s.state = "moving";
    s.standby = true;
    return true;
  };

  const reroute = (a) => {
    const here = a.node;
    if (a.state === "toPatient") {
      const x = agents[a.helping];
      const r = x ? search(here, sim.t, "walk", (n) => (n === x.node ? 0 : undefined), { mode: method, avoid: a.seen, theta: 3 }) : null;
      if (r) {
        a.route = { nodes: r.nodes, edges: r.edges };
        a.ri = 0;
        return true;
      }
      if (x) x.coming = x.coming.filter((id) => id !== a.id);
      a.helping = -1;
      a.state = "moving";
    }
    const guided = a.guidance === "radio" || a.guidance === "phone";
    const cls = a.needs > 0 ? mobilityClass(a.mobility) : "walk";
    if (guided || a.needs > 0) {
      const res = routeToSafety(here, sim.t, cls, hazardCompartments());
      if (res) {
        a.route = { nodes: res.route.nodes, edges: res.route.edges };
        a.ri = 0;
        a.planKind = res.kind;
        a.shelterPlanned = res.kind === "shelter";
        a.alternatives = null;
        if (res.kind === "fallback") sim.fallbackAgents.add(a.id);
        a.routeChanges++;
        a.stuckSince = null;
        if (a.route.nodes.length === 1) return finishAtStart(a);
        return true;
      }
    } else {
      const r = routeUnguided(a);
      if (r) {
        a.route = { nodes: r.nodes, edges: r.edges };
        a.ri = 0;
        a.routeChanges++;
        a.stuckSince = null;
        if (a.route.nodes.length === 1) return finishAtStart(a);
        return true;
      }
      if (a.route && a.ri < a.route.nodes.length - 1) return true;
    }
    if (a.stuckSince === undefined || a.stuckSince === null) a.stuckSince = sim.t;
    a.state = "stuck";
    a.retryAt = sim.t + 15;
    a.waitSince = sim.t;
    return false;
  };
  const finishAtStart = (a) => {
    if (exitSet.has(a.node)) reachSafety(a, a.node);
    else if (model.nodes[a.node].refuge && a.needs > 0) reachSafety(a, a.node);
    else if (a.shelterPlanned) {
      a.state = "shelter";
      sim.shelters++;
    }
    return false;
  };

  const stepTeam = (team) => {
    if (team.state === "teamIdle") {
      if (!assignTeam(team)) return;
    }
    if (team.state === "teamGoing") {
      const x = agents[team.helping];
      if (!x || x.state === "out" || (x.state === "refuge" && !x.threatened)) {
        if (x) x.rescuedBy = -1;
        team.state = "teamIdle";
        team.helping = -1;
        return;
      }
      if (team.route.nodes[team.route.nodes.length - 1] !== x.node && team.edge < 0) {
        const r = search(team.node, sim.t, "rescue", (n) => (n === x.node ? 0 : undefined), { theta: p.theta_rescue, mode: "rescue" });
        if (!r) {
          x.rescuedBy = -1;
          team.state = "teamIdle";
          return;
        }
        team.route = { nodes: r.nodes, edges: r.edges };
        team.ri = 0;
      }
      advanceTeam(team);
      if (team.edge < 0 && team.ri >= team.route.nodes.length - 1 && team.node === x.node) teamPicksUp(team);
      return;
    }
    if (team.state === "teamCarrying") {
      advanceTeam(team);
      const x = agents[team.carrying];
      x.node = team.node;
      if (team.edge < 0 && team.ri >= team.route.nodes.length - 1 && exitSet.has(team.node)) {
        x.state = "out";
        x.outAt = sim.t;
        x.safeAt = x.safeAt ?? sim.t;
        x.exit = team.node;
        x.rescued = true;
        x.carriedBy = undefined;
        releaseHelpers(x, team.node);
        sim.exitCount.set(team.node, (sim.exitCount.get(team.node) ?? 0) + 1);
        log(`${team.code} brought ${x.code} out through ${model.nodes[team.node].id}`, "rescue");
        team.carrying = -1;
        team.helping = -1;
        team.free = p.rescue_speed;
        team.state = "teamIdle";
      }
    }
  };
  // Teams move like people but ignore the flow tokens (they push against the crowd) and slow in density.
  const advanceTeam = (team) => {
    let budget = 1;
    let guard = 0;
    while (budget > 1e-9 && guard++ < 20) {
      if (team.edge >= 0) {
        const e = model.edges[team.edge];
        const es = edgeState[team.edge];
        let v = team.free * speedFraction(es.load / es.area, p);
        if (e.kind === "stair") v *= p.k_stair / p.k_level;
        const left = e.length - team.pos;
        if (v * budget < left) {
          team.pos += v * budget;
          return;
        }
        budget -= left / v;
        releaseEdge(team);
        team.node = team.route.nodes[team.ri + 1];
        team.ri++;
        team.pos = 0;
      } else {
        if (team.ri >= team.route.nodes.length - 1) return;
        const ei = team.route.edges[team.ri];
        team.edge = ei;
        team.pos = 0;
        edgeState[ei].load += team.space;
      }
    }
  };

  sim.run = () => {
    if (frameEvery) recordFrame();
    while (!sim.done) sim.step();
    return summarize(sim);
  };
  sim.summary = () => summarize(sim);
  return sim;
}

// ---------------------------------------------------------------------------
// Results (methodology step 7)
// ---------------------------------------------------------------------------

export function percentileTime(times, total, q) {
  const sorted = [...times].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(q * total) - 1);
  return idx < sorted.length ? sorted[idx] : null;
}

export function summarize(sim) {
  const { agents, model, edgeState, p } = sim;
  const people = agents.filter((a) => a.kind !== "rescue");
  const total = people.length;
  const count = (f) => people.filter(f).length;
  const safeTimes = people.filter((a) => a.state === "out" || a.state === "refuge").map((a) => a.safeAt ?? a.outAt);
  const outTimes = people.filter((a) => a.state === "out").map((a) => a.outAt);
  const feds = people.map((a) => a.fed);
  const byKind = {};
  for (const kind of ["patient", "staff", "visitor"]) {
    const g = people.filter((a) => a.kind === kind);
    byKind[kind] = { total: g.length, out: g.filter((a) => a.state === "out").length, refuge: g.filter((a) => a.state === "refuge").length, harmed: g.filter((a) => a.fed >= p.fed_harm).length };
  }
  const byMobility = {};
  for (const m of MOBILITIES) {
    const g = people.filter((a) => a.kind === "patient" && a.mobility === m);
    if (!g.length) continue;
    const ts = g.filter((a) => a.safeAt !== null).map((a) => a.safeAt);
    byMobility[m] = { total: g.length, safe: ts.length, meanSafe: ts.length ? round(ts.reduce((s, x) => s + x, 0) / ts.length, 0) : null, harmed: g.filter((a) => a.fed >= p.fed_harm).length };
  }
  const helped = people.filter((a) => a.needs > 0 && a.helpArrivedAt !== undefined && sim.alarmAt !== null);
  const waits = helped.map((a) => a.helpArrivedAt - sim.alarmAt);
  const busiest = edgeState
    .map((es, i) => ({ i, path: `${model.nodes[model.edges[i].u].id} - ${model.nodes[model.edges[i].v].id}`, kind: model.edges[i].kind, maxDensity: round(es.maxDensity, 2), maxQueue: es.maxQueue, used: es.used }))
    .filter((x) => x.used > 0)
    .sort((a, b) => b.maxDensity - a.maxDensity || b.maxQueue - a.maxQueue)
    .slice(0, 8);
  const lastEst = sim.estimates.length ? sim.estimates[sim.estimates.length - 1] : null;
  const firstEstAfterAlarm = sim.estimates.find((e) => sim.alarmAt !== null && e.t >= sim.alarmAt + 60) ?? lastEst;
  return {
    method: sim.method,
    algorithm: sim.algorithm,
    hazardInfo: sim.hazardInfo,
    strategy: sim.strategy,
    t: sim.t,
    total,
    out: count((a) => a.state === "out"),
    refuge: count((a) => a.state === "refuge"),
    safe: safeTimes.length,
    shelter: count((a) => a.state === "shelter"),
    incapacitated: count((a) => a.wasIncapacitated === true),
    stillIncapacitated: count((a) => a.state === "incapacitated"),
    leftWaiting: count((a) => a.state === "needsHelp" || a.state === "prep" || a.state === "waiting"),
    stuck: count((a) => a.state === "stuck" || a.state === "moving" || a.state === "lift" || a.state === "toPatient"),
    alarmAt: sim.alarmAt,
    alarmReason: sim.alarmReason,
    t50: percentileTime(safeTimes, total, 0.5),
    t90: percentileTime(safeTimes, total, 0.9),
    lastSafe: safeTimes.length ? Math.max(...safeTimes) : null,
    lastOut: outTimes.length ? Math.max(...outTimes) : null,
    allSafe: safeTimes.length === total,
    meanFed: round(feds.reduce((s, x) => s + x, 0) / Math.max(1, total), 4),
    maxFed: round(Math.max(0, ...feds), 3),
    harmed: count((a) => a.fed >= p.fed_harm || a.wasIncapacitated === true),
    reachedByHazard: count((a) => a.reachedByHazard),
    rescued: count((a) => a.rescued),
    byKind,
    byMobility,
    exits: model.exits.map((x) => ({ exit: model.nodes[x].id, people: sim.exitCount.get(x) ?? 0 })),
    busiest,
    meanHelpWait: waits.length ? round(waits.reduce((s, x) => s + x, 0) / waits.length, 0) : null,
    maxHelpWait: waits.length ? round(Math.max(...waits), 0) : null,
    routeChanges: people.reduce((s, a) => s + a.routeChanges, 0),
    signChanges: sim.signChanges,
    messages: sim.messages,
    alternativeSwitches: sim.alternativeSwitches,
    fallbacks: sim.fallbackAgents.size,
    shelters: sim.shelters,
    alerts: sim.alerts.map((x) => ({ id: x.id, t: x.t, sensor: x.sensor, kind: x.kind, place: model.nodes[x.node].id, status: x.status, decidedAt: x.decidedAt })),
    sensorFaults: countBy(sim.net.sensors.map((s) => s.fault)),
    sensorStatus: countBy(sim.net.sensors.map((s) => s.status)),
    estimate: lastEst ? { originError: lastEst.originError, rate: lastEst.rate, trueRate: lastEst.trueRate, mae: lastEst.mae } : null,
    estimateEarly: firstEstAfterAlarm ? { t: firstEstAfterAlarm.t, originError: firstEstAfterAlarm.originError, mae: firstEstAfterAlarm.mae } : null,
    estimates: sim.estimates,
    trueRate: sim.truth.none ? null : round(sim.truth.smokeRate, 3),
    curve: sim.curve,
    outByGroup: {
      walk: people.filter((a) => a.state === "out" && a.kind !== "staff" && a.needs === 0).map((a) => a.outAt),
      staff: people.filter((a) => a.state === "out" && a.kind === "staff").map((a) => a.outAt),
      assisted: people.filter((a) => a.state === "out" && a.needs > 0).map((a) => a.outAt),
    },
    events: sim.events,
  };
}

// Which drill group a record row belongs to.
export function drillGroup(row) {
  const kind = String(row.kind ?? "").toLowerCase();
  const mob = String(row.mobility ?? "").toLowerCase();
  if (kind === "staff") return "staff";
  if (STEP_FREE.has(mob)) return "assisted";
  if (kind === "patient" || kind === "visitor") return "walk";
  return null;
}

function countBy(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] ?? 0) + 1;
  return out;
}

export function simulate(model, scenario, options) {
  return createSimulation(model, scenario, options).run();
}

export function mean(xs) {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
export function sd(xs) {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

// Repeated runs with different seeds (people's speeds, delays, behaviour,
// sensor faults and the real spread speed all vary).
export function simulateMany(model, scenario, options, seeds) {
  const results = seeds.map((seed) => simulate(model, scenario, { ...options, seed }));
  return { results, stats: statsOf(results) };
}

export const METRICS = [
  { key: "t50", label: "T50 (s)", lowerBetter: true },
  { key: "t90", label: "T90 (s)", lowerBetter: true },
  { key: "lastSafe", label: "Last person safe (s)", lowerBetter: true },
  { key: "meanFed", label: "Mean dose (FED)", lowerBetter: true },
  { key: "maxFed", label: "Highest dose (FED)", lowerBetter: true },
  { key: "harmed", label: "Reached by the hazard (FED >= 0.3)", lowerBetter: true },
  { key: "incapacitated", label: "Incapacitated (FED >= 1)", lowerBetter: true },
  { key: "safe", label: "People safe at the end", lowerBetter: false },
];

export function statsOf(results) {
  const out = { runs: results.length };
  for (const m of METRICS) {
    const xs = results.map((r) => r[m.key]);
    out[m.key] = { mean: mean(xs), sd: sd(xs), n: xs.filter((x) => x !== null).length };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drill check (validation against a drill record) and calibration
// ---------------------------------------------------------------------------

export function cumulative(times, grid) {
  const sorted = [...times].sort((a, b) => a - b);
  let j = 0;
  return grid.map((t) => {
    while (j < sorted.length && sorted[j] <= t) j++;
    return j;
  });
}

function curveAt(curve, grid) {
  return grid.map((t) => {
    let v = 0;
    for (const [ct, c] of curve) {
      if (ct <= t) v = c;
      else break;
    }
    return v;
  });
}

// drillRows: [{code, exit, exit_time_s}]; runs: summaries of a drill scenario.
export function compareWithDrill(drillRows, runs, step = 10) {
  const times = drillRows.map((r) => r.exit_time_s);
  const end = Math.max(...times, ...runs.map((r) => r.t));
  const grid = [];
  for (let t = 0; t <= end + step; t += step) grid.push(t);
  const observed = cumulative(times, grid);
  const sims = runs.map((r) => curveAt(r.curve, grid));
  const m = grid.map((_, i) => sims.reduce((s, c) => s + c[i], 0) / sims.length);
  const low = grid.map((_, i) => Math.min(...sims.map((c) => c[i])));
  const high = grid.map((_, i) => Math.max(...sims.map((c) => c[i])));
  let se = 0;
  for (let i = 0; i < grid.length; i++) se += (m[i] - observed[i]) ** 2;
  const total = drillRows.length;
  const obs = { t50: percentileTime(times, total, 0.5), t90: percentileTime(times, total, 0.9), last: Math.max(...times) };
  const sim = { t50: mean(runs.map((r) => r.t50)), t90: mean(runs.map((r) => r.t90)), last: mean(runs.map((r) => r.lastSafe)) };
  const exits = {};
  for (const r of drillRows) exits[r.exit] = (exits[r.exit] ?? 0) + 1;
  const simExits = {};
  for (const r of runs) for (const x of r.exits) simExits[x.exit] = (simExits[x.exit] ?? 0) + x.people / runs.length;
  const names = [...new Set([...Object.keys(exits), ...Object.keys(simExits)])].sort();
  // Per group (walking people, staff, assisted patients) when the record says who is who:
  // RMSE of the cumulative curve as a percentage of the group's size.
  const groups = {};
  let fit = 0;
  let fitParts = 0;
  for (const g of ["walk", "staff", "assisted"]) {
    const obsT = drillRows.filter((r) => drillGroup(r) === g).map((r) => r.exit_time_s);
    if (!obsT.length || !runs[0].outByGroup) continue;
    const o = cumulative(obsT, grid);
    const simC = runs.map((r) => cumulative(r.outByGroup[g], grid));
    const mg = grid.map((_, i) => simC.reduce((s, c) => s + c[i], 0) / simC.length);
    let e = 0;
    for (let i = 0; i < grid.length; i++) e += (mg[i] - o[i]) ** 2;
    const rm = Math.sqrt(e / grid.length);
    groups[g] = { people: obsT.length, rmse: round(rm, 2), percent: round((100 * rm) / obsT.length, 2) };
    fit += (100 * rm) / obsT.length;
    fitParts++;
  }
  const rmseAll = Math.sqrt(se / grid.length);
  return {
    fit: round(fitParts ? fit / fitParts : (100 * rmseAll) / total, 2),
    groups,
    grid,
    observed,
    mean: m.map((v) => round(v, 1)),
    low,
    high,
    rmse: round(Math.sqrt(se / grid.length), 2),
    inside: round((100 * grid.filter((_, i) => observed[i] >= low[i] && observed[i] <= high[i]).length) / grid.length, 0),
    observedStats: obs,
    simulatedStats: { t50: round(sim.t50 ?? 0, 0), t90: round(sim.t90 ?? 0, 0), last: round(sim.last ?? 0, 0) },
    errors: {
      t50: obs.t50 !== null && sim.t50 !== null ? round((100 * (sim.t50 - obs.t50)) / obs.t50, 1) : null,
      t90: obs.t90 !== null && sim.t90 !== null ? round((100 * (sim.t90 - obs.t90)) / obs.t90, 1) : null,
      last: round((100 * (sim.last - obs.last)) / obs.last, 1),
    },
    exits: names.map((name) => ({ exit: name, observed: exits[name] ?? 0, simulated: round(simExits[name] ?? 0, 1) })),
  };
}

// Scale the speed and delay parameters (calibration knobs).
export function scaledParams(base, speedScale, delayScale) {
  const p = { ...defaultParams(), ...base };
  for (const k of ["speed_staff", "speed_patient_min", "speed_patient_max", "speed_visitor", "speed_wheelchair", "speed_bed"]) p[k] = p[k] * speedScale;
  for (const k of ["staff_premove_mean", "staff_premove_sd", "prep_ambulatory_mean", "prep_ambulatory_sd", "prep_wheelchair_mean", "prep_wheelchair_sd", "prep_bed_mean", "prep_bed_sd", "visitor_premove_mean", "visitor_premove_sd"]) p[k] = p[k] * delayScale;
  return p;
}

// Grid search over speed and delay scales: fit on one drill, test on another.
export function calibrate(model, fitScenario, fitRows, options, seeds, grid = { speed: [0.8, 0.9, 1.0, 1.1, 1.2], delay: [0.7, 0.85, 1.0, 1.15, 1.3] }) {
  const tried = [];
  for (const sp of grid.speed) {
    for (const de of grid.delay) {
      const runs = seeds.map((seed) => simulate(model, fitScenario, { ...options, seed, params: scaledParams(options.params, sp, de) }));
      const cmp = compareWithDrill(fitRows, runs);
      tried.push({ speed: sp, delay: de, rmse: cmp.rmse, fit: cmp.fit });
    }
  }
  tried.sort((a, b) => a.fit - b.fit);
  // Pairs that fit almost as well: speed and delay can trade off against each other.
  const close = tried.filter((x) => x.fit <= tried[0].fit * 1.15);
  return { best: tried[0], close, tried };
}

// ---------------------------------------------------------------------------
// Replay recorded sensor readings through the same detection and estimate
// steps (gap 5: estimate from live or recorded readings, not a model run
// before the event).
// ---------------------------------------------------------------------------

// rows: [{sensor, t, value}]; returns the estimate at each check time.
export function replayReadings(model, rows, params = {}, { every = 10, designRate = null } = {}) {
  const p = { ...defaultParams(), ...params };
  const byId = new Map(model.sensors.map((s) => [s.id, s]));
  const unknown = [...new Set(rows.filter((r) => !byId.has(r.sensor)).map((r) => r.sensor))];
  const sorted = rows.filter((r) => byId.has(r.sensor)).sort((a, b) => a.t - b.t);
  const state = new Map(model.sensors.map((s) => [s.id, { recent: [], detectedAt: null, last: -Infinity }]));
  const detections = [];
  const out = [];
  const end = sorted.length ? sorted[sorted.length - 1].t : 0;
  const s0 = 1 / (designRate ?? p.est_default_rate);
  let k = 0;
  for (let t = 0; t <= end + every; t += every) {
    while (k < sorted.length && sorted[k].t <= t) {
      const r = sorted[k++];
      const s = byId.get(r.sensor);
      const st = state.get(r.sensor);
      st.last = r.t;
      st.recent.push(r.value >= sensorThreshold(s.kind, p));
      if (st.recent.length > 3) st.recent.shift();
      if (st.detectedAt === null && st.recent.filter(Boolean).length >= p.debounce_m) {
        st.detectedAt = r.t;
        detections.push({ node: s.node, t: r.t, kind: s.kind, w: 1, sensor: s.id });
      }
    }
    const silent = model.sensors.filter((s) => state.get(s.id).detectedAt === null && t - state.get(s.id).last <= 3 * p.sample_s + p.net_delay_s).map((s) => ({ node: s.node, kind: s.kind }));
    const est = estimateHazard(model, detections, silent, t, p, s0);
    out.push({ t, detections: detections.length, origin: est ? est.origin : null, rate: est ? est.rate : null, t0: est ? est.t0 : null, arrival: est ? est.arrival : null, outliers: est ? est.outliers : [] });
  }
  return { checks: out, detections, unknown };
}
