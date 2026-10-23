#!/usr/bin/env python3
"""Render an offline, evidence-linked comparison from benchmark.mjs output."""
from __future__ import annotations

import html
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("XDG_CACHE_HOME", str(Path(__file__).resolve().parents[1] / ".runtime/benchmark-cache"))
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


PAPER = "#f7f6f0"
INK = "#18382d"
MUTED = "#64746c"
COLORS = ["#216a50", "#94b6a3"]
NAMES = {"docker": "Docker Model Runner", "native": "Native vLLM Metal"}


def esc(value):
    return html.escape(str(value), quote=True)


def number(value, digits=1):
    if value is None or not isinstance(value, (int, float)) or not math.isfinite(value):
        return "—"
    return f"{value:,.{digits}f}"


def milliseconds(value):
    return f"{number(value, 0)} ms" if value is not None else "—"


def load_json(path):
    return json.loads(path.read_text())


def markdown_table(headers, rows):
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")
    return "\n".join([
        "| " + " | ".join(map(cell, headers)) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
        *("| " + " | ".join(map(cell, row)) + " |" for row in rows),
    ])


def html_table(headers, rows):
    return '<div class="table-scroll"><table><thead><tr>' + "".join(
        f"<th>{esc(v)}</th>" for v in headers
    ) + "</tr></thead><tbody>" + "".join(
        "<tr>" + "".join(f"<td>{esc(v)}</td>" for v in row) + "</tr>" for row in rows
    ) + "</tbody></table></div>"


def chart(folder, filename, title, subtitle, workloads, rows, key, xlabel):
    """Grouped horizontal bars, no aggregate of unlike workloads."""
    if not workloads:
        return None
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "text.color": INK, "axes.labelcolor": MUTED,
                         "xtick.color": MUTED, "ytick.color": INK,
                         "svg.fonttype": "none"})
    height = max(3.6, .72 * len(workloads) + 1.7)
    fig, ax = plt.subplots(figsize=(11.5, height))
    fig.patch.set_facecolor(PAPER)
    ax.set_facecolor(PAPER)
    positions = np.arange(len(workloads))
    maximum = 0
    for index, backend in enumerate(["docker", "native"]):
        vals = [next((r.get(key) for r in rows if r["workload"] == w["id"] and r["backend"] == backend), None)
                for w in workloads]
        clean = [v if v is not None else 0 for v in vals]
        maximum = max(maximum, *clean)
        bars = ax.barh(positions + (index - .5) * .30, clean, .26,
                       color=COLORS[index], label=NAMES[backend], zorder=3)
        for bar, value in zip(bars, vals):
            if value is not None:
                ax.annotate(number(value, 0 if "ms" in key else 1),
                            (bar.get_width(), bar.get_y() + bar.get_height()/2),
                            xytext=(6, 0), textcoords="offset points", va="center",
                            color=INK, fontsize=9)
    ax.set_yticks(positions, [w["title"] for w in workloads])
    ax.invert_yaxis()
    ax.set_xlim(0, maximum * 1.23 if maximum else 1)
    ax.set_xlabel(xlabel, labelpad=12)
    ax.grid(axis="x", color="#dce2d8", linewidth=.7, zorder=0)
    ax.tick_params(axis="both", length=0)
    ax.tick_params(axis="y", pad=12)
    for spine in ax.spines.values():
        spine.set_visible(False)
    fig.suptitle(title, x=.035, ha="left", y=1-.16/height, fontsize=17, fontweight="bold")
    fig.text(.035, 1-.57/height, subtitle, color=MUTED, fontsize=10)
    fig.legend(*ax.get_legend_handles_labels(), loc="upper left", bbox_to_anchor=(.36, 1-.70/height), frameon=False, ncol=2)
    fig.subplots_adjust(left=.37, right=.91, bottom=.65/height, top=1-1.17/height)
    fig.savefig(folder / f"{filename}.svg", facecolor=PAPER, bbox_inches="tight")
    fig.savefig(folder / f"{filename}.png", dpi=180, facecolor=PAPER, bbox_inches="tight")
    plt.close(fig)
    return {"name": filename, "title": title, "subtitle": subtitle}


