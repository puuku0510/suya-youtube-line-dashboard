# YouTube→LINE / LINEファネル集計

既存の公開ダッシュボードを維持したまま、UTAGEの集計値を兼子さん用Google Sheetへ渡すリポジトリです。

## 更新

- GitHub Actions: 毎日 00:00 / 12:00 JST、手動実行も可
- 必須Secrets: 既存の `UTAGE_API_KEY`, `YOUTUBE_API_KEY`
- 公開ファイルは集計値のみ。氏名、メール、LINE ID、共通読者ID、APIキーは出力しません。

## ファネル用公開集計

- `funnel-current.csv`: 現在ステージ×処理状態の人数
- `funnel-cohort.csv`: LINE登録日コホート別の後続イベント人数
- `funnel-sync-health.csv`: ラベル取得率、未分類人数、同期状態

Google Sheetは上記CSVを `IMPORTDATA` で読み込みます。オプチャの自動指標は実参加ではなくリンククリックです。

## 計測ラベル

コホート分析では、到達後も削除しない `evt_*` ラベルを正本とします。

- `evt_zoom_applied`
- `evt_seminar_applied`
- `evt_vsl_offered`, `evt_vsl_started`, `evt_vsl_completed`
- `evt_meeting_applied`, `evt_meeting_from_vsl`, `evt_meeting_from_seminar`
- `evt_openchat_offered`, `evt_openchat_clicked`
- `evt_meeting_completed`

既存の運用ラベルもフォールバックで読みますが、途中で解除されるため過去到達率には欠損が出ます。新フロー実装時に各到達アクションへ `evt_*` を追加してください。

## ローカル検証

```powershell
node --test tests/*.test.mjs
node --check scripts/sync-dashboard.mjs
```

本番同期はSecretsがあるGitHub Actionsで実行します。ローカルに秘密情報を書かないでください。
