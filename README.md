# Axis MCP Server

Axis（チーム向け行動管理ツール）のデータに Claude Code / Cursor / Claude Desktop からアクセスするための MCP サーバー。

## セットアップ

```bash
git clone https://github.com/hh881094-ctrl/axis-mcp.git
cd axis-mcp
npm install
cp .env.example .env  # AXIS_SUPABASE_SERVICE_ROLE_KEY を設定
npm run build
```

## Claude Code で使う

```bash
claude mcp add axis-mcp node /path/to/axis-mcp/dist/index.js
```

## Claude Desktop で使う

`~/Library/Application Support/Claude/claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "axis-mcp": {
      "command": "node",
      "args": ["/path/to/axis-mcp/dist/index.js"],
      "env": {
        "AXIS_SUPABASE_URL": "https://trqpkkxugbqkvxsxmdfh.supabase.co",
        "AXIS_SUPABASE_SERVICE_ROLE_KEY": "your_service_role_key_here"
      }
    }
  }
}
```

## 利用可能なツール（13個）

| ツール | 説明 |
|--------|------|
| `get_goals` | ゴール一覧取得（status / phase / 担当者 / 親IDでフィルタ） |
| `get_goal_detail` | ゴール詳細（KPI・サブゴール・成果物・コメント数含む） |
| `get_today_tasks` | 今日のToDo一覧 |
| `get_kpi_progress` | KPI進捗一覧（達成率付き） |
| `get_team_members` | チームメンバー一覧 |
| `get_overdue_goals` | 期日超過ゴール一覧 |
| `get_phase_summary` | フェーズサマリー（KPI・active/completed数） |
| `get_notifications` | 通知取得（未読のみフィルタ可） |
| `get_comments` | コメントスレッド取得 |
| `get_vision` | 年間目標取得 |
| `complete_goal` | ゴールを完了にする（子孫も連動） |
| `complete_task` | ToDoタスクを完了にする |
| `add_comment` | ゴールにコメントを追加 |

## 環境変数

| Key | 説明 |
|-----|------|
| `AXIS_SUPABASE_URL` | Supabase プロジェクト URL |
| `AXIS_SUPABASE_SERVICE_ROLE_KEY` | Supabase Legacy service_role キー |

`service_role` キーは Supabase Dashboard → Project Settings → API Keys → Legacy タブから取得。

## 開発

```bash
npm run dev    # tsx でホットリロード
npm run build  # TypeScript ビルド
```

## ライセンス

MIT
