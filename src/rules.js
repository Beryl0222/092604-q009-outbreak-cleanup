/**
 * 内置的清消规则样例。
 * agent 字段是疑似病原假设，仅用于选择清消标准，不构成医学诊断。
 */
export function norovirusCleanupRule({
  ruleId = "norovirus-cleanup",
  version = 1,
  effectiveFrom,
  effectiveUntil = null,
  venueIds = null,
} = {}) {
  return {
    ruleId,
    version,
    effectiveFrom,
    effectiveUntil,
    venueIds,
    agent: "norovirus",
    steps: [
      { key: "isolate", name: "隔离污染区域并设置警示", required: true },
      { key: "remove_contaminant", name: "以一次性材料清除呕吐物/排泄物并密封处置", required: true },
      // 诺如病毒对酒精不敏感，酒精擦拭不满足清消要求，须使用含氯消毒剂并保持作用时长。
      { key: "disinfect", name: "含氯消毒剂作用污染表面", required: true, contactMinutes: 30, acceptableDisinfectants: ["chlorine"] },
      { key: "ventilate", name: "通风换气", required: false },
    ],
    ppe: ["disposable_gloves", "mask", "gown"],
    foodHandlerReturn: { symptomFreeHours: 72 },
    recheckWithinHours: 24,
  };
}
