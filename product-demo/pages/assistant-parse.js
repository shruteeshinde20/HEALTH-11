// The demo assistant's rule-based reader: turns a plain-English request into a
// scenario. No network, no AI model; every rule is written here so it can be tested.

const FIRE = /\b(fire|fires|smoke|smoky|burn|burning|burns|flames?|short[- ]?circuit|blaze|spark|sparks)\b/;
const DRILL = /\b(drill|practice|practise|rehearsal|evacuation test|no fire)\b/;
const SUMMARY = /\b(summar(y|ise|ize)|last run|latest run|how did (it|the run) go|results?)\b/;
const HELP = /^(help|\?|what can you do\??|hi|hello|hey)\b/;
const CLOSED = /\b(closed|close|blocked|block|locked|out of (use|order)|not working|unusable)\b/;
const GENERIC = new Set(["room", "rooms", "bay", "ward", "unit", "area", "the", "of", "and", "g", "1", "2", "3", "4", "5", "w", "a", "b", "c", "store", "office", "station", "base"]);
const ORD = { ground: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

export function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

// Which floor does the text name? ("floor 3", "3rd floor", "third floor", "ground floor")
export function floorIn(text) {
  const t = norm(text);
  let m = t.match(/\bfloor (\d)\b/) || t.match(/\b(\d)(st|nd|rd|th)? floor\b/) || t.match(/\blevel (\d)\b/);
  if (m) return Number(m[1]);
  m = t.match(/\b(ground|first|second|third|fourth|fifth) floor\b/);
  if (m) return ORD[m[1]];
  return null;
}

// Score how well each place matches the text. Returns the best places (ties kept).
export function matchPlaces(text, places, { types = null } = {}) {
  const t = ` ${norm(text)} `;
  const floor = floorIn(text);
  let best = 0;
  let out = [];
  for (const p of places) {
    if (types && !types.includes(p.type)) continue;
    const id = norm(p.id);
    let score = 0;
    if (t.includes(` ${id} `)) score = 100 + id.length;
    else {
      let words = id.split(" ").filter((w) => !GENERIC.has(w) && w.length > 1);
      // names made only of common words ("Store Room 3"): match the words, not the number
      if (!words.length) words = id.split(" ").filter((w) => w.length > 1 && !/^\d+$/.test(w));
      if (!words.length) continue;
      const hit = words.filter((w) => t.includes(` ${w} `) || t.includes(` ${w}s `)).length;
      if (hit === words.length) score = 50 + hit * 5;
      else if (hit > 0) score = 10 + hit * 5;
    }
    if (score > 0 && floor !== null && p.floor === floor) score += 30;
    if (score > best) {
      best = score;
      out = [p];
    } else if (score === best && score > 0) out.push(p);
  }
  return { best, places: out };
}

// Read a request. places: [{id, type, floor}]. Returns one of:
// {kind:"help"} | {kind:"summary"} | {kind:"clarify", question, options:[ids], partial}
// | {kind:"scenario", scenario, notes:[...]} | {kind:"unknown"}
export function parseRequest(textIn, places) {
  const text = String(textIn ?? "").slice(0, 500);
  const t = norm(text);
  if (!t) return { kind: "unknown" };
  if (HELP.test(t)) return { kind: "help" };
  if (SUMMARY.test(t) && !FIRE.test(t)) return { kind: "summary" };
  const fire = FIRE.test(t) && !/\bno fire\b/.test(t);
  const drill = !fire && DRILL.test(t);
  if (!fire && !drill) return { kind: "unknown" };
  const notes = [];

  // speed of smoke
  let smokeRate = 0.08;
  const num = t.match(/(\d*\.\d+|\d+) ?m ?s\b/) || t.match(/(\d*\.\d+) ?(m\/s|metres? per second)/);
  if (fire && num && Number(num[1]) > 0 && Number(num[1]) <= 1) {
    smokeRate = Number(num[1]);
    notes.push(`Smoke speed ${smokeRate} m/s as you wrote.`);
  } else if (fire && /\b(fast|quick|quickly|rapid|rapidly|spreads? fast|big|large|huge|serious)\b/.test(t)) {
    smokeRate = 0.15;
    notes.push("Fast smoke: 0.15 m/s.");
  } else if (fire && /\b(slow|slowly|small|minor)\b/.test(t)) {
    smokeRate = 0.05;
    notes.push("Slow smoke: 0.05 m/s.");
  } else if (fire) notes.push("Smoke speed not given: the usual 0.08 m/s.");

  // closed exits, stairs or lifts
  let closed = [];
  if (CLOSED.test(t)) {
    const exitsEtc = places.filter((p) => ["exit", "stair", "lift"].includes(p.type));
    const names = new Map();
    for (const p of exitsEtc) {
      const id = norm(p.id);
      if (t.includes(id)) names.set(p.id, id.length);
    }
    // "stair a" without a floor means the whole stair: every floor's "Stair A n"
    for (const letter of ["a", "b", "c"]) {
      if (new RegExp(`\\bstair(case)? ${letter}\\b`).test(t)) for (const p of exitsEtc) if (p.type === "stair" && norm(p.id).startsWith(`stair ${letter} `)) names.set(p.id, 1);
    }
    closed = [...names.keys()];
    if (closed.length) notes.push(`Closed from the start: ${closed.join(", ")}.`);
  }

  // imperfect information (gap 4)
  const params = {};
  if (/\b(sensors? (are |is )?(broken|faulty|failing|old|not working)|faulty sensors?|broken sensors?|bad sensors?)\b/.test(t)) {
    Object.assign(params, { p_dead: 0.2, p_stuck: 0.08, p_flaky: 0.15 });
    notes.push("Many faulty sensors: 20% dead, 8% stuck, 15% losing readings.");
  }
  if (/\b(no phones?|phones? (are )?down|network (is )?down|no mobile)\b/.test(t)) {
    Object.assign(params, { phone_patient: 0, phone_visitor: 0 });
    notes.push("No phone messages: people rely on signs and staff.");
  }
  if (/\b(panic|panicking|do not follow|don t follow|not follow|ignore)\b/.test(t)) {
    params.compliance = 0.4;
    notes.push("Only 40% follow guidance.");
  }
  if (/\b(signs? (are )?(broken|not working|failing|off)|power cut|power failure)\b/.test(t)) {
    params.sign_fail = 0.4;
    notes.push("40% of the dynamic exit signs do not work.");
  }
  const alarm = /\b(no alarm|alarm (does not|doesn t|didn t) (work|sound)|manual alarm|found by)\b/.test(t) ? "manual" : "sensors";
  if (alarm === "manual") notes.push("The alarm is raised by people who find the fire, not by sensors.");

  if (drill) {
    return {
      kind: "scenario",
      scenario: { name: closed.length ? `Assistant: drill with ${closed.slice(0, 2).join(" and ")} closed` : "Assistant: evacuation drill", origin: null, start: 0, smokeRate: 0.08, fireRate: 0.01, alarm: "sensors", closed, note: "Made by the demo assistant: an evacuation drill without a hazard.", params },
      notes,
    };
  }

  // where the fire starts: try burnable places first (not corridors, exits, stairs, lifts)
  const rooms = places.filter((p) => !["exit", "stair", "lift"].includes(p.type) && !closed.includes(p.id));
  const textNoClosed = closed.reduce((acc, c) => acc.replace(new RegExp(norm(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " "), t);
  const { best, places: found } = matchPlaces(textNoClosed, rooms);
  const partial = { start: 0, smokeRate, fireRate: Math.round((smokeRate / 8) * 1000) / 1000, alarm, closed, params };
  if (!found.length || best < 15) return { kind: "clarify", question: "Where does the fire start? Name a room, for example NICU Bay 2, Kitchen or Store Room 3.", options: [], partial, notes };
  if (found.length > 1) {
    return { kind: "clarify", question: `I found ${found.length} places that match. Which one?`, options: found.slice(0, 8).map((p) => p.id), partial, notes };
  }
  const origin = found[0].id;
  return {
    kind: "scenario",
    scenario: { name: `Assistant: fire in ${origin}`, origin, ...partial, note: `Made by the demo assistant from: "${text.slice(0, 160)}"` },
    notes,
  };
}
