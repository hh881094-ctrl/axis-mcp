/**
 * プライバシー防壁の回帰テスト。
 *
 * このサーバーは Supabase に service_role で繋いでいるため RLS が効かない。
 * privateゴール(インセン・評価・個人タスク)を守っているのは src/index.ts の
 * applyGoalPrivacy() / readableGoal() だけ。goals の約4割が private なので、
 * ここに穴が空くと機密が静かに漏れる。
 *
 * ツールを追加・変更したら必ずこれを通すこと。
 *
 * 使い方:
 *   1) HTTPモードでサーバーを起動（メンバートークンを1本入れる）
 *   2) TEST_URL=http://localhost:8787/mcp \
 *      TEST_TOKEN=<そのトークン> \
 *      TEST_USER_ID=<そのメンバーのuser_id> \
 *      node scripts/verify-privacy.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL = process.env.TEST_URL;
const TOKEN = process.env.TEST_TOKEN;
const USER_ID = process.env.TEST_USER_ID;
if (!URL || !TOKEN || !USER_ID) {
  console.error("TEST_URL / TEST_TOKEN / TEST_USER_ID が必要です");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new globalThis.URL(URL), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: "verify-privacy", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

let failed = 0;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (!pass) failed++;
};
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content?.[0]?.text ?? "";
};
const rows = (t) => { try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; } };
// 「他人が作った private」が1件でも見えたら失格。自分が作った private は見えてよい。
const foreign = (list) => list.filter((g) => g.is_private && g.created_by !== USER_ID);

const tools = (await client.listTools()).tools.map((t) => t.name);
const writes = ["add_today_task", "complete_task", "complete_goal", "update_kpi_value", "add_comment"];
check("MCP_READONLY: 書き込みツールが公開されていない", tools.filter((t) => writes.includes(t)).length === 0);
check("list_teams が非owner に見えていない", !tools.includes("list_teams"));

const who = JSON.parse(await call("whoami"));
check("is_owner が false", who.is_owner === false, `name=${who.name}`);

const g = rows(await call("get_goals"));
check("get_goals に他人の private が混ざらない", foreign(g).length === 0, `${g.length}件中 他人private ${foreign(g).length}件`);

const tree = rows(await call("get_goal_tree"));
const treeForeign = [];
const walk = (n) => { if (n.is_private && n.created_by !== USER_ID) treeForeign.push(n.title); (n.children ?? []).forEach(walk); };
tree.forEach(walk);
check("get_goal_tree に他人の private が混ざらない", treeForeign.length === 0, treeForeign.join(" / "));

const od = rows(await call("get_overdue_goals"));
check("get_overdue_goals に他人の private が混ざらない", foreign(od).length === 0);

// 他人の private ゴールを1件見つけて、直接引けないことを確かめる（owner接続で拾った既知IDでもよい）
const probe = process.env.TEST_PRIVATE_GOAL_ID;
if (probe) {
  const d = await call("get_goal_detail", { goal_id: probe });
  check("get_goal_detail: 他人の private を直接引けない", d.includes("閲覧できません"));
  const c = await call("get_comments", { goal_id: probe });
  check("get_comments: 他人の private のコメントを引けない", c.includes("閲覧できません"));
} else {
  console.log("… TEST_PRIVATE_GOAL_ID 未指定のため直接参照テストはスキップ");
}

const unknown = await call("get_goal_detail", { goal_id: "00000000-0000-0000-0000-000000000000" });
check("存在しない goal_id で存在有無を漏らさない", unknown.includes("閲覧できません"));

// 他人のタスクを user_id 指定で覗けないこと（自分のリストに強制される）
const someoneElse = process.env.TEST_OTHER_USER_ID;
if (someoneElse) {
  const mine = rows(await call("get_today_tasks", {}));
  const spoof = rows(await call("get_today_tasks", { user_id: someoneElse }));
  check("get_today_tasks: 他人の user_id を指定しても自分のリストになる", JSON.stringify(mine) === JSON.stringify(spoof));
}

await client.close();
console.log(failed === 0 ? "\n✅ 全て通過" : `\n❌ ${failed}件 失敗`);
process.exit(failed === 0 ? 0 : 1);
