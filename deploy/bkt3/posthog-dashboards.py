#!/usr/bin/env python3
"""Create the bkt3 product-metrics dashboards and alerts in PostHog (TEC-1631).

Reads POSTHOG_PERSONAL_API_KEY and POSTHOG_HOST from the environment
(source ~/.config/posthog/dev-server-1.env) and POSTHOG_PROJECT_ID
(source ~/.t3/nextbkt3-dev/posthog.env). Idempotent: a dashboard that
already exists is left alone unless --replace is given.

  python3 deploy/bkt3/posthog-dashboards.py --check    # run every query once
  python3 deploy/bkt3/posthog-dashboards.py            # create what is missing
  python3 deploy/bkt3/posthog-dashboards.py --replace  # delete and recreate

Every query filters on the `instance` property, so other apps that share the
PostHog project do not leak into these numbers.
"""

import json
import os
import sys
import urllib.error
import urllib.request

INSTANCE = os.environ.get("T3CODE_ANALYTICS_INSTANCE", "bkt3")
F = f"properties.instance = '{INSTANCE}'"
TZ = "Asia/Kolkata"
DAYS = 90

# Time in each state comes from session.state.span. Spans are split at UTC
# midnight, so summing durationMs per day is exact.
SPAN = f"event = 'session.state.span' AND {F} AND timestamp > now() - INTERVAL {DAYS} DAY"


def table(sql):
    return {"display": "ActionsTable", "sql": sql}


def line(sql):
    return {"display": "ActionsLineGraph", "sql": sql}


def bar(sql):
    return {"display": "ActionsStackedBar", "sql": sql}


