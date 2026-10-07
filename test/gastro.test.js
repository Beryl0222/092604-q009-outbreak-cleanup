import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../src/api.js";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";

const T0 = "2026-10-07T08:00:00.000Z";

function makeService(startAt = T0) {
  const store = new Store();
  store.setMeta("sim_now_ms", Date.parse(startAt));
  const service = new Service({ store });
  return { service, store };
}

function rule(overrides = {}) {
  return {
    ruleId: "norovirus-cleanup",
    version: 1,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: "2026-12-31T23:59:59.000Z",
    aggregationWindowMinutes: 120,
    recheckIntervalMinutes: 240,
    steps: [
      { stepId: "isolate", kind: "contaminant_cleanup", key: true, title: "污染物清理与隔离" },
      { stepId: "ppe", kind: "ppe", key: true, title: "防护用品佩戴" },
      { stepId: "disinfect", kind: "disinfection", key: true, title: "含氯消毒剂作用" },
    ],
    disinfection: { acceptedAgents: ["chlorine_disinfectant"], contactMinutes: 30 },
    returnToWork: { qualifiedRoles: ["food_safety_officer", "public_health_officer"] },
    ...overrides,
  };
}

function clue(overrides = {}) {
  return {
    clueId: "clue-1",
    source: "phone",
    siteId: "site-1",
    zoneId: "zone-a",
    mealBatchId: "batch-1",
    occurredAt: "2026-10-07T07:30:00.000Z",
    symptoms: { vomiting: 2, diarrhea: 1 },
    ...overrides,
  };
}

function setupEventWithPlan(service) {
  service.registerRule(rule());
  const { event } = service.reportClue(clue());
  service.startPlan(event.eventId);
  return event;
}

function completeAllSteps(service, eventId) {
  service.beginStep(eventId, "isolate");
  service.completeStep(eventId, "isolate");
  service.beginStep(eventId, "ppe");
  service.completeStep(eventId, "ppe");
  service.beginStep(eventId, "disinfect", { agent: "chlorine_disinfectant" });
  service.advanceClock(30);
  service.completeStep(eventId, "disinfect");
}

test("电话、工单、物业三类线索按共同就餐、时段和分区聚合，且各自来源保留", () => {
  const { service } = makeService();
  service.registerRule(rule());
  service.reportClue(clue({ clueId: "c-phone", source: "phone" }));
  service.reportClue(clue({ clueId: "c-wo", source: "work_order", occurredAt: "2026-10-07T07:50:00.000Z" }));
  const { event, zone } = service.reportClue(clue({ clueId: "c-prop", source: "property", occurredAt: "2026-10-07T08:10:00.000Z" }));

  assert.equal(event.clues.length, 3);
  assert.deepEqual(event.clues.map((c) => c.source), ["phone", "work_order", "property"]);
  assert.equal(zone.state, "closed");
  assert.match(zone.reasons[0].reason, /处置中/);
});

test("不同就餐批次不被过早合并：列为尚待核查并产生事实冲突", () => {
  const { service } = makeService();
  service.registerRule(rule());
  const { event } = service.reportClue(clue());
  service.reportClue(clue({ clueId: "c-2", source: "work_order", mealBatchId: "batch-2" }));

  const view = service.viewZone("zone-a");
  assert.deepEqual(view.pendingMealBatches.map((b) => b.batchId).sort(), ["batch-1", "batch-2"]);
  assert.equal(view.unresolvedConflicts.length, 1);
  assert.equal(view.unresolvedConflicts[0].type, "meal_batch_mismatch");
  assert.equal(service.viewEvent(event.eventId).mealBatches.length, 2);
});

test("不同分区与超出发生时段的线索不并入同一事件", () => {
  const { service } = makeService();
  service.registerRule(rule());
  const first = service.reportClue(clue());
  const otherZone = service.reportClue(clue({ clueId: "c-2", zoneId: "zone-b" }));
  const late = service.reportClue(clue({ clueId: "c-3", occurredAt: "2026-10-07T18:30:00.000Z" }));

  assert.notEqual(first.event.eventId, otherZone.event.eventId);
  assert.notEqual(first.event.eventId, late.event.eventId);
  assert.equal(service.viewZone("zone-b").state, "closed");
});

test("服务不作医学诊断：携带诊断字段的线索被拒绝", () => {
  const { service } = makeService();
  service.registerRule(rule());
  assert.throws(() => service.reportClue(clue({ diagnosis: "norovirus" })), /医学诊断/);
});