def environment_rows(folder, raw):
    path = folder / "environment-before.json"
    env = load_json(path) if path.exists() else {}
    def out(key, fallback="Not recorded"):
        return env.get(key, {}).get("output", "").strip() or fallback
    memory = out("memory")
    try:
        memory = f"{int(memory) / 1024**3:g} GiB unified memory"
    except ValueError:
        pass
    power = out("power").splitlines()[0]
    rows = [["Host", out("cpu")], ["Memory", memory],
            ["OS", out("macos").replace("\t", " ").replace("\n", "; ")],
            ["Power", power], ["Scheduling (recorded deployment setting)", "max_num_seqs=1 on both"]]
    for service in raw.get("services", []):
        name = NAMES[service["id"]]
        config = service.get("config", {}).get("body", {})
        rows += [[f"{name} runtime", config.get("backend", "Not recorded")],
                 [f"{name} context", f"{number(config.get('context_length'), 0)} tokens"],
                 [f"{name} Responses", config.get("responses_mode", "Not recorded")],
                 [f"{name} model", config.get("model", "Not recorded")],
                 [f"{name} client endpoint", service["base_url"] + "/v1"]]
    for phase in ["before", "after"]:
        capture = folder / f"environment-{phase}.json"
        thermal = load_json(capture).get("thermal", {}) if capture.exists() else {}
        output = thermal.get("output", "").strip()
        if output and thermal.get("exit_code") == 0:
            rows.append([f"Thermal snapshot {phase}", output.replace("\n", "; ")])
    return rows


CSS = """
:root{color-scheme:light;--paper:#f7f6f0;--ink:#18382d;--muted:#64746c;--line:#dce2d8;--green:#216a50}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:var(--green);text-underline-offset:3px}main{max-width:1240px;margin:0 auto;padding:40px 38px 70px}header{padding:20px 0 34px;border-bottom:1px solid var(--line)}
.eyebrow{font-size:11px;font-weight:750;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}h1{font-size:clamp(32px,5vw,58px);letter-spacing:-.055em;line-height:1.08;max-width:900px;margin:18px 0 22px;font-weight:650}
.lead{font-size:19px;line-height:1.55;max-width:900px;color:var(--muted);margin:0}.meta{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;color:var(--muted);margin-top:24px}
nav{display:flex;gap:20px;flex-wrap:wrap;padding:17px 0;border-bottom:1px solid var(--line);font-size:13px}nav a{text-decoration:none}
section{margin-top:45px}h2{font-size:25px;letter-spacing:-.03em;margin:0 0 16px;font-weight:650}h3{font-size:17px;margin:0 0 10px}p{margin:0 0 15px}.muted,.caption{color:var(--muted)}.caption{font-size:12px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:28px 0}.card{border:1px solid var(--line);border-radius:15px;padding:22px;background:#fffef9}.card .metric{font-size:32px;line-height:1.2;letter-spacing:-.04em;margin:12px 0}.card p{font-size:13px;margin:0}.card .label{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.callout{padding:20px 24px;border-left:3px solid var(--green);background:#eaf0e7;border-radius:0 10px 10px 0}.callout p:last-child{margin:0}.figure{border:1px solid var(--line);border-radius:14px;padding:14px;background:var(--paper);margin:20px 0}.figure svg{display:block;width:100%;height:auto}.figure .caption{margin:2px 10px 8px}.downloads{font-size:12px;display:flex;gap:14px;padding:0 10px 5px}
.table-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;font-size:12px;text-align:left;background:#fffef9}th{background:#eaf0e7;font-size:11px;color:var(--muted);font-weight:650;white-space:nowrap}td,th{padding:13px 14px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:0}td:nth-child(n+3){font-variant-numeric:tabular-nums;white-space:nowrap}
.split{display:grid;grid-template-columns:1fr 1fr;gap:30px}ul{padding-left:21px}li{margin:8px 0}pre{background:#18382d;color:#f7f6f0;padding:20px;border-radius:12px;overflow:auto;font-size:12px;line-height:1.8}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}footer{border-top:1px solid var(--line);margin-top:45px;padding-top:20px;color:var(--muted);font-size:12px}
@media(max-width:760px){main{padding:22px 18px 40px}.cards,.split{grid-template-columns:1fr}.cards{gap:10px}.card{padding:18px}h1{font-size:38px}section{margin-top:32px}.figure{padding:4px}td,th{padding:10px}nav{gap:12px}}
@media print{main{padding:0}nav,.downloads{display:none}.card,.figure,.callout{break-inside:avoid}a{color:inherit}section{margin-top:24px}body{font-size:12px}}
"""


