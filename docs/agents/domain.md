# 用語集と決定の記録（スキル用）

スキル（`domain-modeling`・`tdd`・`diagnosing-bugs`・`improve-codebase-architecture`・`to-spec`・`to-tickets` など）が、このリポジトリの言葉と過去の決定をどう読むか。

## 置き場所（single-context）

- 用語集: リポジトリ直下の `GLOSSARY.md`
- 決定の記録（ADR）: `docs/adr/0001-<名前>.md` からの連番

どちらもまだ無い。最初の用語・決定が固まったときに作る（先回りして作らない。無いことを指摘もしない）。

## 調べる前に読む

- `GLOSSARY.md` と、触る範囲に関係する `docs/adr/`（あれば）
- このリポジトリでは次も言葉と決定の元になる
  - `CLAUDE.md`（目線・決まっていること）と `PROGRESS.md`（方針転換・やめた機能）
  - `docs/WOOD_HOUSE_RULES.md`・`docs/HOUSE_SENSE.md`・`docs/ARCHITREND.md`（木造住宅・図面の言葉）
  - `docs/HOMELANDICK_STYLE.md`（御社のテイスト）

## 言葉をそろえる

- 仕様書・チケット・テスト名・提案で住宅や図面の言葉を使うときは、用語集の言い方に合わせる。用語集が「避ける」とした言い換えは使わない。
- 必要な言葉が用語集に無いときは、このプロジェクトで使っていない言葉を持ち込んでいないか見直す。本当に足りないなら `/grill-with-docs`（`domain-modeling`）で足す。
- 用語集は日本語で、社内向けの正確な用語で書く（お客様向けの言い換えがあれば併記）。実装の詳細は書かない。

## 過去の決定と食い違うとき

黙って上書きせず、はっきり書く: 「ADR-0007 と食い違うが、〜のため見直す価値がある」
