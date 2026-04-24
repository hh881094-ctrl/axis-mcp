#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.AXIS_SUPABASE_URL!;
const supabaseKey = process.env.AXIS_SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  console.error("AXIS_SUPABASE_URL and AXIS_SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

const server = new McpServer({
  name: "axis-mcp",
  version: "1.0.0",
});

// Tool 1: get_goals — ゴール一覧取得
server.tool(
  "get_goals",
  "チームのゴール一覧を取得する。フェーズ、ステータス、担当者でフィルタ可能。",
  {
    team_id: z.string().describe("チームID"),
    status: z.enum(["active", "completed", "archived"]).optional().describe("ステータスフィルタ"),
    phase_id: z.string().optional().describe("フェーズIDでフィルタ"),
    assigned_to: z.string().optional().describe("担当者IDでフィルタ"),
    parent_id: z.string().optional().describe("親ゴールIDでフィルタ"),
    top_level_only: z.boolean().optional().describe("トップレベルゴールのみ取得"),
  },
  async ({ team_id, status, phase_id, assigned_to, parent_id, top_level_only }) => {
    let query = supabase
      .from("goals")
      .select("id, title, description, status, color, assigned_to, due_date, depth, sort_order, parent_id, phase_id, recurrence_type, completion_criteria, created_at, updated_at")
      .eq("team_id", team_id)
      .order("sort_order");
    if (status) query = query.eq("status", status);
    if (phase_id) query = query.eq("phase_id", phase_id);
    if (assigned_to) query = query.eq("assigned_to", assigned_to);
    if (parent_id) query = query.eq("parent_id", parent_id);
    if (top_level_only) query = query.is("parent_id", null);
    const { data, error } = await query;
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 2: get_goal_detail — ゴール詳細取得
server.tool(
  "get_goal_detail",
  "ゴールの詳細情報を取得する。KPI、サブゴール、成果物、コメント数を含む。",
  { goal_id: z.string().describe("ゴールID") },
  async ({ goal_id }) => {
    const { data: goal, error } = await supabase.from("goals").select("*").eq("id", goal_id).single();
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    const { data: kpis } = await supabase.from("goal_progress").select("id, title, current_value, target_value, unit").eq("goal_id", goal_id);
    const { data: subgoals } = await supabase.from("goals").select("id, title, status, assigned_to, due_date").eq("parent_id", goal_id).order("sort_order");
    const { count: commentCount } = await supabase.from("comments").select("id", { count: "exact", head: true }).eq("goal_id", goal_id);
    const { data: deliverables } = await supabase.from("deliverables").select("id, title, type, file_url, link_url").eq("goal_id", goal_id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...goal, kpis: kpis || [], subgoals: subgoals || [], comment_count: commentCount || 0, deliverables: deliverables || [] }, null, 2) }] };
  }
);

