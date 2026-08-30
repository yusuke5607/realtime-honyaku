import { describe, expect, it } from "vitest";
import { calculateMetrics } from "./metrics.js";

describe("calculateMetrics", () => {
  it("pipelineの音声1分を概算$0.02で計算する", () => {
    const metrics = calculateMetrics("pipeline", 24_000 * 2 * 60, 320);
    expect(metrics.audioSeconds).toBe(60);
    expect(metrics.estimatedUsd).toBeCloseTo(0.02, 6);
    expect(metrics.firstResultMs).toBe(320);
  });

  it("directの音声1分を$0.034で計算する", () => {
    const metrics = calculateMetrics("direct", 24_000 * 2 * 60, null);
    expect(metrics.estimatedUsd).toBeCloseTo(0.034, 6);
  });

  it("pipelineのテキストトークン料金を加算する", () => {
    const metrics = calculateMetrics("pipeline", 0, null, 1_000_000, 1_000_000);
    expect(metrics.estimatedUsd).toBeCloseTo(2.25, 6);
  });
});
