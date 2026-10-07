/** 处理进程内 JSON 请求。 */
import { Service } from "./service.js";

export function handle(raw, service = new Service()) {
  const body = JSON.parse(raw);
  let result;
  if (body.action === "health") result = service.health();
  else if (body.action === "register") result = service.register(String(body.recordId), String(body.ownerId));
  else if (body.action === "find") result = service.find(String(body.recordId));
  else if (body.action === "register_rule") result = service.registerRule(body.rule);
  else if (body.action === "report_clue") result = service.reportClue(body.clue);
  else if (body.action === "verify_batch") result = service.verifyBatch(String(body.eventId), String(body.mealBatchId));
  else if (body.action === "resolve_conflict") result = service.resolveConflict(String(body.eventId), String(body.conflictId), body.resolution);
  else if (body.action === "start_plan") result = service.startPlan(String(body.eventId));
  else if (body.action === "begin_step") result = service.beginStep(String(body.eventId), String(body.stepId), { agent: body.agent });
  else if (body.action === "complete_step") result = service.completeStep(String(body.eventId), String(body.stepId));
  else if (body.action === "inspect_zone") result = service.inspectZone(String(body.zoneId), { result: body.result, inspector: body.inspector });
  else if (body.action === "decide_return") result = service.decideReturn(body);
  else if (body.action === "advance_clock") result = service.advanceClock(Number(body.minutes));
  else if (body.action === "recheck_zone") result = service.recheckZone(String(body.zoneId), { by: body.by, note: body.note });
  else if (body.action === "view_zone") result = service.viewZone(String(body.zoneId));
  else if (body.action === "view_event") result = service.viewEvent(String(body.eventId));
  else throw new Error("不支持的请求动作");
  return JSON.stringify(result);
}