// Tool 3: get_today_tasks — 今日のToDo取得
server.tool(
  "get_today_tasks",
  "指定ユーザーの今日のToDoリストを取得する。",
  {
    team_id: z.string().describe("チームID"),
    user_id: z.string().describe("ユーザーID"),
    date: z.string().optional().describe("日付(YYYY-MM-DD)。省略時は今日(JST)"),
  },
  async ({ team_id, user_id, date }) => {
    const targetDate = date || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const { data, error } = await supabase.from("daily_tasks").select("id, title, is_completed, is_recurring, goal_id, sort_order, created_at").eq("team_id", team_id).eq("user_id", user_id).eq("task_date", targetDate).order("sort_order");
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 4: get_kpi_progress — KPI進捗取得
server.tool(
  "get_kpi_progress",
  "チームのKPI進捗一覧を取得する。",
  {
    team_id: z.string().describe("チームID"),
    assigned_to: z.string().optional().describe("担当者IDでフィルタ"),
  },
  async ({ team_id, assigned_to }) => {
    let q = supabase.from("goals").select("id, title, color").eq("team_id", team_id).eq("status", "active");
    if (assigned_to) q = q.eq("assigned_to", assigned_to);
    const { data: goals } = await q;
    if (!goals?.length) return { content: [{ type: "text" as const, text: "KPIが設定されたゴールがありません" }] };
    const { data: kpis } = await supabase.from("goal_progress").select("id, goal_id, title, current_value, target_value, unit").in("goal_id", goals.map(g => g.id));
    const gm = new Map(goals.map(g => [g.id, g]));
    const result = (kpis || []).map(k => ({ ...k, goal_title: gm.get(k.goal_id)?.title, progress_pct: k.target_value > 0 ? Math.round((k.current_value / k.target_value) * 100) : 0 }));
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 5: get_team_members
server.tool("get_team_members", "チームメンバー一覧を取得する。", { team_id: z.string() },
  async ({ team_id }) => {
    const { data, error } = await supabase.from("team_members").select("user_id, role, profiles(id, email, display_name, avatar_url, member_color)").eq("team_id", team_id);
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 6: get_overdue_goals
server.tool("get_overdue_goals", "期日超過のアクティブゴール一覧を取得する。", { team_id: z.string(), assigned_to: z.string().optional() },
  async ({ team_id, assigned_to }) => {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    let q = supabase.from("goals").select("id, title, due_date, assigned_to, color, depth").eq("team_id", team_id).eq("status", "active").lt("due_date", today).not("due_date", "is", null).order("due_date");
    if (assigned_to) q = q.eq("assigned_to", assigned_to);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 7: get_phase_summary
server.tool("get_phase_summary", "フェーズの目標・KPI・進捗サマリーを取得する。", { team_id: z.string(), phase_id: z.string().optional() },
  async ({ team_id, phase_id }) => {
    let q = supabase.from("phases").select("id, name, start_date, end_date, is_current, is_completed, goal, result, sort_order").eq("team_id", team_id).order("sort_order");
    if (phase_id) q = q.eq("id", phase_id);
    const { data: phases, error } = await q;
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    const result = [];
    for (const p of phases || []) {
      const { data: kpis } = await supabase.from("phase_kpis").select("id, title, current_value, target_value, unit").eq("phase_id", p.id);
      const { count: ac } = await supabase.from("goals").select("id", { count: "exact", head: true }).eq("team_id", team_id).eq("phase_id", p.id).eq("status", "active");
      const { count: cc } = await supabase.from("goals").select("id", { count: "exact", head: true }).eq("team_id", team_id).eq("phase_id", p.id).eq("status", "completed");
      result.push({ ...p, kpis: kpis || [], active_goals: ac || 0, completed_goals: cc || 0 });
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 8: get_notifications
server.tool("get_notifications", "ユーザーの通知を取得する。", { team_id: z.string(), user_id: z.string(), unread_only: z.boolean().optional() },
  async ({ team_id, user_id, unread_only }) => {
    let q = supabase.from("notifications").select("id, type, title, body, link, is_read, created_at").eq("team_id", team_id).eq("user_id", user_id).order("created_at", { ascending: false }).limit(20);
    if (unread_only !== false) q = q.eq("is_read", false);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 9: get_comments
server.tool("get_comments", "ゴールのコメントスレッドを取得する。", { goal_id: z.string() },
  async ({ goal_id }) => {
    const { data, error } = await supabase.from("comments").select("id, user_id, content, created_at").eq("goal_id", goal_id).order("created_at");
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 10: get_vision
server.tool("get_vision", "チームの年間目標を取得する。", { team_id: z.string() },
  async ({ team_id }) => {
    const { data, error } = await supabase.from("team_vision").select("vision, annual_goals, updated_at").eq("team_id", team_id).single();
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 11: complete_goal
server.tool("complete_goal", "ゴールを完了にする。子孫も連動。", { goal_id: z.string() },
  async ({ goal_id }) => {
    const { error } = await supabase.from("goals").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", goal_id);
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    await supabase.rpc("update_descendants_status", { p_parent_id: goal_id, p_status: "completed" });
    return { content: [{ type: "text" as const, text: `ゴール ${goal_id} を完了にしました` }] };
  }
);

// Tool 12: complete_task
server.tool("complete_task", "ToDoタスクを完了にする。", { task_id: z.string() },
  async ({ task_id }) => {
    const { error } = await supabase.from("daily_tasks").update({ is_completed: true }).eq("id", task_id);
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: `タスク ${task_id} を完了にしました` }] };
  }
);

// Tool 13: add_comment
server.tool("add_comment", "ゴールにコメントを追加する。", { goal_id: z.string(), user_id: z.string(), content: z.string() },
  async ({ goal_id, user_id, content }) => {
    const { error } = await supabase.from("comments").insert({ goal_id, user_id, content });
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return { content: [{ type: "text" as const, text: `コメントを追加しました` }] };
  }
);

// サーバー起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Axis MCP server running on stdio");
}
main().catch(console.error);
