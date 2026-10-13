"""Simulation run reports (PROJECT.md build step 12): PDF and CSV.

Every figure comes from what was stored with the run (its snapshot, the
parameters it used and its results) or, for model accuracy, from the stored
metrics of the organization's evacuation-time predictor. Nothing is
recalculated or invented. Place names are the names at the time of the run.

Sections (PROJECT.md): summary, timeline, routes, bottlenecks,
recommendations, parameters used, model accuracy and the safety notice.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

SAFETY_NOTICE = (
    "HEALTH-11 supports planning and training. It does not replace a hospital's official "
    "emergency procedures or fire-safety professionals."
)
SIMULATION_NOTE = "These are simulation results for planning and training, not measurements."

# Characters that make spreadsheet programs treat a cell as a formula.
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


@dataclass
class Table:
    title: str
    columns: list[str]
    rows: list[list[Any]]
    note: str | None = None
    widths: list[float] | None = None  # relative column widths in the PDF


@dataclass
class Report:
    title: str
    facts: list[tuple[str, Any]]
    tables: list[Table] = field(default_factory=list)


# --- Collecting the content ----------------------------------------------------------------

NOBODY_PLACED = "nobody to evacuate (no people placed in this building)"


def _seconds(value) -> str | None:
    return None if value is None else f"{value:.0f}"


def _route_text(node_ids, names: dict[int, str]) -> str:
    return " > ".join(names.get(n, f"#{n}") for n in (node_ids or []))


def model_accuracy_rows(metrics: dict | None, trained_at: datetime | None,
                        min_runs: int | None) -> tuple[list[list[Any]], str | None]:
    """Stored accuracy of the organization's evacuation-time predictor."""
    if not metrics:
        needed = f" (at least {min_runs} complete runs are needed)" if min_runs else ""
        return [], ("No evacuation-time predictor has been trained for this organization yet"
                    f"{needed}. The simulation itself is a rule-based model; its assumptions "
                    "are listed under Parameters used.")
    rows = [
        ["Model", metrics.get("algorithm")],
        ["Trained at (UTC)", trained_at.isoformat(timespec="seconds") if trained_at else None],
        ["Training runs", metrics.get("training_runs")],
        ["Held-out test runs", metrics.get("test_runs")],
        ["Mean absolute error on test runs (s)", metrics.get("mae_s")],
        ["Error of always guessing the average (s)", metrics.get("baseline_mae_s")],
        ["R2 on test runs", metrics.get("r2")],
    ]
    return rows, ("Accuracy of the evacuation-time predictor (a surrogate of this simulator, "
                  "trained on this organization's runs), measured on runs held out from training.")