def normalize(summary, raw):
    """Schema adapter is kept separate from presentation and charting."""
    if summary.get("schema_version") != 1:
        raise ValueError("Unsupported benchmark summary schema")
    titles = {
        "chat_short": "Chat · short answer", "chat_decode_128": "Chat · fixed 128 tokens",
        "chat_decode_512": "Chat · fixed 512 tokens", "chat_context_2k": "Chat · long input, fresh prefix",
        "chat_context_2k_cached": "Chat · long input, repeated prefix",
        "responses_short": "Responses · short answer", "responses_long": "Responses · long answer",
        "chat_concurrency4": "Chat · 4 concurrent clients",
        "responses_concurrency4": "Responses · 4 concurrent clients",
    }
    workloads = [{**w, "title": titles.get(w["id"], w["id"])} for w in raw["scenarios"]]
    rows = []
    for row in summary["rows"]:
        normalized = {**row, "workload": row["scenario"], "backend": row["service"]}
        for metric in ["latency_ms", "ttft_ms", "wall_tokens_per_second", "batch_goodput_tokens_per_second"]:
            normalized[f"median_{metric}"] = row[metric]["median"]
        rows.append(normalized)
    return {"summary": summary, "raw": raw, "workloads": workloads, "rows": rows}


def token_range(stats):
    if stats["n"] == 0:
        return "—"
    low, high = stats["min"], stats["max"]
    return number(low, 0) if low == high else f"{number(low, 0)}–{number(high, 0)}"


def takeaways(data):
    rows = data["rows"]
    cards, prose = [], []
    for case, label in [("chat_decode_512", "Fixed 512-token Chat"), ("chat_context_2k_cached", "Repeated long-input Chat")]:
        pair = {r["backend"]: r for r in rows if r["workload"] == case}
        if len(pair) != 2 or any(r["median_latency_ms"] is None for r in pair.values()):
            continue
        winner = min(pair, key=lambda key: pair[key]["median_latency_ms"])
        loser = "docker" if winner == "native" else "native"
        fast, slow = pair[winner]["median_latency_ms"], pair[loser]["median_latency_ms"]
        ratio = slow / fast if fast > 0 else 0
        metric = f"{number(ratio, 2)}×"
        title = f"{NAMES[loser]} took {metric} as long"
        detail = (f"Median total: Docker {milliseconds(pair['docker']['median_latency_ms'])}; "
                  f"native {milliseconds(pair['native']['median_latency_ms'])}.")
        if case.startswith("responses"):
            detail += " Natural output lengths can differ."
        if case == "chat_context_2k_cached":
            detail += " Repeated prompt; cache-hit counters are unavailable."
        prose.append(f"**{label}:** {title}. {detail}")
        cards.append({"label": label, "metric": metric, "title": title, "detail": detail})
    attempted, succeeded = sum(r["n"] for r in rows), sum(r["succeeded"] for r in rows)
    cards.append({"label": "Measured request validation", "metric": f"{succeeded}/{attempted}",
                  "title": "Successful measured requests", "detail": f"{attempted-succeeded} errors; warmups excluded. HTTP, stream completion, text, usage and fixed lengths checked."})
    prose.append(f"**Validation:** {succeeded}/{attempted} measured requests passed; {attempted-succeeded} failed. Warmups are excluded.")
    return cards, prose


