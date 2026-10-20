# HEALTH-11 user guide

HEALTH-11 helps a hospital plan and practise evacuations. You describe your
buildings as a map of places and paths, add your patients and staff, create
emergency scenarios, and the system calculates routes, simulates the
evacuation step by step, finds bottlenecks and writes reports.

> HEALTH-11 supports planning and training. It does not replace a hospital's
> official emergency procedures or fire-safety professionals.

Everything you see comes from your organization's own data. Nothing about a
hospital is built into the program, and no other organization can see your
data.

## Contents

1. [Roles](#roles)
2. [First steps for a new hospital](#first-steps-for-a-new-hospital)
3. [The pages](#the-pages)
4. [How the AI features work (and what they are not)](#how-the-ai-features-work)
5. [A 10-minute demo with the DEMO data](#a-10-minute-demo-with-the-demo-data)
6. [Files you can import and export](#files-you-can-import-and-export)

## Roles

Roles are per organization. The first person who signs an organization up
becomes its Administrator.

| Role | Can use |
|---|---|
| **Administrator** | Every page, including **Admin**: add, edit and deactivate users, and read the audit log of the organization. |
| **Emergency Commander** | Every page except Admin: change facilities, floor plans, people, scenarios and parameters, and run simulations. |
| **Staff User** | Read-only: Dashboard, Live Simulation, Patients & Staff, Reports & History (and their own Settings / Profile). |

## First steps for a new hospital

1. **Sign up** on the Register page with your organization's name, your name,
   email and a strong password. You become its Administrator. Note the
   **Organization ID** shown after sign-up; everyone in your organization
   types it on the login page.
2. The **Onboarding** wizard then walks you through:
   1. create the hospital;
   2. create a building and its first floor;
   3. import or draw that floor's map (places and paths);
   4. run a first simulation.
3. Add your **patients and staff** (one at a time, or from a CSV file).
4. Create **scenarios** and run them.

## The pages

### Landing, Login and Register
The public pages. Login needs the **Organization ID**, your email and your
password. After 5 wrong passwords for one account, logins to it are paused
for a while; sign-up and login are also limited per network address.
**Forgot password?** e-mails a 6-digit code (valid 10 minutes, works once) to
the account's address; enter it with a new password. This needs e-mail to be
set up on the server (README section 13) and a real inbox for the account.

### Dashboard
Where your hospital stands right now: number of hospitals, active scenarios,
the last evacuation time and bottlenecks found, the most recent simulation
runs, and **alerts** (unusual runs, see the AI section). While the hospital is
not fully set up, a **Get started** card leads back to the onboarding wizard.

### Facility Manager
Hospitals, their buildings and their floors: add, edit and delete them. A
hospital has an address, a time zone (used for the times shown in reports) and
an optional **map position** (latitude and longitude in decimal degrees; in a map
app, right-click the hospital and copy its position, then paste both numbers
into Latitude). The position is needed for outside data such as weather and
official alerts. With a position, **Find on OpenStreetMap** lists hospitals that
OpenStreetMap knows nearby; **Use this** saves that place's address and
position (and its name, if you tick the box). OpenStreetMap is written by
volunteers, so check it is the right place. Data © OpenStreetMap contributors
(ODbL).
**Import CSV / GeoJSON** adds the places and paths of a floor file to one of
your floors (nothing already on the floor is changed); it is available once a
floor exists. Each floor has **Export** links (JSON, GeoJSON, CSV). **Open map**
on a floor opens it in the Graph Builder.

### Graph Builder
The map of one floor. **Places** are rooms, wards, ICUs, corridors, stairs,
ramps, lifts, exits and assembly points. **Paths** connect two places and have
a length in metres, a width, a maximum flow (people per minute), and whether
wheelchairs and stretchers can use them. Every change is saved straight away.

- Click a place or path on the map, or pick it from the lists, to edit it.
- **Blocked** marks a place or path as unusable.
- A lift can be marked as an **Evacuation lift** (a protected lift that may be
  used in a fire). Ordinary lifts are not used in fire or smoke scenarios.
- **Links to other floors** connect stairs, ramps and lifts between floors, so
  routes can go through the whole building.
- Whole floor files are imported and exported in the Facility Manager.

Movement rules: stretcher, ventilator and wheelchair patients never use stairs
or paths marked not accessible for them. Walking patients and staff can use
stairs and ramps.

### Scenario Builder
A scenario is an emergency to plan for, in three steps: **hazard type**
(fire, smoke, hazmat, structural), **place** where it starts, and
**severity** (1 to 5) with a **spread rate**. A scenario can have several
hazards, or none (a calm evacuation drill). Hazards spread over time and block
the places and paths they reach. You also choose the **building to evacuate**;
hazards in other buildings do not affect that run.

### Live Simulation
Plays an evacuation step by step on the floor map: people move along their
routes, queues form on busy paths, and the right-hand panel shows who is
still moving, people per exit, blocked places and paths with a queue, and
how many people were reached by the hazard. You can
choose the playback speed, pause and resume, and **add a hazard during the
run**: everyone still inside is re-routed around it (dynamic re-routing).
People with no safe route to any exit are counted under **Need assisted
evacuation**, so staff can plan to help them.

### Algorithm Comparison
Runs the same scenario with four ways of finding routes (BFS, DFS, Dijkstra
and A*) and compares evacuation time, mean walking distance and risk
exposure, with the **fastest**, **shortest walk** and **lowest risk** marked.
"How this comparison works" explains each method.

### Patients & Staff
Your patients (stored by code only, never names), with mobility (walking,
wheelchair, stretcher, ventilator), criticality (1 to 5) and where they are;
and your staff. **Who to evacuate first** ranks patients with a transparent
score (see the AI section). **Import CSV** replaces the whole list with a file:
it first shows what would be added, changed and removed, and saves nothing
until you choose **Apply changes**. **Export CSV** downloads the list.
**Test data** marks made-up records.

### AI Assistant
- **Describe an emergency**: type what is happening in your own words (for
  example "fire in corridor C1, spreading fast"). The assistant turns it into
  a scenario draft that uses only places that exist on the chosen floor. If a
  place is unclear or missing, it asks a question instead of guessing. Nothing
  runs until you press **Run it**.
- **Explain a run**: a plain-language summary of a simulation run, written only
  from that run's stored results.

Use made-up data when the AI service is a cloud service.

### Reports & History
All simulation runs, with their timeline, routes, bottlenecks and
recommendations. Each run can be downloaded as a **PDF** or **CSV** report
(timeline, routes, bottlenecks, recommendations, parameters used, model
accuracy and the safety notice). **Estimate without simulating** uses the
evacuation-time predictor, with **About this prediction**.

### Admin (Administrators only)
**Users**: add, edit, change roles, deactivate. **Audit log**: every create,
update and delete, every login and failed login in your organization, with
filters.

### Settings / Profile
Your name and password. **Model parameters**: the numbers the simulations use
(walking, wheelchair, stretcher and ventilator speeds, hazard and bottleneck
thresholds, simulation step length and so on). Each has a unit and a
**source**; a value without a real citation says "assumed, to be validated".
**Use default** goes back to the built-in value.

## How the AI features work

PROJECT.md requires each feature to say honestly what it is. The pages show
the same explanations ("How this works", "About this prediction").

| Feature | What it really is |
|---|---|
| Evacuation-time predictor | Machine learning (a scikit-learn regression model) trained on **your own simulation runs** (a surrogate of our simulator). It shows its real error (MAE) and R² on runs held out for testing. With too few runs it gives no number and says why. |
| Patient priority score | A transparent weighted formula of mobility, criticality and distance to the hazard. Rule-based, not machine learning. The breakdown is shown. |
| Fire and smoke spread | A cellular-automaton model using each hazard's spread rate. It gives each place a risk score that routes avoid. Algorithmic, not machine learning. |
| Commander assistant | A language model (Anthropic Claude, Google Gemini, Groq or a local Ollama model, set in `.env`) turns your text into a scenario draft that is checked against the real floor. It never runs anything by itself. |
| Unusual-run alerts | Machine learning (scikit-learn IsolationForest) over past runs, together with the bottleneck detector. Below 50 runs it shows "more data needed". |
| Bottleneck detection | Betweenness centrality plus how full each path gets, with plain-language recommendations. Algorithmic. |

## A 10-minute demo with the DEMO data

The demo seed loads a made-up organization into the **development** database
(README section 11). It holds PROJECT.md's Test case floor:

```
ICU --10-- C1 --12-- S1 (stair) --20-- E1 (exit)
 |          |  \--18-- R1 (ramp) --15-- E1
 14         8
 |          |
 C2 --12-- WardA
 |  \--10-- S2 (stair) --25-- E2 (exit)
 \----16-- R2 (ramp) --20-- E2
```

plus 10 synthetic patients (in the ICU and WardA), 4 synthetic staff, the
default parameters and two scenarios.

1. **Log in** with the Organization ID and email the seed printed, and the
   password you chose.
2. **Graph Builder**: open "DEMO Hospital > DEMO Block A > Ground floor" and
   look at the map.
3. **Scenario Builder**: open "DEMO: fire at corridor C1". The fire blocks C1.
4. **Algorithm Comparison**: compare the fire scenario across the four
   methods. Behind the numbers: walking patients from WardA go WardA, C2, S2,
   E2 (47 m) and stretchers from the ICU go ICU, C2, R2, E2 (50 m), because C1
   is blocked and stretchers cannot use stairs. Without the fire (the drill)
   the routes are WardA, C1, S1, E1 (40 m) and ICU, C1, R1, E1 (43 m).
5. **Live Simulation**: run the fire scenario and watch it. Try **Add a
   hazard** during the run, for example smoke at C2, and see people re-routed.
6. **Patients & Staff**: see **Who to evacuate first** for the fire scenario.
7. **Reports & History**: open the run and download the PDF.
8. **AI Assistant** (needs an AI key in `.env`): type "smoke near S2,
   severity 3" and see the draft; then explain the run.
9. **Dashboard**: the new runs appear; alerts still say "more data needed"
   until there are 50 runs.

## Files you can import and export

| What | Where | Formats |
|---|---|---|
| One floor's places and paths | Facility Manager: Import CSV / GeoJSON, and each floor's Export links | CSV, GeoJSON, JSON (up to 5 MB, 5,000 places, 20,000 paths) |
| Patients | Patients & Staff, Import CSV / Export CSV | CSV (the full list; up to 1 MiB, 5,000 rows) |
| Staff | Patients & Staff, Import CSV / Export CSV | CSV (the full list) |
| Simulation report | Reports & History | PDF, CSV |

Imports are checked completely before anything is saved. A problem is
reported by row and column, and nothing is saved until the whole file is
correct.