def build_report(run, *, scenario_name: str | None, building_name: str | None,
                 accuracy_rows: list[list[Any]], accuracy_note: str | None) -> Report:
    params = run.params or {}
    results = run.results or {}
    snapshot = params.get("snapshot") or {}
    names = {n["id"]: n["name"] for n in snapshot.get("nodes", [])}
    edge_labels = {
        e["id"]: f"{names.get(e['from_node_id'], e['from_node_id'])} – "
                 f"{names.get(e['to_node_id'], e['to_node_id'])}"
        for e in snapshot.get("edges", [])
    }
    summary = results.get("summary") or {}
    # With nobody placed there is nothing to evacuate: say so instead of
    # "Everyone evacuated: no", which would read like a failed evacuation.
    nobody = summary.get("total") == 0
    if nobody:
        everyone, evacuation_time = NOBODY_PLACED, NOBODY_PLACED
    else:
        everyone = summary.get("all_evacuated")
        evacuation_time = (_seconds(summary.get("evacuation_time_s"))
                           if summary.get("all_evacuated") else "not complete")

    facts = [
        ("Run", run.id),
        ("Created (UTC)", run.created_at.isoformat(timespec="seconds") if run.created_at else None),
        ("Scenario", scenario_name),
        ("Building", building_name),
        ("Routing algorithm", run.algorithm),
        ("People simulated", summary.get("total")),
        ("Reached an exit", summary.get("evacuated")),
        ("Need assisted evacuation", summary.get("needs_assistance")),
        ("Reached by the hazard", summary.get("reached_by_hazard")),
        ("Still moving when the simulation stopped", summary.get("still_moving")),
        ("Everyone evacuated", everyone),
        ("Evacuation time (s)", evacuation_time),
        ("Mean walking distance (m)", summary.get("mean_distance_m")),
        ("Mean waiting time (s)", summary.get("mean_wait_s")),
        ("Re-routes", summary.get("reroutes")),
    ]

    hazards = [[h.get("name"), h.get("type"), names.get(h.get("origin_node_id"), h.get("origin_node_id")),
                h.get("severity"), h.get("spread_rate"), "scenario"]
               for h in snapshot.get("hazards", [])]
    hazards += [[h.get("name"), h.get("type"), names.get(h.get("origin_node_id"), h.get("origin_node_id")),
                 h.get("severity"), h.get("spread_rate"),
                 f"added at {(h.get('start_minutes') or 0) * 60:.0f} s"]
                for h in params.get("injected_hazards", [])]

    timeline = [[f["t"], f["evacuated"], f["active"], f["needs_assistance"], f["reached_by_hazard"],
                 ", ".join(names.get(n, str(n)) for n in f.get("blocked_nodes", [])),
                 ", ".join(edge_labels.get(e, str(e)) for e in f.get("congested_edges", []))]
                for f in results.get("timeline", [])]

    routes = [[r["id"], r["kind"], r["mobility"], names.get(r["start_node_id"], r["start_node_id"]),
               r["status"], names.get(r["exit_node_id"]) if r.get("exit_node_id") else None,
               r.get("evacuated_at_s"), r.get("distance_m"), r.get("wait_s"), r.get("reroutes"),
               _route_text(r.get("initial_route"), names), r.get("reason")]
              for r in results.get("routes", [])]

    bottlenecks = [[b["label"], ", ".join(b.get("reasons", [])), b.get("queue_minutes"),
                    b.get("max_wait_s"), b.get("people")] for b in results.get("bottlenecks", [])]

    events = [[e["t"], ", ".join(names.get(n, str(n)) for n in e.get("unusable_node_ids", []))]
              for e in results.get("hazard_events", [])]

    exit_load = [[names.get(int(k), k) if str(k).isdigit() else k, v]
                 for k, v in sorted((results.get("exit_load") or {}).items(), key=lambda kv: -kv[1])]

    recommendations = [[r.get("severity"), r.get("text")] for r in results.get("recommendations", [])]

    parameters = [[p.get("name"), p.get("value"), p.get("unit"), p.get("source"), p.get("meaning")]
                  for p in params.get("parameters_used", [])]

    return Report(
        title=f"HEALTH-11 simulation report — run {run.id}",
        facts=facts,
        tables=[
            Table("Hazards", ["Name", "Type", "Origin", "Severity", "Spread (m/min)", "When"], hazards,
                  widths=[3, 1.2, 3, 1, 1.3, 1.6]),
            Table("Recommendations", ["Severity", "Recommendation"], recommendations, widths=[1, 9]),
            Table("Bottlenecks", ["Corridor", "Reasons", "Planned queue (min)", "Longest wait (s)",
                                  "People through"], bottlenecks,
                  note=None if bottlenecks else "No bottlenecks were found in this run.",
                  widths=[3, 3, 1.2, 1.2, 1.2]),
            Table("People per exit", ["Exit", "People"], exit_load, widths=[4, 1]),
            Table("Timeline", ["Time (s)", "Evacuated", "Moving", "Need assistance",
                               "Reached by hazard", "Blocked places", "Queues at"], timeline,
                  widths=[0.8, 0.9, 0.8, 1, 1, 3.5, 3.5]),
            Table("Hazard spread", ["Time (s)", "Places that became unusable"], events,
                  widths=[1, 9]),
            Table("Routes", ["Person", "Kind", "Mobility", "Start", "Outcome", "Exit", "Out at (s)",
                             "Distance (m)", "Waited (s)", "Re-routes", "Planned route", "Reason"],
                  routes, note="People are listed by record number only; no names are included.",
                  widths=[1.3, 0.7, 1.4, 1.5, 1.6, 1.2, 1.1, 1.2, 1.1, 1.1, 3.4, 2.4]),
            Table("Parameters used", ["Name", "Value", "Unit", "Source", "Meaning"], parameters,
                  note="Values marked 'assumed, to be validated' are defaults, not sourced data.",
                  widths=[2.4, 0.8, 1, 2.4, 4]),
            Table("Model accuracy", ["Measure", "Value"], accuracy_rows, note=accuracy_note,
                  widths=[3, 2]),
        ],
    )


