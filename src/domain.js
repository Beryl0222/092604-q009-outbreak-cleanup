/** 聚集性胃肠事件处置的纯领域规则。 */

/** 可以独立决定食品处理人员返岗的合格角色（门店经理不在其中）。 */
export const QUALIFIED_RETURN_ROLES = Object.freeze([
  "food_safety_officer",
  "public_health_officer",
  "occupational_health_physician",
]);

/** 支持的线索来源类型。 */
export const SOURCE_TYPES = Object.freeze(["phone", "store_work_order", "property_record"]);

const HOUR_MS = 3_600_000;

export function hoursBetween(fromIso, toIso) {
  return (Date.parse(toIso) - Date.parse(fromIso)) / HOUR_MS;
}

/**
 * 判断线索是否应并入既有事件：同场所、同就餐批次、发生时段落在事件时间窗附近。
 * 就餐批次不同的线索绝不合并，以免遗漏不同批次的暴露。
 */
export function clueMatchesIncident(incident, clue, windowHours) {
  if (incident.status !== "open") return false;
  if (incident.venueId !== clue.venueId) return false;
  if (incident.mealBatchId !== clue.mealBatchId) return false;
  const margin = windowHours * HOUR_MS;
  const at = Date.parse(clue.occurredAt);
  return at >= Date.parse(incident.windowStart) - margin && at <= Date.parse(incident.windowEnd) + margin;
}

/**
 * 评估处置方案与规则快照的差距；返回空数组表示方案满足复开条件。
 * 关键步骤跳过、作用时间不足、消毒剂不符合（含酒精擦拭冒充诺如病毒清消）、
 * 方案依据的规则版本过期、复查未通过，都会形成差距。
 */
export function evaluatePlan(plan, now) {
  const rule = plan.ruleSnapshot;
  const gaps = [];
  for (const stepRule of rule.steps) {
    const record = plan.steps[stepRule.key];
    if (!record || record.status !== "done") {
      if (stepRule.required) {
        gaps.push({
          step: stepRule.key,
          gap: record?.status === "skipped" ? "step_skipped" : "step_missing",
        });
      }
      continue;
    }
    if (stepRule.contactMinutes != null && (record.contactMinutes == null || record.contactMinutes < stepRule.contactMinutes)) {
      gaps.push({
        step: stepRule.key,
        gap: "insufficient_contact_time",
        requiredMinutes: stepRule.contactMinutes,
        actualMinutes: record.contactMinutes ?? null,
      });
    }
    if (Array.isArray(stepRule.acceptableDisinfectants)) {
      const used = record.disinfectant ?? null;
      if (!used || !stepRule.acceptableDisinfectants.includes(used)) {
        gaps.push({
          step: stepRule.key,
          gap: used === "alcohol" && rule.agent === "norovirus" ? "alcohol_insufficient_for_norovirus" : "non_compliant_disinfectant",
          recorded: used,
          acceptable: [...stepRule.acceptableDisinfectants],
        });
      }
    }
  }
  if (rule.effectiveUntil && Date.parse(rule.effectiveUntil) <= Date.parse(now)) {
    gaps.push({ gap: "rule_expired", ruleId: plan.ruleId, version: plan.ruleVersion, effectiveUntil: rule.effectiveUntil });
  }
  const requiredDone = rule.steps.filter((s) => s.required).every((s) => plan.steps[s.key]?.status === "done");
  if (requiredDone && plan.recheck?.outcome !== "passed") {
    gaps.push({ gap: "recheck_pending" });
  }
  return gaps;
}

/** 评估食品处理人员返岗决定；返回空数组表示同意返岗。 */
export function evaluateReturnToWork({ restriction, rule, decidedBy, venue, symptomFreeSince, now }) {
  const rejects = [];
  if (!QUALIFIED_RETURN_ROLES.includes(decidedBy.role)) {
    rejects.push("unqualified_role");
  }
  if (decidedBy.actorId != null && decidedBy.actorId === venue.storeManagerId) {
    rejects.push("not_independent_of_store_manager");
  }
  if (restriction.symptomaticAt) {
    if (!symptomFreeSince) {
      rejects.push("symptom_free_since_required");
    } else if (hoursBetween(symptomFreeSince, now) < rule.foodHandlerReturn.symptomFreeHours) {
      rejects.push("insufficient_symptom_free_time");
    }
  }
  return rejects;
}
