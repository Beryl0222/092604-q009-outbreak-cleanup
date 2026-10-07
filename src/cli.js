/** 从标准输入接收 JSON 请求。 */
import { handle } from "./api.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
try {
  console.log(handle(raw.trim() || '{"action":"health"}'));
} catch (error) {
  console.error(JSON.stringify({ error: String(error?.message ?? error) }));
  process.exitCode = 1;
}
