import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STATS_SCHEMA_VERSION = 1;
export const TPS_HISTOGRAM_BUCKETS = 14;
export const QUOTA_COST_HISTOGRAM_EDGES = [
  0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0,
] as const;
export const QUOTA_COST_HISTOGRAM_BUCKETS = QUOTA_COST_HISTOGRAM_EDGES.length + 1;

export interface StatsWindow {
  start: string;
  end: string;
  duration_secs: number;
}

export interface UsageByPlanModel {
  plan_tier: string;
  model: string;
  effort: string;
  events: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reference_cost_usd: number;
}

export interface TpsByModelEffort {
  model: string;
  effort: string;
  sample_count: number;
  output_tokens: number;
  elapsed_ms: number;
  histogram: number[];
}

export interface QuotaByPlanBucketModel {
  plan_tier: string;
  bucket: string;
  attributed_model: string;
  attributed_effort: string;
  slices: number;
  delta_quota_fraction: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reference_cost_usd: number;
  cost_per_pct_histogram?: number[];
}

export interface StatsReport {
  schema_version: number;
  scope: "local" | "aggregated";
  window: StatsWindow;
  contributors: number;
  usage_by_plan_model: UsageByPlanModel[];
  tps_by_model_effort: TpsByModelEffort[];
  quota_by_plan_bucket_model: QuotaByPlanBucketModel[];
}

export interface ExportedHour {
  hour_bucket: string;
  submission_count: number;
  aggregated_at: string;
  report: StatsReport;
}

export interface DataManifest {
  updated_at: string;
  last_hour: string | null;
  last_sync_at?: string;
  available_hours: string[];
  rolling: {
    "24h": string;
    "7d": string;
    "30d": string;
  };
}

export interface SyncOptions {
  dataDir: string;
  baseUrl?: string;
  statsUrl?: string;
  apiToken?: string;
  now?: Date;
  fetcher?: (url: string, token: string) => Promise<ExportedHour[]>;
  githubOutputPath?: string;
}

export function resolveStatsUrl(baseUrl?: string, statsUrl?: string): string | undefined {
  const explicit = statsUrl?.trim();
  if (explicit) return explicit;
  const trimmedBase = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmedBase) return undefined;
  return trimmedBase.endsWith("/api/telemetry/stats")
    ? trimmedBase
    : `${trimmedBase}/api/telemetry/stats`;
}

const HOUR_RETENTION_DAYS = 90;
const RAW_RETENTION_DAYS = 3;
const EXPORT_PAGE_LIMIT = 720;
const MAX_EXPORT_PAGES = 50;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function quotaCostBucketIndex(deltaQuotaFraction: number, refCostUsd: number): number | null {
  if (
    !(deltaQuotaFraction > 0) ||
    !Number.isFinite(deltaQuotaFraction) ||
    !(refCostUsd >= 0) ||
    !Number.isFinite(refCostUsd)
  ) {
    return null;
  }
  const costPerPct = refCostUsd / (deltaQuotaFraction * 100);
  if (!Number.isFinite(costPerPct) || costPerPct < 0) return null;
  for (let i = 0; i < QUOTA_COST_HISTOGRAM_EDGES.length; i++) {
    if (costPerPct < QUOTA_COST_HISTOGRAM_EDGES[i]) return i;
  }
  return QUOTA_COST_HISTOGRAM_BUCKETS - 1;
}

function normalizeQuotaCostHistogram(q: QuotaByPlanBucketModel): number[] {
  if (
    Array.isArray(q.cost_per_pct_histogram) &&
    q.cost_per_pct_histogram.length === QUOTA_COST_HISTOGRAM_BUCKETS
  ) {
    return q.cost_per_pct_histogram.map((v) => Math.max(0, Math.trunc(v)));
  }
  const hist = new Array<number>(QUOTA_COST_HISTOGRAM_BUCKETS).fill(0);
  const idx = quotaCostBucketIndex(q.delta_quota_fraction, q.reference_cost_usd);
  if (idx !== null && q.slices > 0) {
    hist[idx] = Math.trunc(q.slices);
  }
  return hist;
}