# --- CSV -----------------------------------------------------------------------------------

def safe_cell(value: Any) -> Any:
    """Text that a spreadsheet would run as a formula is prefixed with ' (OWASP)."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, str) and value.startswith(_FORMULA_START):
        return "'" + value
    return value


def to_csv(report: Report) -> bytes:
    """One file, one block per section: a title row, a header row, the data rows
    and a blank row. UTF-8 with a byte-order mark so Excel shows every script."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow([safe_cell(report.title)])
    writer.writerow([SAFETY_NOTICE])
    writer.writerow([SIMULATION_NOTE])
    writer.writerow([])
    writer.writerow(["Summary"])
    writer.writerow(["Item", "Value"])
    for label, value in report.facts:
        writer.writerow([label, safe_cell(value)])
    for table in report.tables:
        writer.writerow([])
        writer.writerow([table.title])
        if table.note:
            writer.writerow([safe_cell(table.note)])
        writer.writerow(table.columns)
        for row in table.rows:
            writer.writerow([safe_cell(v) for v in row])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


# --- PDF -----------------------------------------------------------------------------------

def _text(value: Any) -> str:
    if value is None:
        return "–"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:g}"
    return escape(str(value))  # names are user input: never parsed as markup


def _register_font(font_path: Path | None) -> tuple[str, str]:
    if not font_path:
        return "Helvetica", "Helvetica-Bold"
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    name = "ReportFont"
    if name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(name, str(font_path)))
    return name, name


def to_pdf(report: Report, font_path: Path | None = None) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle

    regular, bold = _register_font(font_path)
    body = ParagraphStyle("body", fontName=regular, fontSize=8, leading=10, alignment=TA_LEFT)
    cell = ParagraphStyle("cell", parent=body, fontSize=7, leading=8.5)
    head = ParagraphStyle("head", parent=cell, fontName=bold)
    h1 = ParagraphStyle("h1", parent=body, fontName=bold, fontSize=14, leading=18, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=body, fontName=bold, fontSize=11, leading=14,
                        spaceBefore=8, spaceAfter=3)
    notice = ParagraphStyle("notice", parent=body, textColor=colors.HexColor("#7a2e00"))

    page = landscape(A4)
    width = page[0] - 24 * mm
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=page, leftMargin=12 * mm, rightMargin=12 * mm,
                            topMargin=12 * mm, bottomMargin=16 * mm, title=report.title,
                            author="HEALTH-11", invariant=1)

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont(regular, 7)
        canvas.drawString(12 * mm, 8 * mm, SAFETY_NOTICE)
        canvas.drawRightString(page[0] - 12 * mm, 8 * mm, f"Page {document.page}")
        canvas.restoreState()

    def grid(columns, rows, weights=None):
        weights = weights or [1] * len(columns)
        data = [[Paragraph(_text(c), head) for c in columns]]
        data += [[Paragraph(_text(v), cell) for v in row] for row in rows]
        table = LongTable(data, colWidths=[width * w / sum(weights) for w in weights],
                          repeatRows=1)
        table.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#b0b0b0")),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eef4")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        return table

    story = [Paragraph(_text(report.title), h1),
             Paragraph(_text(SAFETY_NOTICE), notice),
             Paragraph(_text(SIMULATION_NOTE), body),
             Paragraph("Summary", h2),
             grid(["Item", "Value"], report.facts, [35, 65])]
    for table in report.tables:
        story.append(Paragraph(_text(table.title), h2))
        if table.note:
            story.append(Paragraph(_text(table.note), body))
            story.append(Spacer(1, 2 * mm))
        if table.rows:
            story.append(grid(table.columns, table.rows, table.widths))
        elif not table.note:
            story.append(Paragraph("None.", body))
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
