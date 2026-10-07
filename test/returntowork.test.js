import assert from "node:assert/strict";
import test from "node:test";

import { makeService, openPlan } from "./support.js";

function flagStaff(service) {
  return service.flagFoodHandler({
    staffId: "staff-1",
    venueId: "venue-1",
    name: "张某",
    symptomaticAt: "2026-10-01T12:00:00.000Z",
  });
}

test("门店经理不能单独决定食品处理人员返岗", () => {
  const { service } = makeService();
  flagStaff(service);
  const decision = service.decideReturnToWork({
    staffId: "staff-1",
    decidedBy: { actorId: "mgr-1", role: "store_manager" },
    symptomFreeSince: "2026-10-01T12:00:00.000Z",
  });
  assert.equal(decision.approved, false);
  assert.ok(decision.rejects.includes("unqualified_role"));
  assert.ok(decision.rejects.includes("not_independent_of_store_manager"));
});

test("具备合格角色但身份为门店经理本人仍被拦截", () => {
  const { service } = makeService();
  flagStaff(service);
  const decision = service.decideReturnToWork({
    staffId: "staff-1",
    decidedBy: { actorId: "mgr-1", role: "public_health_officer" },
    symptomFreeSince: "2026-10-01T12:00:00.000Z",
  });
  assert.equal(decision.approved, false);
  assert.ok(decision.rejects.includes("not_independent_of_store_manager"));
  assert.ok(!decision.rejects.includes("unqualified_role"));
});

test("症状消失时长不足规则要求时不得返岗", () => {
  const { service } = makeService();
  flagStaff(service);
  const decision = service.decideReturnToWork({
    staffId: "staff-1",
    decidedBy: { actorId: "pho-1", role: "public_health_officer" },
    symptomFreeSince: "2026-10-01T12:00:00.000Z",
  });
  assert.equal(decision.approved, false);
  assert.deepEqual(decision.rejects, ["insufficient_symptom_free_time"]);
});

test("独立合格角色且症状消失满 72 小时方可返岗", () => {
  const { service } = makeService();
  flagStaff(service);
  service.advanceClock({ seconds: 80 * 3600 });
  const decision = service.decideReturnToWork({
    staffId: "staff-1",
    decidedBy: { actorId: "pho-1", role: "public_health_officer" },
    symptomFreeSince: "2026-10-01T12:00:00.000Z",
  });
  assert.equal(decision.approved, true);
  assert.throws(() => service.decideReturnToWork({ staffId: "staff-1", decidedBy: { actorId: "pho-1", role: "public_health_officer" } }), /没有在岗限制/);
});

test("返岗限制沿用事件处置方案的规则版本", () => {
  const { service } = makeService();
  const { incidentId } = openPlan(service);
  const restriction = service.flagFoodHandler({
    staffId: "staff-2",
    venueId: "venue-1",
    incidentId,
    symptomaticAt: "2026-10-01T12:00:00.000Z",
  });
  assert.equal(restriction.ruleId, "norovirus-cleanup");
  assert.equal(restriction.ruleVersion, 1);
});