DASHBOARDS = {
    "bkt3 · Usage": {
        "Daily active people": line(f"""
            SELECT toDate(timestamp) AS day, count(DISTINCT distinct_id) AS people
            FROM events
            WHERE {F} AND timestamp > now() - INTERVAL {DAYS} DAY
              AND event IN ('session.created', 'run.finished', 'composer.sent',
                            'human_request.resolved', 'app.opened')
              AND distinct_id LIKE '%@%'
            GROUP BY day ORDER BY day"""),
        "Sessions created per day, by person": bar(f"""
            SELECT toDate(timestamp) AS day, distinct_id AS person, count() AS sessions
            FROM events
            WHERE event = 'session.created' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, person ORDER BY day"""),
        "Runs per day, by provider": bar(f"""
            SELECT toDate(timestamp) AS day, properties.providerInstanceId AS provider,
                   count() AS runs
            FROM events
            WHERE event = 'run.finished' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, provider ORDER BY day"""),
        "Runs by hour of day (IST) and weekday, last 30 days": table(f"""
            SELECT toDayOfWeek(toTimeZone(timestamp, '{TZ}')) AS weekday,
                   toHour(toTimeZone(timestamp, '{TZ}')) AS hour_ist, count() AS runs
            FROM events
            WHERE event = 'run.finished' AND {F}
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY weekday, hour_ist ORDER BY weekday, hour_ist"""),
        "Sessions by source per day": bar(f"""
            SELECT toDate(timestamp) AS day, properties.sessionSource AS source,
                   count() AS sessions
            FROM events
            WHERE event = 'session.created' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, source ORDER BY day"""),
        "Client surfaces opened per day": bar(f"""
            SELECT toDate(timestamp) AS day, properties.surface AS surface, count() AS opens
            FROM events
            WHERE event = 'app.opened' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, surface ORDER BY day"""),
    },
    "bkt3 · Session time": {
        "Hours per state per day": bar(f"""
            SELECT toDate(timestamp) AS day,
                   if(properties.state = 'waiting_human',
                      concat('waiting_human:', toString(properties.waitKind)),
                      toString(properties.state)) AS state,
                   round(sum(toFloat(properties.durationMs)) / 3600000, 1) AS hours
            FROM events
            WHERE {SPAN} AND properties.state NOT IN ('idle', 'archived')
            GROUP BY day, state ORDER BY day"""),
        "Agent running hours per person per day": bar(f"""
            SELECT toDate(timestamp) AS day, distinct_id AS person,
                   round(sum(toFloat(properties.durationMs)) / 3600000, 1) AS hours
            FROM events
            WHERE {SPAN} AND properties.state = 'agent_running'
            GROUP BY day, person ORDER BY day"""),
        "Time waiting on a person, by person and kind (last 30 days)": table(f"""
            SELECT distinct_id AS person, properties.waitKind AS kind,
                   round(sum(toFloat(properties.durationMs)) / 3600000, 1) AS hours,
                   count() AS waits
            FROM events
            WHERE {SPAN} AND properties.state = 'waiting_human'
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY person, kind ORDER BY hours DESC"""),
        "Time waiting on background workers per day": line(f"""
            SELECT toDate(timestamp) AS day,
                   round(sum(toFloat(properties.durationMs)) / 3600000, 1) AS hours
            FROM events
            WHERE {SPAN} AND properties.state = 'waiting_workers'
            GROUP BY day ORDER BY day"""),
        "Person answer time (minutes), last 30 days": table(f"""
            SELECT coalesce(properties.answeredByUserId, distinct_id) AS person,
                   properties.requestKind AS kind, count() AS answered,
                   round(quantile(0.5)(toFloat(properties.waitMs)) / 60000, 1) AS p50_min,
                   round(quantile(0.9)(toFloat(properties.waitMs)) / 60000, 1) AS p90_min
            FROM events
            WHERE event = 'human_request.resolved' AND {F}
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY person, kind ORDER BY answered DESC"""),
        "Share of active time by state, per person (last 30 days)": table(f"""
            SELECT distinct_id AS person,
                   round(sumIf(toFloat(properties.durationMs), properties.state = 'agent_running') / 3600000, 1) AS running_h,
                   round(sumIf(toFloat(properties.durationMs), properties.state = 'waiting_human') / 3600000, 1) AS waiting_human_h,
                   round(sumIf(toFloat(properties.durationMs), properties.state = 'waiting_workers') / 3600000, 1) AS waiting_workers_h,
                   round(sumIf(toFloat(properties.durationMs), properties.state = 'queued') / 3600000, 2) AS queued_h
            FROM events
            WHERE {SPAN} AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY person ORDER BY running_h DESC"""),
    },
    "bkt3 · Agent quality": {
        "Run outcome per day": bar(f"""
            SELECT toDate(timestamp) AS day, properties.status AS status, count() AS runs
            FROM events
            WHERE event = 'run.finished' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, status ORDER BY day"""),
        "Run time and failure rate by model (last 30 days)": table(f"""
            SELECT properties.model AS model, count() AS runs,
                   round(quantile(0.5)(toFloat(properties.runDurationMs)) / 60000, 1) AS p50_min,
                   round(quantile(0.95)(toFloat(properties.runDurationMs)) / 60000, 1) AS p95_min,
                   round(100 * countIf(properties.status = 'failed') / count(), 1) AS failed_pct,
                   round(100 * countIf(properties.status = 'interrupted') / count(), 1) AS interrupted_pct
            FROM events
            WHERE event = 'run.finished' AND {F}
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY model ORDER BY runs DESC"""),
        "Failure classes (last 30 days)": table(f"""
            SELECT properties.failureClass AS failure, properties.providerInstanceId AS provider,
                   count() AS runs
            FROM events
            WHERE event = 'run.finished' AND properties.status = 'failed' AND {F}
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY failure, provider ORDER BY runs DESC"""),
        "Queue wait p95 (seconds) per day": line(f"""
            SELECT toDate(timestamp) AS day,
                   round(quantile(0.95)(toFloat(properties.queueWaitMs)) / 1000, 1) AS p95_s
            FROM events
            WHERE event = 'run.finished' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day ORDER BY day"""),
        "Session recoveries per day": bar(f"""
            SELECT toDate(timestamp) AS day, properties.outcome AS outcome, count() AS recoveries
            FROM events
            WHERE event = 'session.recovery.finished' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, outcome ORDER BY day"""),
        "Subagents per day, by status": bar(f"""
            SELECT toDate(timestamp) AS day, properties.status AS status, count() AS subagents
            FROM events
            WHERE event = 'subagent.finished' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, status ORDER BY day"""),
    },
    "bkt3 · Load": {
        "Peak concurrent sessions per hour, by state": line(f"""
            SELECT toStartOfHour(timestamp) AS hour,
                   max(toFloat(properties.runningRuns)) AS running,
                   max(toFloat(properties.waitingHuman)) AS waiting_human,
                   max(toFloat(properties.waitingWorkers)) AS waiting_workers,
                   max(toFloat(properties.queuedRuns)) AS queued,
                   max(toFloat(properties.activeSubagents)) AS subagents
            FROM events
            WHERE event = 'session.state.snapshot' AND properties.scope = 'total' AND {F}
              AND timestamp > now() - INTERVAL 14 DAY
            GROUP BY hour ORDER BY hour"""),
        "Peak running sessions per person per day": table(f"""
            SELECT toDate(timestamp) AS day, distinct_id AS person,
                   max(toFloat(properties.count)) AS peak_running
            FROM events
            WHERE event = 'session.state.snapshot' AND properties.scope = 'user'
              AND properties.state = 'agent_running' AND {F}
              AND timestamp > now() - INTERVAL 14 DAY
            GROUP BY day, person ORDER BY day DESC, peak_running DESC"""),
        "Connected clients per day, by connection mode": bar(f"""
            SELECT toDate(timestamp) AS day, properties.connectionMode AS mode, count() AS connects
            FROM events
            WHERE event = 'client.connected' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, mode ORDER BY day"""),
    },
    "bkt3 · Automation": {
        "MCP tool calls (last 30 days)": table(f"""
            SELECT properties.toolName AS tool, properties.callerKind AS caller, count() AS calls,
                   round(100 * countIf(properties.ok = false) / count(), 1) AS error_pct,
                   round(quantile(0.95)(toFloat(properties.durationMs))) AS p95_ms
            FROM events
            WHERE event = 'mcp.tool.called' AND {F}
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY tool, caller ORDER BY calls DESC LIMIT 50"""),
        "Scheduled task runs per day, by status": bar(f"""
            SELECT toDate(timestamp) AS day, properties.status AS status, count() AS runs
            FROM events
            WHERE event = 'scheduled_task.ran' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, status ORDER BY day"""),
        "Webhook deliveries per day": bar(f"""
            SELECT toDate(timestamp) AS day, properties.kind AS kind, properties.status AS status,
                   count() AS deliveries
            FROM events
            WHERE event = 'webhook.delivered' AND {F}
              AND timestamp > now() - INTERVAL {DAYS} DAY
            GROUP BY day, kind, status ORDER BY day"""),
        "Plans: decisions and wait (last 30 days)": table(f"""
            SELECT properties.decision AS decision, count() AS plans,
                   round(quantile(0.5)(toFloat(properties.waitMs)) / 60000, 1) AS p50_wait_min
            FROM events
            WHERE event = 'plan.decided' AND {F}
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY decision ORDER BY plans DESC"""),
        "Top client views (last 30 days)": table(f"""
            SELECT properties.view AS view, count() AS views, count(DISTINCT distinct_id) AS people
            FROM events
            WHERE event = 'view.changed' AND {F}
              AND timestamp > now() - INTERVAL 30 DAY
            GROUP BY view ORDER BY views DESC LIMIT 30"""),
    },
}

