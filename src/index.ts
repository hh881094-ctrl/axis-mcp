#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";

// クライアント(Claude Code/Desktop)が任意の cwd から起動しても .env を読めるよう、
// パッケージルート基準で読み込む。env が既に与えられている場合は上書きしない。
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });
dotenv.config();

const supabaseUrl = process.env.AXIS_SUPABASE_URL!;
const supabaseKey = process.env.AXIS_SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  console.error("AXIS_SUPABASE_URL and AXIS_SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

const DEFAULT_TEAM_ID = process.env.AXIS_DEFAULT_TEAM_ID || undefined;
const DEFAULT_USER_ID = process.env.AXIS_DEFAULT_USER_ID || undefined;

/** 接続主体（誰として / どのチーム / ownerか / 他メンバーのタスクを見てよいか）。 */
type Ctx = { userId?: string; teamId?: string; isOwner?: boolean; name?: string; canViewTeamTasks?: boolean };

/**
 * 日次タスクを非owner に見せないメンバー（user_id）。
 * env AXIS_TASK_PRIVATE_USER_IDS にカンマ区切り or JSON配列で渡す。
 *
 * 用途: 「メンバー同士はタスクを見せ合ってよいが、弘中さんのタスクだけは見せない」。
 * ここに入れた人のタスクは can_view_team_tasks を持つメンバーからも隠れる（owner本人は見える）。
 */
function loadTaskPrivateUsers(): Set<string> {
  const raw = (process.env.AXIS_TASK_PRIVATE_USER_IDS || "").trim();
  if (!raw) return new Set();
  let ids: string[] = [];
  if (raw.startsWith("[")) {
    try { ids = JSON.parse(raw) as string[]; } catch { console.error("AXIS_TASK_PRIVATE_USER_IDS の JSON が不正です"); }
  } else {
    ids = raw.split(",");
  }
  return new Set(ids.map((s) => String(s).trim()).filter(Boolean));
}
const TASK_PRIVATE_USERS = loadTaskPrivateUsers();

/**
 * メンバー別トークン。各メンバーが自分の Claude を繋ぐための個人トークン → 本人。
 * env AXIS_MEMBER_TOKENS に JSON 配列で渡す:
 *   [{"token":"axis_xxx","user_id":"<uuid>","name":"山本将来","is_owner":false,"can_view_team_tasks":true}]
 * team_id 省略時は AXIS_DEFAULT_TEAM_ID。
 *
 * can_view_team_tasks: 他メンバーの日次タスクを見てよいか（既定 false = 自分のぶんだけ）。
 *   true にしても AXIS_TASK_PRIVATE_USER_IDS に入っている人のタスクは見えない。
 *   ゴールの is_private は別軸で常に効く（この権限では private ゴールは見えない）。
 */
function loadMemberTokens(): Map<string, Ctx> {
  const map = new Map<string, Ctx>();
  const raw = process.env.AXIS_MEMBER_TOKENS;
  if (!raw) return map;
  try {
    const arr = JSON.parse(raw) as Array<{ token: string; user_id: string; team_id?: string; name?: string; is_owner?: boolean; can_view_team_tasks?: boolean }>;
    for (const e of arr) {
      if (!e.token || !e.user_id) continue;
      map.set(e.token, {
        userId: e.user_id,
        teamId: e.team_id ?? DEFAULT_TEAM_ID,
        isOwner: !!e.is_owner,
        name: e.name,
        canViewTeamTasks: !!e.can_view_team_tasks,
      });
    }
  } catch (err) {
    console.error("AXIS_MEMBER_TOKENS の JSON が不正です:", (err as Error).message);
  }
  return map;
}
const MEMBER_TOKENS = loadMemberTokens();

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

function todayJST(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

/** 今週（月曜〜日曜, JST）の [開始日, 終了日] を YYYY-MM-DD で返す。 */
function thisWeekJST(): [string, string] {
  const today = todayJST();                       // JSTの今日
  const d = new Date(`${today}T00:00:00Z`);       // 日付だけをUTC正午前として扱い、曜日計算のズレを避ける
  const dow = d.getUTCDay();                      // 0=日, 1=月, ...
  const backToMonday = dow === 0 ? 6 : dow - 1;   // 日曜は前の月曜まで6日戻る
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - backToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  return [fmt(monday), fmt(sunday)];
}

/** チーム内で「アーカイブされた祖先を持つゴール」のID集合（Axis本体の getArchivedSubtreeGoalIds と同等）。 */
async function archivedSubtreeIds(teamId: string): Promise<Set<string>> {
  const { data } = await supabase.from("goals").select("id, parent_id, status").eq("team_id", teamId);
  const rows = (data ?? []) as { id: string; parent_id: string | null; status: string }[];
  const parent = new Map(rows.map((r) => [r.id, r.parent_id]));
  const archived = new Set(rows.filter((r) => r.status === "archived").map((r) => r.id));
  const hidden = new Set<string>();
  if (archived.size === 0) return hidden;
  for (const r of rows) {
    let c = parent.get(r.id) ?? null;
    const seen = new Set<string>();
    while (c && !seen.has(c)) {
      seen.add(c);
      if (archived.has(c)) { hidden.add(r.id); break; }
      c = parent.get(c) ?? null;
    }
  }
  return hidden;
}

export function createAxisServer(ctx: Ctx = {}): McpServer {
  const server = new McpServer({ name: "axis-mcp", version: "1.2.0" });

  // 接続主体の実効値。stdio(ローカル/owner)は ctx 未指定 → owner 扱い・既定ID。
  const ctxTeam = ctx.teamId ?? DEFAULT_TEAM_ID;
  const ctxUser = ctx.userId ?? DEFAULT_USER_ID;
  const isOwner = ctx.isOwner ?? true;

  const teamOf = (param?: string) => param ?? ctxTeam;

  // 他メンバーの日次タスクを見てよいか。owner か、can_view_team_tasks を持つメンバーのみ。
  const canViewTeamTasks = isOwner || !!ctx.canViewTeamTasks;

  // タスクを見せないメンバー（弘中さん等）。owner本人にはこの制限をかけない。
  const taskHidden = (uid: string) => !isOwner && TASK_PRIVATE_USERS.has(uid);

  /**
   * 日次タスクで参照してよい user_id を決める。
   * - 権限が無ければ常に自分に強制（他人を覗けない）
   * - 権限があっても、非公開設定のメンバー（弘中さん）は指定できない
   * 返り値が null なら「見せられない」。
   */
  const taskUserOf = (param?: string): string | null | undefined => {
    if (!param) return ctxUser;                    // 未指定 → 自分
    if (param === ctxUser) return ctxUser;         // 自分自身は常にOK
    if (!canViewTeamTasks) return ctxUser;         // 権限なし → 自分に強制（従来どおり）
    if (taskHidden(param)) return null;            // 非公開メンバー → 拒否
    return param;
  };

  // Axis のプライバシー規則を MCP 側でも再現:
  // 非owner は他人の private ゴールを見られない（is_private が false/null、または自分作成のもののみ）。
  const applyGoalPrivacy = <T>(q: T): T => {
    if (isOwner || !ctxUser) return q;
    // @ts-expect-error supabase query builder の .or を許可
    return q.or(`is_private.is.null,is_private.eq.false,created_by.eq.${ctxUser}`);
  };

  /**
   * goal_id を受け取るツールの共通ゲート。
   * ここを通さずに goals / comments / deliverables を goal_id で直接引かないこと
   * （service_role 接続のため RLS は効かず、この関数だけが防壁）。
   * 見えない場合は null を返す（存在の有無も伝えない）。
   */
  const readableGoal = async (goalId: string) => {
    const { data, error } = await supabase.from("goals").select("*").eq("id", goalId).maybeSingle();
    if (error || !data) return null;
    if (ctxTeam && data.team_id !== ctxTeam) return null;                        // 別チームのゴールは引けない
    if (!isOwner && data.is_private && data.created_by !== ctxUser) return null; // 他人の private は引けない
    return data;
  };

  // ── 発見系 ───────────────────────────────────────────────
  server.tool(
    "whoami",
    "この接続が誰として/どのチームで動いているか、ownerか、今日の日付を返す。全体像把握の起点。",
    {},
    async () => json({ user_id: ctxUser ?? null, team_id: ctxTeam ?? null, is_owner: isOwner, name: ctx.name ?? null, today_jst: todayJST() })
  );

  if (isOwner) {
    server.tool(
      "list_teams",
      "（owner専用）チーム一覧とメンバーを取得する。",
      {},
      async () => {
        const { data: teams } = await supabase.from("teams").select("id, name");
        const result = [];
        for (const t of teams ?? []) {
          const { data: members } = await supabase.from("team_members").select("user_id, role, profiles(display_name)").eq("team_id", t.id);
          result.push({ ...t, members: members ?? [] });
        }
        return json(result);
      }
    );
  }

  // ── ゴール系 ─────────────────────────────────────────────
  server.tool(
    "get_goals",
    "チームのゴール一覧を取得する。status/phase/担当者でフィルタ可。アーカイブ済みサブツリーは除外。",
    {
      team_id: z.string().optional(),
      status: z.enum(["active", "completed", "archived"]).optional(),
      phase_id: z.string().optional(),
      assigned_to: z.string().optional(),
      parent_id: z.string().optional(),
      top_level_only: z.boolean().optional(),
      include_archived_subtree: z.boolean().optional(),
    },
    async ({ team_id, status, phase_id, assigned_to, parent_id, top_level_only, include_archived_subtree }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      let query = supabase
        .from("goals")
        .select("id, title, description, status, color, assigned_to, due_date, depth, sort_order, parent_id, phase_id, recurrence_type, completion_criteria, is_private, created_by, created_at, updated_at")
        .eq("team_id", tid)
        .order("sort_order");
      if (status) query = query.eq("status", status);
      if (phase_id) query = query.eq("phase_id", phase_id);
      if (assigned_to) query = query.eq("assigned_to", assigned_to);
      if (parent_id) query = query.eq("parent_id", parent_id);
      if (top_level_only) query = query.is("parent_id", null);
      query = applyGoalPrivacy(query);
      const { data, error } = await query;
      if (error) return text(`Error: ${error.message}`);
      let rows = data ?? [];
      if (!include_archived_subtree) {
        const hidden = await archivedSubtreeIds(tid);
        rows = rows.filter((g) => !hidden.has(g.id));
      }
      return json(rows);
    }
  );

  server.tool(
    "get_goal_tree",
    "ゴールを階層ツリー（年間→ゴール→サブゴール）で取得する。全体像の把握に最適。アーカイブ済みは除外。",
    { team_id: z.string().optional(), assigned_to: z.string().optional() },
    async ({ team_id, assigned_to }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      let q = supabase
        .from("goals")
        .select("id, title, status, color, assigned_to, due_date, parent_id, sort_order, phase_id, is_private, created_by")
        .eq("team_id", tid).neq("status", "archived").order("sort_order");
      q = applyGoalPrivacy(q);
      const { data, error } = await q;
      if (error) return text(`Error: ${error.message}`);
      const hidden = await archivedSubtreeIds(tid);
      const rows = (data ?? []).filter((g) => !hidden.has(g.id));
      type Node = (typeof rows)[number] & { children: Node[] };
      const byId = new Map<string, Node>(rows.map((g) => [g.id, { ...g, children: [] as Node[] }]));
      const roots: Node[] = [];
      for (const n of byId.values()) {
        const parent = n.parent_id ? byId.get(n.parent_id) : null;
        if (parent) parent.children.push(n);
        else roots.push(n);
      }
      if (assigned_to) {
        const keep = (n: Node): boolean => { n.children = n.children.filter(keep); return n.assigned_to === assigned_to || n.children.length > 0; };
        return json(roots.filter(keep));
      }
      return json(roots);
    }
  );

  server.tool(
    "get_goal_detail",
    "ゴールの詳細（KPI・サブゴール・成果物・コメント数）を取得する。",
    { goal_id: z.string() },
    async ({ goal_id }) => {
      const goal = await readableGoal(goal_id);
      if (!goal) return text("このゴールは閲覧できません（非公開、または別チームのゴールです）");
      const { data: kpis } = await supabase.from("goal_progress").select("id, title, current_value, target_value, unit").eq("goal_id", goal_id);
      // サブゴールにも親と同じプライバシー規則を適用する（公開の親の下に private な子がぶら下がっていても漏らさない）
      let sq = supabase.from("goals").select("id, title, status, assigned_to, due_date").eq("parent_id", goal_id).order("sort_order");
      sq = applyGoalPrivacy(sq);
      const { data: subgoals } = await sq;
      const { count: commentCount } = await supabase.from("comments").select("id", { count: "exact", head: true }).eq("goal_id", goal_id);
      const { data: deliverables } = await supabase.from("deliverables").select("id, title, type, file_url, link_url").eq("goal_id", goal_id);
      return json({ ...goal, kpis: kpis ?? [], subgoals: subgoals ?? [], comment_count: commentCount ?? 0, deliverables: deliverables ?? [] });
    }
  );

  server.tool(
    "search_goals",
    "ゴールをタイトル/説明のキーワードで検索する。",
    { keyword: z.string(), team_id: z.string().optional() },
    async ({ keyword, team_id }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      let q = supabase.from("goals").select("id, title, status, assigned_to, due_date, parent_id, is_private, created_by").eq("team_id", tid).ilike("title", `%${keyword}%`).limit(40);
      q = applyGoalPrivacy(q);
      const { data, error } = await q;
      if (error) return text(`Error: ${error.message}`);
      return json(data);
    }
  );

  // ── 今日のタスク / 進捗 ──────────────────────────────────
  server.tool(
    "get_today_tasks",
    "今日のToDoリストを取得する。user_id 省略時は自分のぶん。チーム全員をまとめて見るなら get_team_tasks を使う。",
    { user_id: z.string().optional(), team_id: z.string().optional(), date: z.string().optional() },
    async ({ user_id, team_id, date }) => {
      const tid = teamOf(team_id);
      const uid = taskUserOf(user_id);
      if (uid === null) return text("このメンバーのタスクは非公開です");
      if (!tid || !uid) return text("team_id と user_id が必要です（whoami で確認）");
      const { data, error } = await supabase
        .from("daily_tasks")
        .select("id, title, is_completed, is_recurring, goal_id, sort_order, created_at")
        .eq("team_id", tid).eq("user_id", uid).eq("task_date", date || todayJST()).order("sort_order");
      if (error) return text(`Error: ${error.message}`);
      return json(data);
    }
  );

  server.tool(
    "get_team_tasks",
    "チームメンバーの日次タスクを期間指定でまとめて取得する（誰のタスクかが分かる形で返る）。" +
      "date_from/date_to 省略時は今週（月〜日, JST）。「今週の全員のタスクを要約して」に使う。" +
      "非公開に設定されたメンバーのタスクは含まれない。",
    {
      team_id: z.string().optional(),
      date_from: z.string().optional(),
      date_to: z.string().optional(),
      only_incomplete: z.boolean().optional(),
    },
    async ({ team_id, date_from, date_to, only_incomplete }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      if (!canViewTeamTasks) return text("他メンバーのタスクを見る権限がありません（get_today_tasks で自分のぶんを取得してください）");

      const [from, to] = date_from && date_to ? [date_from, date_to] : thisWeekJST();

      const { data: members, error: mErr } = await supabase
        .from("team_members").select("user_id, profiles(display_name)").eq("team_id", tid);
      if (mErr) return text(`Error: ${mErr.message}`);

      // 非公開メンバー（弘中さん等）はここで除外する。以降のクエリに user_id が渡らない。
      const visible = (members ?? []).filter((m) => !taskHidden(m.user_id));
      const nameOf = new Map(visible.map((m) => [m.user_id, (m.profiles as unknown as { display_name?: string } | null)?.display_name ?? "(不明)"]));
      if (!visible.length) return text("表示できるメンバーがいません");

      let q = supabase
        .from("daily_tasks")
        .select("id, user_id, title, is_completed, goal_id, task_date, sort_order")
        .eq("team_id", tid)
        .in("user_id", visible.map((m) => m.user_id))
        .gte("task_date", from).lte("task_date", to)
        .order("task_date").order("sort_order");
      if (only_incomplete) q = q.eq("is_completed", false);
      const { data, error } = await q;
      if (error) return text(`Error: ${error.message}`);

      // メンバーごとにまとめて返す（要約しやすい形）
      const byUser = new Map<string, { user_id: string; name: string; tasks: unknown[] }>();
      for (const m of visible) byUser.set(m.user_id, { user_id: m.user_id, name: nameOf.get(m.user_id)!, tasks: [] });
      for (const t of data ?? []) {
        byUser.get(t.user_id)?.tasks.push({ id: t.id, date: t.task_date, title: t.title, is_completed: t.is_completed, goal_id: t.goal_id });
      }
      const hiddenCount = (members ?? []).length - visible.length;
      return json({
        period: { from, to },
        hidden_members: hiddenCount, // 非公開設定で除外された人数（中身は返さない）
        members: [...byUser.values()],
      });
    }
  );

  server.tool(
    "get_kpi_progress",
    "アクティブゴールのKPI進捗一覧（達成率付き）を取得する。アーカイブ済みは除外。",
    { team_id: z.string().optional(), assigned_to: z.string().optional() },
    async ({ team_id, assigned_to }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      let q = supabase.from("goals").select("id, title, color, is_private, created_by").eq("team_id", tid).eq("status", "active");
      if (assigned_to) q = q.eq("assigned_to", assigned_to);
      q = applyGoalPrivacy(q);
      const { data: goals } = await q;
      if (!goals?.length) return text("KPIが設定されたアクティブゴールがありません");
      const hidden = await archivedSubtreeIds(tid);
      const visible = goals.filter((g) => !hidden.has(g.id));
      const { data: kpis } = await supabase.from("goal_progress").select("id, goal_id, title, current_value, target_value, unit").in("goal_id", visible.map((g) => g.id));
      const gm = new Map(visible.map((g) => [g.id, g]));
      const result = (kpis ?? []).filter((k) => gm.has(k.goal_id)).map((k) => ({ ...k, goal_title: gm.get(k.goal_id)?.title, progress_pct: k.target_value > 0 ? Math.round((k.current_value / k.target_value) * 100) : 0 }));
      return json(result);
    }
  );

  server.tool(
    "get_overdue_goals",
    "期日超過のアクティブゴール一覧を取得する。アーカイブ済みは除外。",
    { team_id: z.string().optional(), assigned_to: z.string().optional() },
    async ({ team_id, assigned_to }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      let q = supabase.from("goals").select("id, title, due_date, assigned_to, color, depth, is_private, created_by").eq("team_id", tid).eq("status", "active").lt("due_date", todayJST()).not("due_date", "is", null).order("due_date");
      if (assigned_to) q = q.eq("assigned_to", assigned_to);
      q = applyGoalPrivacy(q);
      const { data, error } = await q;
      if (error) return text(`Error: ${error.message}`);
      const hidden = await archivedSubtreeIds(tid);
      return json((data ?? []).filter((g) => !hidden.has(g.id)));
    }
  );

  server.tool(
    "get_phase_summary",
    "フェーズ（四半期）の目標・KPI・進捗サマリーを取得する。",
    { team_id: z.string().optional(), phase_id: z.string().optional() },
    async ({ team_id, phase_id }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      let q = supabase.from("phases").select("id, name, start_date, end_date, is_current, is_completed, goal, sort_order").eq("team_id", tid).order("sort_order");
      if (phase_id) q = q.eq("id", phase_id);
      const { data: phases, error } = await q;
      if (error) return text(`Error: ${error.message}`);
      const result = [];
      for (const p of phases ?? []) {
        const { data: kpis } = await supabase.from("phase_kpis").select("id, title, current_value, target_value, unit").eq("phase_id", p.id);
        // 件数にも privacy を効かせる（見えないはずの private ゴールを数に含めない）
        const countBy = async (status: "active" | "completed") => {
          let cq = supabase.from("goals").select("id", { count: "exact", head: true }).eq("team_id", tid).eq("phase_id", p.id).eq("status", status);
          cq = applyGoalPrivacy(cq);
          const { count } = await cq;
          return count ?? 0;
        };
        result.push({ ...p, kpis: kpis ?? [], active_goals: await countBy("active"), completed_goals: await countBy("completed") });
      }
      return json(result);
    }
  );

  server.tool(
    "get_team_members",
    "チームメンバー一覧を取得する。",
    { team_id: z.string().optional() },
    async ({ team_id }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      const { data, error } = await supabase.from("team_members").select("user_id, role, profiles(id, display_name, member_color)").eq("team_id", tid);
      if (error) return text(`Error: ${error.message}`);
      return json(data);
    }
  );

  server.tool(
    "get_vision",
    "チームの年間目標(ビジョン)を取得する。",
    { team_id: z.string().optional() },
    async ({ team_id }) => {
      const tid = teamOf(team_id);
      if (!tid) return text("team_id が必要です");
      const { data, error } = await supabase.from("team_vision").select("vision, annual_goals, updated_at").eq("team_id", tid).single();
      if (error) return text(`Error: ${error.message}`);
      return json(data);
    }
  );

  server.tool(
    "get_comments",
    "ゴールのコメントスレッドを取得する。",
    { goal_id: z.string() },
    async ({ goal_id }) => {
      // コメントは親ゴールの公開範囲を継承する。private ゴールのスレッドを覗かせない。
      if (!(await readableGoal(goal_id))) return text("このゴールは閲覧できません（非公開、または別チームのゴールです）");
      const { data, error } = await supabase.from("comments").select("id, user_id, content, created_at").eq("goal_id", goal_id).order("created_at");
      if (error) return text(`Error: ${error.message}`);
      return json(data);
    }
  );

  // ── 書き込み系（MCP_READONLY=1 で無効化可能） ──
  if (process.env.MCP_READONLY !== "1") {
    server.tool(
      "add_today_task",
      "今日のToDoにタスクを追加する（自分のリストに入る）。goal_id を紐付け可。",
      { title: z.string(), team_id: z.string().optional(), goal_id: z.string().optional(), date: z.string().optional() },
      async ({ title, team_id, goal_id, date }) => {
        const tid = teamOf(team_id);
        const uid = ctxUser; // 常に本人のリストへ
        if (!tid || !uid) return text("team_id と user_id が必要です");
        const { error } = await supabase.from("daily_tasks").insert({ team_id: tid, user_id: uid, goal_id: goal_id ?? null, title, is_completed: false, is_recurring: false, task_date: date || todayJST() });
        if (error) return text(`Error: ${error.message}`);
        return text(`今日のToDoに「${title}」を追加しました`);
      }
    );

    server.tool(
      "complete_task",
      "ToDoタスクを完了にする（自分のタスクのみ）。",
      { task_id: z.string() },
      async ({ task_id }) => {
        let q = supabase.from("daily_tasks").update({ is_completed: true }).eq("id", task_id);
        if (!isOwner && ctxUser) q = q.eq("user_id", ctxUser);
        const { error } = await q;
        if (error) return text(`Error: ${error.message}`);
        return text(`タスク ${task_id} を完了にしました`);
      }
    );

    server.tool(
      "complete_goal",
      "ゴールを完了にする（子孫も連動）。",
      { goal_id: z.string() },
      async ({ goal_id }) => {
        if (!(await readableGoal(goal_id))) return text("このゴールは操作できません（非公開、または別チームのゴールです）");
        const { error } = await supabase.from("goals").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", goal_id);
        if (error) return text(`Error: ${error.message}`);
        await supabase.rpc("update_descendants_status", { p_parent_id: goal_id, p_status: "completed" });
        return text(`ゴール ${goal_id} を完了にしました`);
      }
    );

    server.tool(
      "update_kpi_value",
      "KPI(goal_progress)の現在値を更新する。",
      { kpi_id: z.string(), current_value: z.number() },
      async ({ kpi_id, current_value }) => {
        // KPI 単体では権限が判定できないので、親ゴール経由でゲートを通す
        const { data: kpi } = await supabase.from("goal_progress").select("goal_id").eq("id", kpi_id).maybeSingle();
        if (!kpi || !(await readableGoal(kpi.goal_id))) return text("このKPIは操作できません（非公開、または別チームのゴールです）");
        const { error } = await supabase.from("goal_progress").update({ current_value, updated_at: new Date().toISOString() }).eq("id", kpi_id);
        if (error) return text(`Error: ${error.message}`);
        return text(`KPI ${kpi_id} を ${current_value} に更新しました`);
      }
    );

    server.tool(
      "add_comment",
      "ゴールにコメントを追加する（自分名義）。",
      { goal_id: z.string(), content: z.string() },
      async ({ goal_id, content }) => {
        if (!ctxUser) return text("user_id が必要です");
        if (!(await readableGoal(goal_id))) return text("このゴールは操作できません（非公開、または別チームのゴールです）");
        const { error } = await supabase.from("comments").insert({ goal_id, user_id: ctxUser, content });
        if (error) return text(`Error: ${error.message}`);
        return text("コメントを追加しました");
      }
    );
  }

  return server;
}

// ── トランスポート ─────────────────────────────────────────
async function runStdio() {
  // ローカル(stdio)は owner 本人として全権。
  const server = createAxisServer({ isOwner: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Axis MCP server running on stdio");
}

/** Bearer トークンから接続主体(Ctx)を解決。メンバー別トークン優先、無ければ管理者トークン。 */
function resolveCtx(authHeader?: string): Ctx | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const tok = authHeader.slice(7);
  const member = MEMBER_TOKENS.get(tok);
  if (member) return member;
  const admin = process.env.MCP_BEARER_TOKEN;
  if (admin && tok === admin) return { userId: DEFAULT_USER_ID, teamId: DEFAULT_TEAM_ID, isOwner: true };
  return null;
}

async function runHttp() {
  const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "8787");
  if (!process.env.MCP_BEARER_TOKEN && MEMBER_TOKENS.size === 0) {
    console.error("HTTP transport requires MCP_BEARER_TOKEN または AXIS_MEMBER_TOKENS");
    process.exit(1);
  }

  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => { res.json({ ok: true, service: "axis-mcp", members: MEMBER_TOKENS.size }); });

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    const ctx = resolveCtx(req.headers.authorization);
    if (!ctx) { res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }); return; }

    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      transport.onclose = () => { if (transport!.sessionId) sessions.delete(transport!.sessionId); };
      const server = createAxisServer(ctx);
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
    if (transport.sessionId) sessions.set(transport.sessionId, transport);
  });

  const sessionRoute: express.RequestHandler = async (req, res) => {
    if (!resolveCtx(req.headers.authorization)) { res.status(401).send("Unauthorized"); return; }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? sessions.get(sid) : undefined;
    if (!transport) { res.status(400).send("Invalid or missing session ID"); return; }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionRoute);
  app.delete("/mcp", sessionRoute);

  app.listen(PORT, () => { console.error(`Axis MCP server (Streamable HTTP) on :${PORT}/mcp — members=${MEMBER_TOKENS.size}`); });
}

async function main() {
  if ((process.env.MCP_TRANSPORT || "stdio").toLowerCase() === "http") await runHttp();
  else await runStdio();
}
main().catch((e) => { console.error(e); process.exit(1); });
