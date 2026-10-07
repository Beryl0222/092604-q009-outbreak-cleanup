import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../src/api.js";
import { makeService } from "./support.js";

test("健康检查与基础登记保持兼容", () => {
  const health = JSON.parse(handle('{"action":"health"}'));
  assert.equal(health.status, "ok");

  const { service } = makeService();
  const created = JSON.parse(handle('{"action":"register","recordId":"r-1","ownerId":"o-1"}', service));
  assert.equal(created.state, "draft");
  const found = JSON.parse(handle('{"action":"find","recordId":"r-1"}', service));
  assert.equal(found.ownerId, "o-1");
});

test("接口可完成从线索到复开的全流程", () => {
  const { service } = makeService();
  const call = (body) => JSON.parse(handle(JSON.stringify(body), service));

  const reported = call({
    action: "reportClue",
    clue: {
      clueId: "clue-api",
      venueId: "venue-1",
      zoneId: "hall",
      mealBatchId: "batch-lunch",
      occurredAt: "2026-10-01T14:00:00.000Z",
      source: { type: "phone", ref: "caller-9" },
      symptoms: { vomiting: 1, diarrhea: 0 },
    },
  });
  assert.equal(reported.merged, false);

  const plan = call({ action: "startCleanup", incidentId: reported.incidentId, zoneId: "hall", ruleId: "norovirus-cleanup" });
  assert.deepEqual(plan.ppeIssued, ["disposable_gloves", "mask", "gown"]);

  call({ action: "recordStep", planId: plan.planId, stepKey: "isolate", status: "done" });
  call({ action: "recordStep", planId: plan.planId, stepKey: "remove_contaminant", status: "done" });
  call({ action: "recordStep", planId: plan.planId, stepKey: "disinfect", status: "done", disinfectant: "chlorine", contactMinutes: 30 });
  call({ action: "recordRecheck", planId: plan.planId, outcome: "passed" });

  const inspected = call({ action: "inspectZone", zoneId: "hall", by: "duty-2" });
  assert.equal(inspected.state, "open");

  const zone = call({ action: "zoneStatus", zoneId: "hall" });
  assert.equal(zone.state, "open");
  assert.equal(zone.reasons.at(-1).action, "reopened");
  assert.ok(zone.applicableRules.length > 0);
});

test("接口拒绝医学诊断动作与诊断字段", () => {
  const { service } = makeService();
  assert.throws(() => handle('{"action":"diagnose"}', service), /医学诊断/);
  assert.throws(
    () =>
      handle(
        JSON.stringify({
          action: "reportClue",
          clue: {
            clueId: "clue-dx",
            venueId: "venue-1",
            zoneId: "hall",
            occurredAt: "2026-10-01T14:00:00.000Z",
            source: { type: "phone" },
            diagnosis: "诺如病毒感染",
          },
        }),
        service,
      ),
    /医学诊断/,
  );
});

test("接口可推进模拟时钟并列出逾期升级", () => {
  const { service } = makeService();
  const call = (body) => JSON.parse(handle(JSON.stringify(body), service));

  const reported = call({
    action: "reportClue",
    clue: {
      clueId: "clue-api-2",
      venueId: "venue-1",
      zoneId: "hall",
      mealBatchId: "batch-lunch",
      occurredAt: "2026-10-01T14:00:00.000Z",
      source: { type: "property_record", ref: "pr-8" },
    },
  });
  const plan = call({ action: "startCleanup", incidentId: reported.incidentId, zoneId: "hall", ruleId: "norovirus-cleanup" });
  call({ action: "recordStep", planId: plan.planId, stepKey: "isolate", status: "done" });
  call({ action: "recordStep", planId: plan.planId, stepKey: "remove_contaminant", status: "done" });
  call({ action: "recordStep", planId: plan.planId, stepKey: "disinfect", status: "done", disinfectant: "chlorine", contactMinutes: 30 });

  const advanced = call({ action: "advanceClock", seconds: 25 * 3600 });
  assert.equal(advanced.newEscalations.length, 1);

  const escalations = call({ action: "listEscalations", venueId: "venue-1" });
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].type, "recheck_overdue");

  const zone = call({ action: "zoneStatus", zoneId: "hall" });
  assert.equal(zone.escalations.length, 1);
});

test("未知动作被拒绝", () => {
  assert.throws(() => handle('{"action":"explode"}'), /不支持的请求动作/);
});
