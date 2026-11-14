import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DataManifest, ExportedHour, StatsReport, syncTelemetryData } from "./sync";

function makeHour(hourIso: string, endIso: string, events: number): ExportedHour {
  return {
    hour_bucket: hourIso,
    submission_count: 1,
    aggregated_at: endIso,
    report: {
      schema_version: 1,
      scope: "aggregated",
      window: { start: hourIso, end: endIso, duration_secs: 3600 },
      contributors: 3,
      usage_by_plan_model: [
        {
          plan_tier: "Google AI Ultra",
          model: "Claude Opus 4.6",
          effort: "high",
          events,
          input_tokens: 1000,
          cache_read_tokens: 5000,
          cache_write_tokens: 0,
          output_tokens: 400,
          reference_cost_usd: 0.02,
        },
      ],
      tps_by_model_effort: [],
      quota_by_plan_bucket_model: [],
    },
  };
}

describe("antigravity-status-telemetry-data sync script", () => {
  test("imports new hours, builds rolling windows, and skips unchanged runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-data-sync-"));
    try {
      const now = new Date("2026-11-15T01:08:00Z");
      const first = await syncTelemetryData({
        dataDir: dir,
        statsUrl: "https://worker.example/api/telemetry/stats",
        apiToken: "secret",
        now,
        fetcher: async (url) => {
          expect(url).toContain("granularity=hourly");
          return [
            makeHour("2026-11-14T23:00:00Z", "2026-11-15T00:00:00Z", 5),
            makeHour("2026-11-15T00:00:00Z", "2026-11-15T01:00:00Z", 7),
          ];
        },
      });
      expect(first).toEqual({ changed: true, imported: 2 });

      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as DataManifest;
      expect(manifest.last_hour).toBe("2026-11-15T00:00:00Z");
      expect(manifest.available_hours).toEqual([
        "./data/hourly/2026-11-14T23Z.json",
        "./data/hourly/2026-11-15T00Z.json",
      ]);

      const rolling24 = JSON.parse(readFileSync(join(dir, "rolling", "24h.json"), "utf8")) as StatsReport;
      expect(rolling24.window.start).toBe("2026-11-14T01:00:00Z");
      expect(rolling24.window.end).toBe("2026-11-15T01:00:00Z");
      expect(rolling24.usage_by_plan_model[0].events).toBe(12);

      // Re-running with no new hours skips commit/deploy cleanly.
      const second = await syncTelemetryData({
        dataDir: dir,
        statsUrl: "https://worker.example/api/telemetry/stats",
        apiToken: "secret",
        now: new Date("2026-11-15T02:08:00Z"),
        fetcher: async () => [],
      });
      expect(second).toEqual({ changed: false, imported: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-syncs late updates within 3 days via updated_after while leaving >3d files frozen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-data-late-"));
    try {
      const oldHour = "2026-11-11T10:00:00Z";
      const oldFile = join(dir, "hourly", "2026-11-11T10Z.json");
      mkdirSync(join(dir, "hourly"), { recursive: true });
      writeFileSync(oldFile, `${JSON.stringify(makeHour(oldHour, "2026-11-11T11:00:00Z", 99).report, null, 2)}\n`);

      const first = await syncTelemetryData({
        dataDir: dir,
        statsUrl: "https://worker.example/api/telemetry/stats",
        apiToken: "secret",
        now: new Date("2026-11-15T01:08:00Z"),
        fetcher: async () => [makeHour("2026-11-15T00:00:00Z", "2026-11-15T01:08:00Z", 5)],
      });
      expect(first).toEqual({ changed: true, imported: 1 });

      const lateUpdate = await syncTelemetryData({
        dataDir: dir,
        statsUrl: "https://worker.example/api/telemetry/stats",
        apiToken: "secret",
        now: new Date("2026-11-15T02:08:00Z"),
        fetcher: async (url) => {
          expect(url).toContain("after=2026-11-15T00%3A00%3A00Z");
          expect(url).toContain("updated_after=2026-11-15T01%3A08%3A00Z");
          return [
            makeHour(oldHour, "2026-11-15T02:08:00Z", 123),
            makeHour("2026-11-15T00:00:00Z", "2026-11-15T02:08:00Z", 8),
          ];
        },
      });
      expect(lateUpdate).toEqual({ changed: true, imported: 1 });

      const updatedHour = JSON.parse(readFileSync(join(dir, "hourly", "2026-11-15T00Z.json"), "utf8")) as StatsReport;
      expect(updatedHour.usage_by_plan_model[0].events).toBe(8);

      const frozenOld = JSON.parse(readFileSync(oldFile, "utf8")) as StatsReport;
      expect(frozenOld.usage_by_plan_model[0].events).toBe(99);

      const rolling24 = JSON.parse(readFileSync(join(dir, "rolling", "24h.json"), "utf8")) as StatsReport;
      expect(rolling24.usage_by_plan_model[0].events).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prunes expired >90d hourly snapshots from disk and continues paginating full pages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-data-prune-"));
    try {
      const expiredFile = join(dir, "hourly", "2026-06-01T00Z.json");
      mkdirSync(join(dir, "hourly"), { recursive: true });
      writeFileSync(
        expiredFile,
        `${JSON.stringify(makeHour("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z", 5).report, null, 2)}\n`,
      );

      // Generate 721 hours ending at 2026-11-15T00:00:00Z to exercise multi-page sync.
      const baseMs = Date.parse("2026-10-16T00:00:00Z");
      const all721: ExportedHour[] = Array.from({ length: 721 }, (_, idx) => {
        const startIso = new Date(baseMs + idx * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
        const endIso = new Date(baseMs + (idx + 1) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
        return makeHour(startIso, endIso, 1);
      });

      let calls = 0;
      const res = await syncTelemetryData({
        dataDir: dir,
        statsUrl: "https://worker.example/api/telemetry/stats",
        apiToken: "secret",
        now: new Date("2026-11-15T01:08:00Z"),
        fetcher: async (url) => {
          calls += 1;
          const after = new URL(url).searchParams.get("after") ?? "";
          return all721.filter((h) => h.hour_bucket > after).slice(0, 720);
        },
      });

      expect(calls).toBe(2);
      expect(res).toEqual({ changed: true, imported: 721 });
      expect(existsSync(expiredFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves all 14 TPS histogram buckets across rolling aggregations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-data-tps-14-"));
    try {
      const hour = makeHour("2026-11-15T00:00:00Z", "2026-11-15T01:00:00Z", 4);
      const hist14 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
      hour.report.tps_by_model_effort = [
        {
          model: "Claude Opus 4.6",
          effort: "high",
          sample_count: 105,
          output_tokens: 10000,
          elapsed_ms: 50000,
          histogram: hist14,
        },
      ];

      const res = await syncTelemetryData({
        dataDir: dir,
        statsUrl: "https://worker.example/api/telemetry/stats",
        apiToken: "secret",
        now: new Date("2026-11-15T01:15:00Z"),
        fetcher: async () => [hour],
      });
      expect(res).toEqual({ changed: true, imported: 1 });

      const rolling24 = JSON.parse(readFileSync(join(dir, "rolling", "24h.json"), "utf8")) as StatsReport;
      expect(rolling24.tps_by_model_effort[0].histogram).toEqual(hist14);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves all 14 quota cost histogram buckets and maps sub-cent fallbacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-data-quota-14-"));
    try {
      const hour = makeHour("2026-11-15T00:00:00Z", "2026-11-15T01:00:00Z", 4);
      const hist14 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
      hour.report.quota_by_plan_bucket_model = [
        {
          plan_tier: "Google AI Pro",
          bucket: "Claude",
          attributed_model: "Claude Opus 4.6",
          attributed_effort: "high",
          slices: 105,
          delta_quota_fraction: 0.5,
          input_tokens: 1000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 500,
          reference_cost_usd: 1.0,
          cost_per_pct_histogram: hist14,
        },
        {
          plan_tier: "Google AI Pro",
          bucket: "Claude",
          attributed_model: "Claude Sonnet 4.6",
          attributed_effort: "medium",
          slices: 4,
          delta_quota_fraction: 0.2,
          input_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 200,
          reference_cost_usd: 0.04, // $0.002 / 1% -> bucket 0 [0, 0.005)
        },
        {
          plan_tier: "Google AI Pro",
          bucket: "Gemini Pro",
          attributed_model: "Gemini 3.1 Pro High",
          attributed_effort: "high",
          slices: 4,
          delta_quota_fraction: 0.2,
          input_tokens: 600,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 300,
          reference_cost_usd: 0.12, // $0.006 / 1% -> bucket 1 [0.005, 0.01)
        },
      ];

      const res = await syncTelemetryData({
        dataDir: dir,
        statsUrl: "https://worker.example/api/telemetry/stats",
        apiToken: "secret",
        now: new Date("2026-11-15T01:15:00Z"),
        fetcher: async () => [hour],
      });
      expect(res).toEqual({ changed: true, imported: 1 });

      const rolling24 = JSON.parse(readFileSync(join(dir, "rolling", "24h.json"), "utf8")) as StatsReport;
      const byModel = new Map(
        rolling24.quota_by_plan_bucket_model.map((r) => [r.attributed_model, r.cost_per_pct_histogram]),
      );
      expect(byModel.get("Claude Opus 4.6")).toEqual(hist14);
      expect(byModel.get("Claude Sonnet 4.6")).toEqual([4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(byModel.get("Gemini 3.1 Pro High")).toEqual([0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("derives stats endpoint cleanly from baseUrl with or without trailing slash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-data-base-url-"));
    try {
      const requestedUrls: string[] = [];
      await syncTelemetryData({
        dataDir: dir,
        baseUrl: "https://antigravity-status-telemetry.umahq.workers.dev/",
        apiToken: "secret",
        now: new Date("2026-11-15T01:15:00Z"),
        fetcher: async (url) => {
          requestedUrls.push(url);
          return [];
        },
      });
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toStartWith(
        "https://antigravity-status-telemetry.umahq.workers.dev/api/telemetry/stats?",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