def render(folder, data):
    summary, raw, rows, workloads = (data[k] for k in ["summary", "raw", "rows", "workloads"])
    settings = summary["settings"]
    names = {w["id"]: w["title"] for w in workloads}
    serial = [w for w in workloads if w["concurrency"] == 1]
    concurrent = [w for w in workloads if w["concurrency"] > 1]
    fixed = [w for w in serial if w.get("fixed_tokens")]
    charts = [chart(folder, "latency", "Total request latency", "Median of successful serial requests · lower is better", serial, rows, "median_latency_ms", "Milliseconds from request start to stream end"),
              chart(folder, "ttft", "Time to first text", "Median of successful serial requests · lower is better", serial, rows, "median_ttft_ms", "Milliseconds from request start to first nonempty text delta"),
              chart(folder, "throughput", "Fixed-output request throughput", "Median server-reported output tokens / full request wall time · higher is better", fixed, rows, "median_wall_tokens_per_second", "Output tokens per second, including time to first text"),
              chart(folder, "batch-goodput", "Concurrent batch goodput", "Successful output tokens / summed batch wall time · higher is better; one active engine sequence", concurrent, rows, "aggregate_goodput_tokens_per_second", "Output tokens per second across the complete batches")]
    charts = [c for c in charts if c]
    serial_headers = ["Workload", "Service", "Passed / total", "Errors", "Median total", "p95 total", "Median TTFT", "Output tokens", "Wall tok/s"]
    serial_rows = [[names[r["workload"]], NAMES[r["backend"]], f"{r['succeeded']}/{r['n']}", r["errors"],
                    milliseconds(r["latency_ms"]["median"]), milliseconds(r["latency_ms"]["p95"]),
                    milliseconds(r["ttft_ms"]["median"]), token_range(r["output_tokens"]),
                    number(r["wall_tokens_per_second"]["median"])] for r in rows if r["concurrency"] == 1]
    batch_headers = ["Workload", "Service", "Passed / total", "Good / all batches", "Median request", "p95 request", "Median TTFT", "Median batch", "Batch tok/s", "Output tokens"]
    batch_rows = [[names[r["workload"]], NAMES[r["backend"]], f"{r['succeeded']}/{r['n']}",
                   f"{r['successful_batches']}/{r['batches']}", milliseconds(r["latency_ms"]["median"]),
                   milliseconds(r["latency_ms"]["p95"]), milliseconds(r["ttft_ms"]["median"]),
                   milliseconds(r["batch_latency_ms"]["median"]), number(r["aggregate_goodput_tokens_per_second"]),
                   token_range(r["output_tokens"])] for r in rows if r["concurrency"] > 1]
    context_headers = ["Workload", "Service", "Input tokens", "Reported cached tokens", "Median TTFT"]
    context_rows = [[names[r["workload"]], NAMES[r["backend"]], token_range(r["prompt_tokens"]),
                    token_range(r["cached_tokens"]), milliseconds(r["ttft_ms"]["median"])]
                   for r in rows if any(w.get("context") and w["id"] == r["workload"] for w in workloads)]
    env_rows = environment_rows(folder, raw)
    runtime_description = "; ".join(
        f"{NAMES[s['id']]} reports {s.get('config', {}).get('body', {}).get('backend', 'an unrecorded runtime')} "
        f"with {s.get('config', {}).get('body', {}).get('responses_mode', 'unrecorded')} Responses mode"
        for s in raw.get("services", []))
    cards, findings = takeaways(data)
    notes = [
        f"{settings['repeats']} measured serial requests per service/workload, following {settings['warmups']} warmups. Concurrent workloads use {settings['batch_repeats']} measured batches after {settings['batch_warmups']} warmup batches. Inspect counts for partial or failed runs.",
        "Both engines remained resident. Services were exercised sequentially, alternating Docker/native order each round. Four-client tests overlap requests only within the selected service; both engines allow one active sequence, so these results include queueing.",
        f"This compares the deployed applications. {runtime_description}. Version, gateway, protocol and cache effects are confounded. These measurements do not isolate Docker overhead.",
        "Fixed-output Chat requests use ignore_eos and exact 128/512-token validation. Natural Chat and Responses requests may stop at different lengths. Compare token counts alongside latency; this is not an answer-quality evaluation.",
        "Fresh-prefix cases receive unique early request tags shared by the paired services. They reduce prefix reuse; they are not cold-start tests. The repeated-prefix case deliberately reuses one prompt. Reported cached-token counters may be absent or differ in semantics across runtimes.",
        "TTFT ends at the first nonempty output-text delta, excluding role and lifecycle events. Total latency ends when the HTTP stream ends. Wall throughput is server-reported output tokens divided by full request duration, not isolated decode speed.",
        "Concurrent batch goodput divides successful output tokens by batch wall time, with failed batch time retained in the aggregate. Per-request rates are never summed. Request quantiles within one batch are dependent samples.",
        "p95 uses nearest rank. With 10 serial samples it is the observed maximum; with five batch samples it is also the maximum. These small samples do not establish statistical significance or stable tail latency. The report describes this run only.",
        "Warmups and invalid requests remain in raw.json. Invalid requests are excluded from per-request latency/rate statistics; the tables expose their counts. No cold startup, energy, GPU utilization or peak-memory benchmark was performed. Thermal snapshots are not continuous monitoring. Other activity on the shared Mac can affect results.",
    ]
    artifacts = [("raw.json", "Raw requests, SSE, responses and warmups"), ("summary.json", "Machine-readable aggregates"), ("summary.csv", "Spreadsheet-ready aggregates")]
    artifacts += [(name, label) for name, label in [("environment-before.json", "Environment before run"), ("environment-after.json", "Environment after run"), ("service-status-after.json", "Follow-up service status; separate from benchmark")]
                  if (folder / name).exists()]
    relative = folder.relative_to(Path(__file__).resolve().parents[1]) if folder.is_relative_to(Path(__file__).resolve().parents[1]) else folder
    command = ("# From the project root; keep other inference idle\n"
               f"BENCH_REPEATS={settings['repeats']} BENCH_WARMUPS={settings['warmups']} \\\n"
               f"BENCH_BATCH_REPEATS={settings['batch_repeats']} BENCH_BATCH_WARMUPS={settings['batch_warmups']} \\\n"
               "  node scripts/benchmark.mjs\n\n"
               "# Render this recorded run again (no new inference)\n"
               "MPLCONFIGDIR=.runtime/matplotlib .runtime/benchmark-tools/bin/python \\\n"
               f"  scripts/benchmark-report.py {relative}")
    stamp = summary["finished_at"] or summary["started_at"]
    subtitle = "Same Qwen3-0.6B 4-bit weights, two deployed Metal services. Client-observed API performance on this Mac."
    status_note = f"Run status: {summary['status']}. Recorded {stamp}. Wall duration {number(summary['wall_runtime_ms']/60000, 1)} minutes."
    md = ["# Docker-managed vs native vLLM Metal benchmark", "", subtitle, "", status_note, "", "## Measured outcomes", "", *["- " + v for v in findings], "",
          "These are observations from this run, not a controlled estimate of Docker overhead or a claim of statistical significance.", "", "## Serial workloads", "", markdown_table(serial_headers, serial_rows), "",
          "Output tokens show the observed minimum–maximum. Wall tok/s and timing columns are medians except the explicitly labeled p95.", ""]
    if batch_rows:
        md += ["## Concurrent workloads", "", markdown_table(batch_headers, batch_rows), "", "Batch tok/s is aggregate goodput over all measured batch wall time. Each batch submits four client requests; one active engine sequence can cause queueing.", ""]
    for c in charts:
        md += [f"## {c['title']}", "", f"![{c['title']}]({c['name']}.png)", "", c["subtitle"] + f". [SVG]({c['name']}.svg).", ""]
    if context_rows:
        md += ["## Context and cache evidence", "", markdown_table(context_headers, context_rows), "", "A missing cached-token counter is shown as —; it is not evidence of zero cache activity.", ""]
    md += ["## Host and deployments", "", markdown_table(["Component", "Recorded configuration"], env_rows), "", "## Method and limits", "", *["- " + v for v in notes], "", "## Evidence and reproduction", "", *[f"- [{label}]({name})" for name, label in artifacts], "", "```sh", command, "```", ""]
    (folder / "REPORT.md").write_text("\n".join(md))
    cards_html = "".join(f'<article class="card"><div class="label">{esc(c["label"])}</div><div class="metric">{esc(c["metric"])}</div><h3>{esc(c["title"])}</h3><p class="muted">{esc(c["detail"])}</p></article>' for c in cards)
    charts_html = ""
    for c in charts:
        svg = (folder / f"{c['name']}.svg").read_text()
        svg = svg[svg.index("<svg"):]
        charts_html += f'<div class="figure" role="img" aria-label="{esc(c["title"])}">{svg}<div class="downloads"><a href="{c["name"]}.png">PNG</a><a href="{c["name"]}.svg">SVG</a></div></div>'
    concurrency_html = f'<section id="concurrency"><h2>Four clients, one active sequence</h2><p class="muted">Batch throughput uses the full batch duration. The request timings below include queueing.</p>{html_table(batch_headers, batch_rows)}</section>' if batch_rows else ""
    context_html = f'<section><h2>Context and cache evidence</h2>{html_table(context_headers, context_rows)}<p class="caption">A missing cached-token counter is shown as —. It does not establish that no cache was used.</p></section>' if context_rows else ""
    document = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qwen3 / Metal · Deployment benchmark</title><style>{CSS}</style></head><body><main>
