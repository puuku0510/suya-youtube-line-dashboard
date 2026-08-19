# YouTube→LINE / LINEファネル集計

既存の公開ダッシュボードを維持したまま、UTAGEの集計値を兼子さん用Google Sheetへ渡すリポジトリです。

## 更新

- GitHub Actions: 毎日 00:00 / 12:00 JST、手動実行も可
- 必須Secrets: 既存の `UTAGE_API_KEY`, `YOUTUBE_API_KEY`
- 公開ファイルは集計値のみ。氏名、メール、LINE ID、共通読者ID、APIキーは出力しません。

## ファネル用公開集計

- `funnel-current.csv`: 現在ステージ×処理状態の人数
- `funnel-cohort.csv`: 互換用の既存コホート集計。先頭の `registration_date` は実際には最古シナリオ読者登録日のproxyで、LINE友だち追加日の証明ではありません
- `funnel-cohort-quality.csv`: proxy日付の根拠、イベント時刻coverage、観測時点でのD+7分母候補、D+7非確定フラグを含む安全な移行用集計
- `funnel-sync-health.csv`: ラベル取得率、未分類人数、イベント時刻coverage、API使用量・429、同期状態

Google Sheetは上記CSVを `IMPORTDATA` で読み込みます。オプチャの自動指標は実参加ではなくリンククリックです。

`funnel-cohort-quality.csv` の `d7_denominator_eligible_proxy=1` は、proxy日付から7日経過したという意味だけです。イベント発生時刻が揃うまで `d7_outcome_exact` は0で、正式D+7 CVRには使いません。Google Sheetsの `IMPORTDATA` には表示遅延があり得るため、必ず `snapshot_at` を併記します。

## 計測ラベル

コホート分析では、到達後も削除しない `evt_*` ラベルを正本とします。

- `evt_zoom_applied`
- `evt_seminar_applied`
- `evt_vsl_offered`, `evt_vsl_started`, `evt_vsl_completed`
- `evt_meeting_applied`, `evt_meeting_from_vsl`, `evt_meeting_from_seminar`
- `evt_openchat_offered`, `evt_openchat_clicked`
- `evt_meeting_completed`

既存の運用ラベルもフォールバックで読みますが、途中で解除されるため過去到達率には欠損が出ます。共通読者ラベルAPIの `assigned_at` が取れた行は時刻coverageへ反映しますが、現在snapshotだけでは解除済み履歴を復元できません。新フローは各到達アクションへ解除しない `evt_*` とappend-only webhookを追加し、APIは照合に使います。

## データ契約上の注意

- `/readers` の `created_at` はシナリオ読者登録日時。LINE follow日時と呼びません
- LINE友だち一覧の公開schemaだけでは `common_reader_id` とlabelsを保証できません。結合はライブ契約テスト完了までpartialです
- 顧客単位ID、氏名、メール、LINE ID、APIキーは公開CSVへ出しません
- 現在値を毎日の新規イベントとして加算しません

## ローカル検証

```powershell
node --test tests/*.test.mjs
node --check scripts/sync-dashboard.mjs
```

本番同期はSecretsがあるGitHub Actionsで実行します。ローカルに秘密情報を書かないでください。
