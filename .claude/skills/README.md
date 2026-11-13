# 取り込んだスキル

X の記事「Claude Skills 67 選」（2026-04、@claudecode_love。元は @polydao の投稿）で紹介されたスキルのうち、このリポジトリで役に立ち、中身を読んで安全を確かめたものを置いている（2026-11-13）。

記事のころから配布元が作り直されていて、名前が変わったもの・無くなったものがある。ここにあるのは 2026-11-13 時点の現行版。

このリポジトリでの使い方の決まり（日本語でやり取り・仕様書の置き場所など）は `CLAUDE.md` の「Agent skills」、`docs/agents/issue-tracker.md`、`docs/agents/domain.md`。

## 自分で呼ぶもの（`/名前` と打つ）

| 呼び方 | 何をするか | 記事での名前 |
| --- | --- | --- |
| `/grill-me` | これから作るもの・決めることについて、質問攻めにして詰める。質問ごとにおすすめの答えが付くので「はい」で進められる | Grill Me |
| `/grill-with-docs` | `/grill-me` に加えて、固まった用語を用語集（`GLOSSARY.md`）に、大きな決定を `docs/adr/` に残す | Ubiquitous Language |
| `/to-spec` | いまの会話を仕様書にまとめる（`docs/specs/<機能>/spec.md`） | Write a PRD、Request Refactor Plan |
| `/to-tickets` | 仕様書や会話を、1 つずつ動く形で確かめられる小さな作業（チケット）に分ける（`docs/specs/<機能>/issues/`） | PRD to Plan、PRD to Issues、QA |
| `/improve-codebase-architecture` | コードの作りの弱い所を探し、直す候補を図入りのレポートで出す。選んだ候補を一緒に詰める | Improve Codebase Architecture、Request Refactor Plan |

## 場面に合わせて自動で使われるもの

| 名前 | いつ使われるか | 記事での名前 |
| --- | --- | --- |
| `grilling` | `/grill-me`・`/grill-with-docs` の本体 | Grill Me |
| `tdd` | 「テストを先に書いて」と頼んだとき。良いテストの書き方と進め方 | TDD |
| `diagnosing-bugs` | むずかしい不具合・重くなった原因を調べるとき。まず「不具合を確実に再現する仕組み」を作ってから原因を絞る | Triage Issue に当たるもの |
| `systematic-debugging` | 不具合・テストの失敗に当たったとき。当てずっぽうで直さず、原因を突き止めてから 1 つだけ直す | Systematic Debugging |
| `codebase-design` | 部品の分け方・つなぎ方を決めるとき。別々の案を複数出して比べるやり方も入っている | Design an Interface |
| `domain-modeling` | 言葉の使い方があいまいなとき、用語集・決定の記録を書くとき | Ubiquitous Language |
| `writing-for-agents` | スキルや `CLAUDE.md` を書く・直すとき | Write a Skill |
| `frontend-design` | 画面・資料の見た目を新しく作る、作り直すとき。ありがちな既製の見た目を避ける | Frontend Design |

## もとから使えるもの（置いていない）

Claude 側（アカウントのスキル・組み込み）に同じものが入っているので、ここには置いていない。

| 記事での名前 | 使い方 |
| --- | --- |
| Skill Creator | 「スキルを作って」と頼む（`skill-creator`） |
| Code Review | `/code-review` |
| PDF・DOCX・PPTX・XLSX | ファイルを渡して頼む（`pdf`・`docx`・`pptx`・`xlsx`） |

## 出どころ

`agents/openai.yaml`（Codex 用の設定）を除いたほかは、配布元のファイルをそのまま置いている。書き換えていない。

| 配布元 | 版（コミット・日付） | ライセンス | 入れたスキル |
| --- | --- | --- | --- |
| [mattpocock/skills](https://github.com/mattpocock/skills) | `5863806`（2026-11-12） | MIT（`LICENSE-mattpocock-skills.txt`） | grill-me、grilling、grill-with-docs、to-spec、to-tickets、codebase-design、tdd、diagnosing-bugs、improve-codebase-architecture、domain-modeling、writing-for-agents |
| [obra/superpowers](https://github.com/obra/superpowers) | `22f0b46`（2026-11-03） | MIT（`LICENSE-obra-superpowers.txt`） | systematic-debugging |
| [anthropics/skills](https://github.com/anthropics/skills) | `2c5958e`（2026-11-06） | Apache-2.0（`frontend-design/LICENSE.txt`） | frontend-design |

## 入れなかったもの

| 記事での名前 | 入れなかった理由 |
| --- | --- |
| Git Guardrails | `git push` を止める仕掛け。このリポジトリは「コミットしたら必ずプッシュ（本番が自動で更新）」なので、ぶつかる |
| Setup Pre-Commit | コミットのたびに整形・型チェック・テストを走らせる仕掛けをリポジトリに入れる。提出前の点検は `CLAUDE.md` の手順で行っていて、コミットが毎回遅くなる |
| Superpowers（一式） | 入れると毎回の会話の最初に「必ずスキルを確認する」という指示が差し込まれ、進め方全体が変わる。`CLAUDE.md` の進め方と重なるので、中から Systematic Debugging だけを入れた |
| Auto-Commit Messages | 記事のリンク先（anthropics/skills の auto-commit）が、現行の配布元に無い。コミットの書き方は `CLAUDE.md` で決めている |
| Triage Issue・QA（の課題管理の部分） | 現行版（`triage`）は、たまった課題にラベルを付けて仕分ける道具。このリポジトリは課題の一覧を持たず、進み具合は `PROGRESS.md` に書いている |
| Edit Article・Obsidian Vault | 配布元から削除された（作者の個人用だった） |
| Find Skills | スキルではなく、探すためのサイト（skillsmp.com）の紹介 |
| Theme Factory・Brand Guidelines | 前者は既製の配色テーマ 10 種を当てる道具、後者は Anthropic 社自身の色と書体を当てる道具。御社のテイストは `docs/HOMELANDICK_STYLE.md` で決めている |
| Web Artifacts Builder | claude.ai の画面の中で動く Web アプリ（React）を作るための道具。このツールの作りとは別物 |
| Doc Co-Authoring | 配布元のこのスキルにはライセンスの表示が無いので、リポジトリには写していない |
| Dependency Auditor・API Documentation Generator | 記事のリンクが配布元のトップページで、どのスキルかが示されていない。依存パッケージの点検は、頼まれたときに `npm audit` で足りる |
| Stripe Integration・Marketing Skills・Claude SEO・Domain Name Brainstormer | 決済・集客・SEO・ドメイン名。このツールの開発では使わない（Marketing Skills は記事によると 20 個以上のスキル集で、入れるとその分、常に読み込まれる説明文が増える） |
| Stochastic Multi-Agent Consensus・Model-chat | 同じ問題を多数のエージェントに解かせる・討論させる道具。利用量が大きく増える |
| Firecrawl | Web ページを読み取る外部サービス。登録と API キーが要り、このツールの開発では使わない |

## 更新のしかた

配布元の新しい版に合わせたいときは「スキルを最新にして」と頼む。配布元を取り直し、差分を読んでから置き換え、この表の版を書き直す。