export function mergeReports(
  reports: StatsReport[],
  scope: "local" | "aggregated",
  overrideWindow?: StatsWindow,
  contributorsOverride?: number,
): StatsReport {
  if (reports.length === 0) {
    return {
      schema_version: STATS_SCHEMA_VERSION,
      scope,
      window: overrideWindow ?? { start: "", end: "", duration_secs: 0 },
      contributors: contributorsOverride ?? 0,
      usage_by_plan_model: [],
      tps_by_model_effort: [],
      quota_by_plan_bucket_model: [],
    };
  }

  let minStart = reports[0].window.start;
  let maxEnd = reports[0].window.end;
  let sumContributors = 0;

  const usageMap = new Map<string, UsageByPlanModel>();
  const tpsMap = new Map<string, TpsByModelEffort>();
  const quotaMap = new Map<string, QuotaByPlanBucketModel>();

  for (const report of reports) {
    if (report.window.start && (!minStart || report.window.start < minStart)) {
      minStart = report.window.start;
    }
    if (report.window.end > maxEnd) {
      maxEnd = report.window.end;
    }
    sumContributors += report.contributors || 0;

    for (const u of report.usage_by_plan_model) {
      const key = `${u.plan_tier}\u0000${u.model}\u0000${u.effort}`;
      const existing = usageMap.get(key);
      if (!existing) {
        usageMap.set(key, { ...u });
      } else {
        existing.events += u.events;
        existing.input_tokens += u.input_tokens;
        existing.cache_read_tokens += u.cache_read_tokens;
        existing.cache_write_tokens += u.cache_write_tokens;
        existing.output_tokens += u.output_tokens;
        existing.reference_cost_usd += u.reference_cost_usd;
      }
    }

    for (const t of report.tps_by_model_effort) {
      const key = `${t.model}\u0000${t.effort}`;
      const existing = tpsMap.get(key);
      if (!existing) {
        tpsMap.set(key, {
          ...t,
          histogram: Array.from({ length: TPS_HISTOGRAM_BUCKETS }, (_, i) => t.histogram[i] ?? 0),
        });
      } else {
        existing.sample_count += t.sample_count;
        existing.output_tokens += t.output_tokens;
        existing.elapsed_ms += t.elapsed_ms;
        for (let i = 0; i < TPS_HISTOGRAM_BUCKETS; i++) {
          existing.histogram[i] += t.histogram[i] ?? 0;
        }
      }
    }

    for (const q of report.quota_by_plan_bucket_model) {
      const key = `${q.plan_tier}\u0000${q.bucket}\u0000${q.attributed_model}\u0000${q.attributed_effort}`;
      const existing = quotaMap.get(key);
      const qHist = normalizeQuotaCostHistogram(q);
      if (!existing) {
        quotaMap.set(key, {
          ...q,
          cost_per_pct_histogram: [...qHist],
        });
      } else {
        existing.slices += q.slices;
        existing.delta_quota_fraction += q.delta_quota_fraction;
        existing.input_tokens += q.input_tokens;
        existing.cache_read_tokens += q.cache_read_tokens;
        existing.cache_write_tokens += q.cache_write_tokens;
        existing.output_tokens += q.output_tokens;
        existing.reference_cost_usd += q.reference_cost_usd;
        const existHist = normalizeQuotaCostHistogram(existing);
        for (let i = 0; i < QUOTA_COST_HISTOGRAM_BUCKETS; i++) {
          existHist[i] += qHist[i];
        }
        existing.cost_per_pct_histogram = existHist;
      }
    }
  }

  const usageSorted = Array.from(usageMap.values()).sort(
    (a, b) =>
      compareStrings(a.plan_tier, b.plan_tier) ||
      compareStrings(a.model, b.model) ||
      compareStrings(a.effort, b.effort),
  );
  const tpsSorted = Array.from(tpsMap.values()).sort(
    (a, b) => compareStrings(a.model, b.model) || compareStrings(a.effort, b.effort),
  );
  const quotaSorted = Array.from(quotaMap.values()).sort(
    (a, b) =>
      compareStrings(a.plan_tier, b.plan_tier) ||
      compareStrings(a.bucket, b.bucket) ||
      compareStrings(a.attributed_model, b.attributed_model) ||
      compareStrings(a.attributed_effort, b.attributed_effort),
  );

  return {
    schema_version: STATS_SCHEMA_VERSION,
    scope,
    window: overrideWindow ?? {
      start: minStart,
      end: maxEnd,
      duration_secs: 0,
    },
    contributors: contributorsOverride ?? sumContributors,
    usage_by_plan_model: usageSorted,
    tps_by_model_effort: tpsSorted,
    quota_by_plan_bucket_model: quotaSorted,
  };
}

