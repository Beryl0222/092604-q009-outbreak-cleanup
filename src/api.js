/** 处理进程内 JSON 请求。 */
import { Service } from "./service.js";

export function handle(raw, service = new Service()) {
  const body = JSON.parse(raw);
  const result = dispatch(body, service);
  return JSON.stringify(result);
}

function dispatch(body, service) {
  switch (body.action) {
    case "health":
      return service.health();
    case "register":
      return service.register(String(body.recordId), String(body.ownerId));
    case "find":
      return service.find(String(body.recordId));
    case "registerVenue":
      return service.registerVenue(body);
    case "registerRule":
      return service.registerRule(body.rule ?? body);
    case "registerMealBatch":
      return service.registerMealBatch(body);
    case "verifyMealBatch":
      return service.verifyMealBatch(body);
    case "reportClue":
      return service.reportClue(body.clue ?? body);
    case "getIncident":
      return service.getIncident(body);
    case "flagConflict":
      return service.flagConflict(body);
    case "resolveConflict":
      return service.resolveConflict(body);
    case "startCleanup":
      return service.startCleanup(body);
    case "recordStep":
      return service.recordStep(body);
    case "recordRecheck":
      return service.recordRecheck(body);
    case "inspectZone":
      return service.inspectZone(body);
    case "flagFoodHandler":
      return service.flagFoodHandler(body);
    case "decideReturnToWork":
      return service.decideReturnToWork(body);
    case "advanceClock":
      return service.advanceClock(body);
    case "zoneStatus":
      return service.zoneStatus(body);
    case "listEscalations":
      return service.listEscalations(body);
    case "diagnose":
      throw new Error("本服务不作医学诊断");
    default:
      throw new Error("不支持的请求动作");
  }
}
