import assert from "node:assert/strict";
import test from "node:test";

import { completeRequiredSteps, lunchClue, makeService, openPlan } from "./support.js";

test("酒精擦拭不被认作满足诺如病毒清消要求，整改后方可复开", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);
  service.recordStep({ planId: plan.planId, stepKey: "isolate", status: "done" });
  service.recordStep({ planId: plan.planId, stepKey: "remove_contaminant", status: "done" });
  service.recordStep({ planId: plan.planId, stepKey: "disinfect", status: "done", disinfectant: "alcohol", contactMinutes: 30 });

  const blocked = service.inspectZone({ zoneId: "hall", by: "duty-1" });
  assert.equal(blocked.state, "closed");
  assert.ok(blocked.gaps.some((gap) => gap.gap === "alcohol_insufficient_for_norovirus"));

  service.recordStep({ planId: plan.planId, stepKey: "disinfect", status: "done", disinfectant: "chlorine", contactMinutes: 30 });
  service.recordRecheck({ planId: plan.planId, outcome: "passed", by: "duty-1" });
  const reopened = service.inspectZone({ zoneId: "hall", by: "duty-1" });
  assert.equal(reopened.state, "open");

  const zone = service.zoneStatus({ zoneId: "hall" });
  const reopenedReason = zone.reasons.at(-1);
  assert.equal(reopenedReason.action, "reopened");
  assert.deepEqual(reopenedReason.rules, [{ ruleId: "norovirus-cleanup", version: 1 }]);
});

test("作用时间不足时区域继续关闭", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);
  service.recordStep({ planId: plan.planId, stepKey: "isolate", status: "done" });
  service.recordStep({ planId: plan.planId, stepKey: "remove_contaminant", status: "done" });
  service.recordStep({ planId: plan.planId, stepKey: "disinfect", status: "done", disinfectant: "chlorine", contactMinutes: 10 });

  const result = service.inspectZone({ zoneId: "hall" });
  assert.equal(result.state, "closed");
  const gap = result.gaps.find((item) => item.gap === "insufficient_contact_time");
  assert.equal(gap.requiredMinutes, 30);
  assert.equal(gap.actualMinutes, 10);
});

test("关键步骤跳过时区域继续关闭", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);
  service.recordStep({ planId: plan.planId, stepKey: "isolate", status: "done" });
  service.recordStep({ planId: plan.planId, stepKey: "remove_contaminant", status: "skipped" });
  service.recordStep({ planId: plan.planId, stepKey: "disinfect", status: "done", disinfectant: "chlorine", contactMinutes: 30 });

  const result = service.inspectZone({ zoneId: "hall" });
  assert.equal(result.state, "closed");
  assert.ok(result.gaps.some((gap) => gap.gap === "step_skipped" && gap.step === "remove_contaminant"));
});

test("方案依据的规则版本过期时区域继续关闭", () => {
  const { service } = makeService({ ruleOverrides: { effectiveUntil: "2026-10-02T00:00:00.000Z" } });
  const { plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);
  service.recordRecheck({ planId: plan.planId, outcome: "passed" });

  service.advanceClock({ seconds: 4 * 3600 });
  const result = service.inspectZone({ zoneId: "hall" });
  assert.equal(result.state, "closed");
  assert.ok(result.gaps.some((gap) => gap.gap === "rule_expired"));
});

test("事实冲突未解决时区域继续关闭，解决后放行", () => {
  const { service } = makeService();
  const { incidentId, plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);
  service.recordRecheck({ planId: plan.planId, outcome: "passed" });

  const conflict = service.flagConflict({ incidentId, description: "电话报 20:00 呕吐，工单记 22:00", clueIds: ["clue-1"] });
  const blocked = service.inspectZone({ zoneId: "hall" });
  assert.equal(blocked.state, "closed");
  assert.ok(blocked.gaps.some((gap) => gap.gap === "unresolved_conflicts"));

  service.resolveConflict({ incidentId, conflictId: conflict.conflictId, resolution: "以门店监控核实为 20:00" });
  const reopened = service.inspectZone({ zoneId: "hall" });
  assert.equal(reopened.state, "open");
});

test("复查通过后步骤被改动则须重新复查", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);
  service.recordRecheck({ planId: plan.planId, outcome: "passed" });

  service.recordStep({ planId: plan.planId, stepKey: "disinfect", status: "done", disinfectant: "chlorine", contactMinutes: 45 });
  const result = service.inspectZone({ zoneId: "hall" });
  assert.equal(result.state, "closed");
  assert.ok(result.gaps.some((gap) => gap.gap === "recheck_pending"));
});

test("复开检查通过前必须完成复查", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);
  const result = service.inspectZone({ zoneId: "hall" });
  assert.equal(result.state, "closed");
  assert.ok(result.gaps.some((gap) => gap.gap === "recheck_pending"));
});

test("区域视图呈现关闭理由、待核查批次与适用规则", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);

  const zone = service.zoneStatus({ zoneId: "hall" });
  assert.equal(zone.state, "closed");
  assert.equal(zone.reasons.at(-1).reason, "聚集性胃肠事件线索");
  assert.deepEqual(
    zone.pendingMealBatches.map((batch) => batch.batchId),
    ["batch-lunch"],
  );
  assert.ok(zone.applicableRules.some((rule) => rule.ruleId === "norovirus-cleanup" && rule.basis === "currently_effective"));

  service.verifyMealBatch({ batchId: "batch-lunch", outcome: "confirmed" });
  const after = service.zoneStatus({ zoneId: "hall" });
  assert.equal(after.pendingMealBatches.length, 0);
  assert.equal(plan.state, "in_progress");
});

test("过期规则不能用于新开处置方案", () => {
  const { service } = makeService({ ruleOverrides: { effectiveUntil: "2026-10-01T20:00:00.000Z" } });
  const reported = service.reportClue(lunchClue("clue-1"));
  assert.throws(
    () => service.startCleanup({ incidentId: reported.incidentId, zoneId: "hall", ruleId: "norovirus-cleanup" }),
    /已过期/,
  );
});