function hourFilename(hourBucket: string): string {
  // "2026-11-14T15:00:00Z" -> "2026-11-14T15Z.json"
  return `${hourBucket.slice(0, 13)}Z.json`;
}

function filenameToHourIso(filename: string): string | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2})Z\.json$/);
  return m ? `${m[1]}:00:00Z` : null;
}

async function defaultFetcher(url: string, token: string): Promise<ExportedHour[]> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Export request failed with HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { ok: boolean; hours?: ExportedHour[]; error?: string };
  if (!body.ok || !Array.isArray(body.hours)) {
    throw new Error(`Unexpected export payload: ${body.error ?? "missing hours array"}`);
  }
  return body.hours;
}

function buildRolling(
  hourlyEntries: Array<{ hourIso: string; report: StatsReport }>,
  hoursBack: number,
  nowDate: Date,
): StatsReport {
  const alignedEnd = new Date(nowDate.getTime());
  alignedEnd.setUTCMinutes(0, 0, 0);
  const endMs = alignedEnd.getTime();
  const startMs = endMs - hoursBack * 3_600_000;
  const startIso = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const endIso = alignedEnd.toISOString().replace(/\.\d{3}Z$/, "Z");
  const selected = hourlyEntries
    .filter((e) => {
      const ms = Date.parse(e.hourIso);
      return Number.isFinite(ms) && ms >= startMs && ms < endMs;
    })
    .map((e) => e.report);

  const maxContributors = selected.reduce((m, r) => Math.max(m, r.contributors || 0), 0);
  return mergeReports(
    selected,
    "aggregated",
    {
      start: startIso,
      end: endIso,
      duration_secs: hoursBack * 3600,
    },
    maxContributors,
  );
}