test("酒精擦拭不能认作满足诺如病毒清消要求", () => {
  const { service } = makeService();
  assert.throws(
    () => service.registerRule(rule({ disinfection: { acceptedAgents: ["alcohol_wipe"], contactMinutes: 30 } })),
    /酒精擦拭/,
  );
  const event = setupEventWithPlan(service);
  assert.throws(() => service.beginStep(event.eventId, "disinfect", { agent: "alcohol_wipe" }), /酒精擦拭/);
  assert.throws(() => service.beginStep(event.eventId, "disinfect", { agent: "quaternary_ammonium" }), /允许范围/);
});

test("消毒作用时间不足时步骤不能完成", () => {
  const { service } = makeService();
  const event = setupEventWithPlan(service);
  service.beginStep(event.eventId, "disinfect", { agent: "chlorine_disinfectant" });
  assert.throws(() => service.completeStep(event.eventId, "disinfect"), /作用时间不足/);
  service.advanceClock(30);
  const plan = service.completeStep(event.eventId, "disinfect");
  assert.equal(plan.steps.find((s) => s.stepId === "disinfect").contactSatisfied, true);
});

test("关键步骤跳过或事实冲突未解决时区域继续关闭，核查批次后复开", () => {
  const { service } = makeService();
  service.registerRule(rule());
  const { event } = service.reportClue(clue());
  service.reportClue(clue({ clueId: "c-2", source: "property", mealBatchId: "batch-2" }));
  service.startPlan(event.eventId);

  let result = service.inspectZone("zone-a", { result: "pass", inspector: "insp-1" });
  assert.equal(result.zone.state, "closed");
  assert.ok(result.inspection.blockers.some((b) => b.startsWith("关键步骤跳过")));
  assert.ok(result.inspection.blockers.some((b) => b.startsWith("事实冲突未解决")));

  completeAllSteps(service, event.eventId);
  result = service.inspectZone("zone-a", { result: "pass", inspector: "insp-1" });
  assert.equal(result.zone.state, "closed");
  assert.ok(result.inspection.blockers.some((b) => b.startsWith("事实冲突未解决")));

  service.verifyBatch(event.eventId, "batch-1");
  service.verifyBatch(event.eventId, "batch-2");
  assert.equal(service.viewZone("zone-a").unresolvedConflicts.length, 0);

  result = service.inspectZone("zone-a", { result: "pass", inspector: "insp-1" });
  assert.equal(result.zone.state, "open");
  assert.equal(result.zone.reasons.at(-1).reason, "复开检查通过");
});

test("报告时间相互矛盾的批次须书面解决冲突后方可复开", () => {
  const { service } = makeService();
  service.registerRule(rule());
  const { event } = service.reportClue(clue({ occurredAt: "2026-10-07T08:00:00.000Z" }));
  service.reportClue(clue({ clueId: "c-2", occurredAt: "2026-10-07T09:59:00.000Z" }));
  service.reportClue(clue({ clueId: "c-3", occurredAt: "2026-10-07T11:59:00.000Z" }));

  const conflicts = service.viewEvent(event.eventId).conflicts;
  assert.equal(conflicts.filter((c) => c.type === "time_inconsistent").length, 1);

  service.startPlan(event.eventId);
  completeAllSteps(service, event.eventId);
  service.verifyBatch(event.eventId, "batch-1");
  let result = service.inspectZone("zone-a", { result: "pass" });
  assert.equal(result.zone.state, "closed");

  service.resolveConflict(event.eventId, conflicts[0].conflictId, "经核对为同一批次供餐延后记录");
  result = service.inspectZone("zone-a", { result: "pass" });
  assert.equal(result.zone.state, "open");
});

test("方案过期时区域继续关闭，登记新规则并重建方案后可复开", () => {
  const { service } = makeService();
  service.registerRule(rule({ effectiveTo: "2026-10-07T09:00:00.000Z" }));
  const { event } = service.reportClue(clue());
  service.startPlan(event.eventId);
  completeAllSteps(service, event.eventId);
  service.advanceClock(60); // 越过规则有效期

  let view = service.viewZone("zone-a");
  assert.ok(view.reopenBlockers.some((b) => b.startsWith("方案过期")));
  assert.equal(service.inspectZone("zone-a", { result: "pass" }).zone.state, "closed");

  service.registerRule(rule({ version: 2, effectiveFrom: "2026-10-07T09:00:00.000Z" }));
  const plan = service.startPlan(event.eventId);
  assert.equal(plan.ruleSnapshot.version, 2);
  completeAllSteps(service, event.eventId);
  service.verifyBatch(event.eventId, "batch-1");
  assert.equal(service.inspectZone("zone-a", { result: "pass" }).zone.state, "open");
});