# Alerts need a trends insight. Thresholds come from 30 days of history:
# a normal day has under 40 failed runs; the server sends a snapshot every 5 min.
ALERTS = [
    {
        "insight": "Alert · server snapshots per hour",
        "event": "session.state.snapshot",
        "interval": "hour",
        "properties": [{"key": "scope", "value": ["total"], "operator": "exact", "type": "event"}],
        "alert": "bkt3 server stopped sending metrics",
        "bounds": {"lower": 1},
        "calculation_interval": "hourly",
    },
    {
        "insight": "Alert · failed runs per day",
        "event": "run.finished",
        "interval": "day",
        "properties": [{"key": "status", "value": ["failed"], "operator": "exact", "type": "event"}],
        "alert": "bkt3 failed runs above 40 in a day",
        "bounds": {"upper": 40},
        "calculation_interval": "daily",
    },
]


def api(method, path, body=None):
    host = os.environ["POSTHOG_HOST"].rstrip("/")
    req = urllib.request.Request(
        f"{host}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {os.environ['POSTHOG_PERSONAL_API_KEY']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        raise SystemExit(f"{method} {path} -> {err.code}: {err.read().decode()[:500]}")


def hogql(sql):
    return {
        "kind": "DataVisualizationNode",
        "source": {"kind": "HogQLQuery", "query": " ".join(sql.split())},
    }


def main():
    pid = os.environ["POSTHOG_PROJECT_ID"]
    base = f"/api/projects/{pid}"
    args = set(sys.argv[1:])

    if "--check" in args:
        for dash, insights in DASHBOARDS.items():
            for name, spec in insights.items():
                res = api("POST", f"{base}/query/", {"query": hogql(spec["sql"])["source"]})
                print(f"ok  {dash} / {name}: {len(res.get('results') or [])} rows")
        return

    existing = {d["name"]: d for d in api("GET", f"{base}/dashboards/?limit=200")["results"]}
    for dash, insights in DASHBOARDS.items():
        if dash in existing:
            if "--replace" not in args:
                print(f"skip {dash} (exists, id {existing[dash]['id']})")
                continue
            api("PATCH", f"{base}/dashboards/{existing[dash]['id']}/", {"deleted": True})
        d = api("POST", f"{base}/dashboards/", {"name": dash, "description": "TEC-1631 bkt3 product metrics"})
        for name, spec in insights.items():
            query = hogql(spec["sql"])
            query["display"] = spec["display"]
            api("POST", f"{base}/insights/", {"name": name, "query": query, "dashboards": [d["id"]]})
        print(f"made {dash} -> {os.environ['POSTHOG_HOST'].rstrip('/')}/project/{pid}/dashboard/{d['id']}")

    me = api("GET", "/api/users/@me/")
    alerts = {a["name"] for a in (api("GET", f"{base}/alerts/") or {}).get("results", [])}
    for spec in ALERTS:
        if spec["alert"] in alerts:
            print(f"skip alert {spec['alert']} (exists)")
            continue
        insight = api("POST", f"{base}/insights/", {
            "name": spec["insight"],
            "query": {
                "kind": "InsightVizNode",
                "source": {
                    "kind": "TrendsQuery",
                    "series": [{"kind": "EventsNode", "event": spec["event"], "math": "total"}],
                    "interval": spec["interval"],
                    "dateRange": {"date_from": "-7d"},
                    "properties": [{"key": "instance", "value": [INSTANCE], "operator": "exact", "type": "event"}]
                    + spec["properties"],
                },
            },
        })
        api("POST", f"{base}/alerts/", {
            "name": spec["alert"],
            "insight": insight["id"],
            "subscribed_users": [me["id"]],
            "threshold": {"configuration": {"type": "absolute", "bounds": spec["bounds"]}},
            "condition": {"type": "absolute_value"},
            "config": {"type": "TrendsAlertConfig", "series_index": 0},
            "calculation_interval": spec["calculation_interval"],
            "enabled": True,
        })
        print(f"made alert {spec['alert']}")


if __name__ == "__main__":
    main()