export async function syncTelemetryData(opts: SyncOptions): Promise<{ changed: boolean; imported: number }> {
  const hourlyDir = join(opts.dataDir, "hourly");
  const rollingDir = join(opts.dataDir, "rolling");
  const manifestPath = join(opts.dataDir, "manifest.json");
  mkdirSync(hourlyDir, { recursive: true });
  mkdirSync(rollingDir, { recursive: true });

  const now = opts.now ?? new Date();
  const hadManifest = existsSync(manifestPath);
  let lastHour = "";
  let lastSyncAt = "";
  if (hadManifest) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, "utf8")) as DataManifest;
      lastHour = existing.last_hour ?? "";
      lastSyncAt = existing.last_sync_at ?? existing.updated_at ?? "";
    } catch {
      lastHour = "";
      lastSyncAt = "";
    }
  }

  const resolvedStatsUrl = resolveStatsUrl(opts.baseUrl, opts.statsUrl);
  const fetchedHours: ExportedHour[] = [];
  if (resolvedStatsUrl && opts.apiToken) {
    const fetchFn = opts.fetcher ?? defaultFetcher;
    let pageAfter = lastHour;
    let includeUpdatedAfter = Boolean(lastSyncAt);
    for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
      const u = new URL(resolvedStatsUrl);
      u.searchParams.set("granularity", "hourly");
      if (pageAfter) u.searchParams.set("after", pageAfter);
      if (includeUpdatedAfter && lastSyncAt) u.searchParams.set("updated_after", lastSyncAt);
      u.searchParams.set("limit", String(EXPORT_PAGE_LIMIT));

      const batch = await fetchFn(u.toString(), opts.apiToken);
      fetchedHours.push(...batch);
      if (batch.length < EXPORT_PAGE_LIMIT) break;

      const lastCursor = batch[batch.length - 1]?.hour_bucket ?? "";
      if (!lastCursor || (pageAfter && lastCursor <= pageAfter)) break;
      pageAfter = lastCursor;
      includeUpdatedAfter = false;
    }
  }

  const rawRetentionCutoffMs = now.getTime() - RAW_RETENTION_DAYS * 86_400_000;
  let latestAggregatedAt = lastSyncAt;
  let imported = 0;
  for (const item of fetchedHours) {
    if (item.aggregated_at && item.aggregated_at > latestAggregatedAt) {
      latestAggregatedAt = item.aggregated_at;
    }
    const file = join(hourlyDir, hourFilename(item.hour_bucket));
    const itemMs = Date.parse(item.hour_bucket);
    const alreadyExists = existsSync(file);
    // Once an hour falls outside the 3-day raw D1 window, treat its exported snapshot as frozen.
    if (alreadyExists && Number.isFinite(itemMs) && itemMs < rawRetentionCutoffMs) {
      continue;
    }
    const serialized = `${JSON.stringify(item.report, null, 2)}\n`;
    const prev = alreadyExists ? readFileSync(file, "utf8") : null;
    if (prev !== serialized) {
      writeFileSync(file, serialized, "utf8");
      imported += 1;
    }
  }

  const allHourlyFiles = readdirSync(hourlyDir)
    .map((name) => ({ name, hourIso: filenameToHourIso(name) }))
    .filter((entry): entry is { name: string; hourIso: string } => entry.hourIso !== null)
    .sort((a, b) => (a.hourIso < b.hourIso ? -1 : a.hourIso > b.hourIso ? 1 : 0));

  const cutoffMs = now.getTime() - HOUR_RETENTION_DAYS * 86_400_000;
  const retainedEntries: Array<{ name: string; hourIso: string }> = [];
  let pruned = 0;
  for (const entry of allHourlyFiles) {
    const ms = Date.parse(entry.hourIso);
    if (!Number.isFinite(ms) || ms < cutoffMs) {
      unlinkSync(join(hourlyDir, entry.name));
      pruned += 1;
      continue;
    }
    retainedEntries.push(entry);
  }

  const changed = !hadManifest || imported > 0 || pruned > 0;
  if (!changed) {
    if (opts.githubOutputPath) {
      appendFileSync(opts.githubOutputPath, "changed=false\nimported=0\n");
    }
    return { changed: false, imported: 0 };
  }

  const loadedHours: Array<{ relPath: string; hourIso: string; report: StatsReport }> = [];
  for (const entry of retainedEntries) {
    const report = JSON.parse(readFileSync(join(hourlyDir, entry.name), "utf8")) as StatsReport;
    loadedHours.push({
      relPath: `./data/hourly/${entry.name}`,
      hourIso: entry.hourIso,
      report,
    });
  }

  const r24 = buildRolling(loadedHours, 24, now);
  const r7d = buildRolling(loadedHours, 24 * 7, now);
  const r30d = buildRolling(loadedHours, 24 * 30, now);

  writeFileSync(join(rollingDir, "24h.json"), `${JSON.stringify(r24, null, 2)}\n`, "utf8");
  writeFileSync(join(rollingDir, "7d.json"), `${JSON.stringify(r7d, null, 2)}\n`, "utf8");
  writeFileSync(join(rollingDir, "30d.json"), `${JSON.stringify(r30d, null, 2)}\n`, "utf8");

  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest: DataManifest = {
    updated_at: nowIso,
    last_hour: loadedHours.length > 0 ? loadedHours[loadedHours.length - 1].hourIso : null,
    last_sync_at: latestAggregatedAt || nowIso,
    available_hours: loadedHours.map((h) => h.relPath),
    rolling: {
      "24h": "./data/rolling/24h.json",
      "7d": "./data/rolling/7d.json",
      "30d": "./data/rolling/30d.json",
    },
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (opts.githubOutputPath) {
    appendFileSync(opts.githubOutputPath, `changed=true\nimported=${imported}\n`);
  }

  return { changed: true, imported };
}

if (import.meta.main) {
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  const baseUrl = process.env.TELEMETRY_BASE_URL;
  const statsUrl = resolveStatsUrl(baseUrl, process.env.TELEMETRY_STATS_URL);
  const apiToken = process.env.TELEMETRY_API_TOKEN;
  const githubOutputPath = process.env.GITHUB_OUTPUT;

  const result = await syncTelemetryData({
    dataDir,
    baseUrl,
    statsUrl,
    apiToken,
    githubOutputPath,
  });
  console.log(JSON.stringify(result));
}