test("方案进行中不得重复建立", () => {
  const { service } = makeService();
  const event = setupEventWithPlan(service);
  assert.throws(() => service.startPlan(event.eventId), /进行中/);
});

test("返岗决定须由独立于门店经理的合格角色参与", () => {
  const { service } = makeService();
  service.registerRule(rule());
  assert.throws(
    () => service.decideReturn({ handlerId: "h-1", decision: "approve", decidedBy: { id: "m-1", role: "store_manager" } }),
    /独立于门店经理/,
  );
  assert.throws(
    () => service.decideReturn({ handlerId: "h-1", decision: "approve", decidedBy: { id: "x-1", role: "cashier" } }),
    /资质/,
  );
  const record = service.decideReturn({
    handlerId: "h-1",
    siteId: "site-1",
    decision: "approve",
    decidedBy: { id: "q-1", role: "food_safety_officer" },
  });
  assert.equal(record.decision, "approve");
  assert.equal(service.find("return:h-1").decidedBy.role, "food_safety_officer");
});

test("推进模拟时钟触发复查逾期升级，重启服务后计时依据不重置", () => {
  const { service, store } = makeService();
  const event = setupEventWithPlan(service); // 复查期限 08:00 + 240 分钟

  let tick = service.advanceClock(300);
  assert.equal(tick.escalations.length, 1);
  assert.equal(tick.escalations[0].level, 1);
  assert.equal(tick.escalations[0].reason, "复查逾期升级");

  service.recheckZone("zone-a", { by: "duty-1", note: "现场复查" });
  tick = service.advanceClock(300);
  assert.equal(tick.escalations.length, 1);
  assert.equal(tick.escalations[0].level, 2);

  // 模拟重启：同一存储、新的服务实例，时刻与逾期记录保持
  const restarted = new Service({ store });
  assert.equal(restarted.clock.now(), tick.now);
  const view = restarted.viewZone("zone-a");
  assert.equal(view.escalations.length, 2);
  assert.ok(Date.parse(view.recheckDueAt) > Date.parse(tick.now));
  assert.ok(event.eventId);
});

test("查看区域可看到关闭或复开理由、尚待核查批次和当时适用的处置规则", () => {
  const { service } = makeService();
  const event = setupEventWithPlan(service);
  service.reportClue(clue({ clueId: "c-2", source: "work_order", mealBatchId: "batch-2" }));

  const view = service.viewZone("zone-a");
  assert.equal(view.state, "closed");
  assert.ok(view.reasons.some((r) => r.type === "closed"));
  assert.deepEqual(view.pendingMealBatches.map((b) => b.batchId).sort(), ["batch-1", "batch-2"]);
  assert.equal(view.appliedRule.ruleId, "norovirus-cleanup");
  assert.equal(view.appliedRule.version, 1);
  assert.equal(view.plan.steps.length, 3);
  assert.ok(event.eventId);
});

test("通过 JSON 接口完成登记规则、上报线索与查看区域", () => {
  const store = new Store();
  store.setMeta("sim_now_ms", Date.parse(T0));
  const service = new Service({ store });

  const ruleResult = JSON.parse(handle(JSON.stringify({ action: "register_rule", rule: rule() }), service));
  assert.equal(ruleResult.version, 1);

  const clueResult = JSON.parse(handle(JSON.stringify({ action: "report_clue", clue: clue() }), service));
  assert.equal(clueResult.zone.state, "closed");

  const view = JSON.parse(handle(JSON.stringify({ action: "view_zone", zoneId: "zone-a" }), service));
  assert.equal(view.state, "closed");
  assert.equal(view.pendingMealBatches.length, 1);

  const err = JSON.parse(
    (() => {
      try {
        return handle(JSON.stringify({ action: "report_clue", clue: clue({ clueId: "c-9", diagnosis: "x" }) }), service);
      } catch (error) {
        return JSON.stringify({ error: error.message });
      }
    })(),
  );
  assert.match(err.error, /医学诊断/);
});