<header><div class="eyebrow">Local inference / measured comparison</div><h1>Two paths to Metal.<br>One small Qwen model.</h1><p class="lead">{esc(subtitle)}</p><div class="meta"><span>{esc(stamp)}</span><span>Run: {esc(summary['status'])}</span><span>{settings['repeats']} serial samples / workload / service</span><span>Temperature 0 · thinking off</span></div></header>
<nav><a href="#results">Results</a><a href="#charts">Charts</a><a href="#concurrency">Concurrency</a><a href="#method">Method</a><a href="#evidence">Evidence &amp; rerun</a><a href="REPORT.md">Markdown report ↗</a><a href="../../DEPLOYMENT.md">Deployment guide ↗</a></nav>
<div class="cards">{cards_html}</div><div class="callout"><p><strong>Interpret this as a deployment comparison.</strong> The two services use different runtime versions and Responses implementations. These measurements include those differences, gateway paths and cache behavior; they do not isolate Docker overhead.</p></div>
<section id="results"><h2>Serial requests, side by side</h2><p class="muted">Successful measured requests only. Timing and throughput columns are medians unless labeled p95; output tokens show the observed range.</p>{html_table(serial_headers, serial_rows)}<p class="caption">At 10 samples, nearest-rank p95 is the observed maximum. Natural completions may have different output lengths.</p></section>
<section id="charts"><h2>Latency, first text and throughput</h2>{charts_html}</section>{concurrency_html}{context_html}
<section id="method"><h2>How this run was measured</h2><ul>{''.join('<li>'+esc(n)+'</li>' for n in notes)}</ul></section>
<section><h2>Host and deployment context</h2>{html_table(['Component', 'Recorded configuration'], env_rows)}</section>
<section id="evidence"><h2>Inspect the evidence. Repeat the run.</h2><p class="muted">Raw requests, output text, stream events and warmups are retained. This page is self-contained and requires no external assets or network connection.</p><ul>{''.join(f'<li><a href="{name}">{esc(label)}</a></li>' for name,label in artifacts)}</ul><pre><code>{esc(command)}</code></pre></section>
<footer>{esc(status_note)} Generated from summary.json and raw.json. Charts are available as PNG and editable SVG.</footer></main></body></html>'''
    (folder / "report.html").write_text(document)
    print(json.dumps({"report": str(folder / "report.html"), "markdown": str(folder / "REPORT.md"), "charts": [c["name"] for c in charts], "status": summary["status"]}))


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: benchmark-report.py docs/benchmarks/<run-folder>")
    folder = Path(sys.argv[1]).resolve()
    summary = load_json(folder / "summary.json")
    data = normalize(summary, load_json(folder / "raw.json"))
    render(folder, data)


if __name__ == "__main__":
    main()
