# Axis MCP Server

Axis（チーム向け行動管理ツール）のデータを Claude に丸ごと理解させる MCP サーバー。
**Claude Code / Claude Desktop / claude.ai (Web) の3クライアントすべて**から接続できる。

- ローカル利用（Code / Desktop）: **stdio** トランスポート（ホスティング不要）
- どこからでも利用（特に claude.ai Web）: **Streamable HTTP** トランスポート + Bearer トークン認証（公開HTTPSにデプロイ）

接続すると Claude が「今日のタスク・ゴール階層・KPI進捗・期日・担当」を把握した状態で会話できる。

---

## セットアップ

```bash
cd axis-mcp
npm install
# .env を用意（下記「環境変数」参照）— 特に service_role キーは最新の有効なものに
npm run build
```

### 環境変数（.env）

| Key | 必須 | 説明 |
|-----|------|------|
| `AXIS_SUPABASE_URL` | ✅ | Supabase プロジェクト URL（例: `https://trqpkkxugbqkvxsxmdfh.supabase.co`） |
| `AXIS_SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service_role キー（Dashboard → Project Settings → API Keys）。**期限切れ/ローテーション済みなら更新する** |
| `AXIS_DEFAULT_TEAM_ID` | 任意 | 既定チームID。設定すると Claude が team_id を指定せずツールを呼べる |
| `AXIS_DEFAULT_USER_ID` | 任意 | 既定ユーザーID（今日のタスクなどの主体） |
| `MCP_TRANSPORT` | 任意 | `stdio`(既定) or `http` |
| `MCP_BEARER_TOKEN` | http時必須 | HTTP接続の認証トークン（各クライアントが `Authorization: Bearer` で送る） |
| `MCP_PORT` | 任意 | HTTPポート（既定 8787） |
| `MCP_READONLY` | 任意 | `1` で書き込み系ツールを無効化（閲覧専用にする） |

> このチームの既定値: `AXIS_DEFAULT_TEAM_ID=db544bee-cae2-4310-9510-7c8193a3aa3e`（マイチーム）/ `AXIS_DEFAULT_USER_ID=694aae26-94e3-4e3c-a6a3-461f17d0d388`（弘中颯人）

---

## 接続方法

### 1) Claude Code（ローカル・stdio）

```bash
claude mcp add axis --command node --args /Users/hironakahayato/axis-mcp/dist/index.js
# もしくは設定ファイル ~/.claude/mcp.json に直接記載
```

### 2) Claude Desktop（ローカル・stdio）

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "axis": {
      "command": "node",
      "args": ["/Users/hironakahayato/axis-mcp/dist/index.js"],
      "env": {
        "AXIS_SUPABASE_URL": "https://trqpkkxugbqkvxsxmdfh.supabase.co",
        "AXIS_SUPABASE_SERVICE_ROLE_KEY": "（有効なservice_roleキー）",
        "AXIS_DEFAULT_TEAM_ID": "db544bee-cae2-4310-9510-7c8193a3aa3e",
        "AXIS_DEFAULT_USER_ID": "694aae26-94e3-4e3c-a6a3-461f17d0d388"
      }
    }
  }
}
```

### 3) claude.ai（Web・リモートHTTP）※ Pro 以上が必要

まず公開HTTPSにデプロイ（Railway / Render / Fly.io 等。`MCP_TRANSPORT=http` で起動）:

```bash
MCP_TRANSPORT=http MCP_BEARER_TOKEN=（長いランダム文字列） npm start
# → https://<your-host>/mcp が公開エンドポイント
```

claude.ai → 設定 → コネクタ → **カスタムコネクタを追加**:
- URL: `https://<your-host>/mcp`
- 認証: Bearer トークンに上の `MCP_BEARER_TOKEN` を貼る

同じHTTPSエンドポイントは Claude Code / Desktop からも使える:

```bash
claude mcp add axis --transport http --url https://<your-host>/mcp \
  --header "Authorization: Bearer （MCP_BEARER_TOKEN）"
```

---

## 利用可能なツール（18個）

### 発見・閲覧（read）
| ツール | 説明 |
|--------|------|
| `whoami` | 既定チーム/ユーザーと今日の日付を返す（起点） |
| `list_teams` | チーム一覧とメンバー（team_id 特定用） |
| `get_goal_tree` | **ゴールを階層ツリーで取得（全体像把握に最適）** |
| `get_goals` | ゴール一覧（status/phase/担当者でフィルタ。アーカイブ配下は除外） |
| `get_goal_detail` | ゴール詳細（KPI・サブゴール・成果物・コメント数） |
| `search_goals` | キーワードでゴール検索 |
| `get_today_tasks` | 今日のToDo一覧 |
| `get_kpi_progress` | KPI進捗（達成率付き、アーカイブ除外） |
| `get_overdue_goals` | 期日超過ゴール（アーカイブ除外） |
| `get_phase_summary` | フェーズ（四半期）サマリー |
| `get_team_members` | チームメンバー一覧 |
| `get_vision` | 年間目標（ビジョン） |
| `get_comments` | ゴールのコメントスレッド |

### 書き込み（write・`MCP_READONLY=1` で無効化可）
| ツール | 説明 |
|--------|------|
| `add_today_task` | 今日のToDoにタスク追加 |
| `complete_task` | タスクを完了に |
| `complete_goal` | ゴールを完了に（子孫連動） |
| `update_kpi_value` | KPI現在値を更新 |
| `add_comment` | ゴールにコメント追加 |

> アーカイブ済みサブツリーの除外ロジックは Axis 本体の `getArchivedSubtreeGoalIds` と同等。

---

## 開発

```bash
npm run dev        # stdio（ホットリロード）
npm run dev:http   # Streamable HTTP（要 MCP_BEARER_TOKEN）
npm run build      # TypeScript ビルド
npm start          # stdio で起動
npm run start:http # HTTP で起動
```

ヘルスチェック: `GET /health` → `{"ok":true,"service":"axis-mcp"}`

## ライセンス

MIT
