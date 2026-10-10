# PLATEAU 3D Tiles のテスト用データ（tests/fixtures/plateau/）

このディレクトリの `.b3dm`・`tileset.json`・`latest_*.json` は、国土交通省 **PLATEAU（3D都市モデル）** の建築物モデル（3D Tiles 配信）から
`node scripts/plateau-fixture.mjs` で取得したものです（引数なしで下の一式を取り直せます）。テスト（`tests/plateau*.test.ts`）だけに使い、
合計 400 KB 以下に抑えます（2026-10-10 取得時点で 359 KB）。

## 出典と利用規約

- 出典: 国土交通省 PLATEAU 「3D都市モデル（Project PLATEAU）」 https://www.mlit.go.jp/plateau/
  - 配信: https://assets.cms.plateau.reearth.io/ （データカタログ API・`-latest` エイリアス: https://api.plateauview.mlit.go.jp/ ）
  - データセット: 「3D都市モデル（Project PLATEAU）名古屋市（2022年度）」「3D都市モデル（Project PLATEAU）東京都（2025年度）」
- 利用規約: PLATEAU 利用規約（政府標準利用規約（第 2.0 版）に準拠、CC BY 4.0 互換）。出典の表記が必要です。
  https://www.mlit.go.jp/plateau/site-policy/
- 本リポジトリでの出典表記: 「出典: 国土交通省 PLATEAU 3D都市モデル（{市区}・{年度}年度・LOD{n}）」（README・レポート・日影図の脚注）
- 逆ジオコーダの応答（`geocoder_*.json`）は国土地理院「逆ジオコーダ API」 https://mreversegeocoder.gsi.go.jp/ の出力です
  （国土地理院コンテンツ利用規約 https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html ）。

## ファイル一覧（2026-10-10 取得）

| ファイル | 内容 | サイズ | 取得元 URL |
| --- | --- | --- | --- |
| `23113_lod1_data0.b3dm` | 名古屋市守山区 LOD1 の葉タイル（深さ 4・6 棟・底面あり）… 正例 | 30.2 KB | https://assets.cms.plateau.reearth.io/assets/42/4f909f-374b-4fae-8dde-1023720e7ea5/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23113_moriyama-ku_lod1/data/data0.b3dm |
| `23102_lod2nt_data1.b3dm` | 名古屋市東区 LOD2（テクスチャ無し）深さ 2 の内部ノード（18 棟・底面なし）… noBottom の負例 | 90.2 KB | https://assets.cms.plateau.reearth.io/assets/f5/70535e-559f-4479-acee-b49051d3afb0/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23102_higashi-ku_lod2_no_texture/data/data1.b3dm |
| `23102_lod2nt_data55.b3dm` | 名古屋市東区 LOD2（テクスチャ無し）の root（20 棟・LOD2 5 棟・簡略形状）… baseMismatch の負例 | 100.3 KB | https://assets.cms.plateau.reearth.io/assets/f5/70535e-559f-4479-acee-b49051d3afb0/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23102_higashi-ku_lod2_no_texture/data/data55.b3dm |
| `23102_lod2nt_tileset.json` | 名古屋市東区 LOD2（テクスチャ無し）の tileset.json（56 ノード・葉 40・深さ 3） | 33.5 KB | https://assets.cms.plateau.reearth.io/assets/f5/70535e-559f-4479-acee-b49051d3afb0/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23102_higashi-ku_lod2_no_texture/tileset.json |
| `23113_lod1_tileset.json` | 名古屋市守山区 LOD1 の tileset.json（170 ノード・葉 119・深さ 4） | 99.4 KB | https://assets.cms.plateau.reearth.io/assets/42/4f909f-374b-4fae-8dde-1023720e7ea5/23100_nagoya-shi_city_2022_citygml_4_op_bldg_3dtiles_23113_moriyama-ku_lod1/tileset.json |
| `latest_13112_lod2nt.json` | `-latest` エイリアスのラッパー（世田谷区 LOD2 テクスチャ無し。`root.children[0].content.uri` に実 tileset.json の絶対 URL） | 0.5 KB | https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13112-bldg-lod2-notexture-latest/tileset.json |
| `latest_missing.json` | `-latest` エイリアスでデータセットが無いときの応答（川越市 11201。200 で `children` 無し・region は日本全体） | 0.2 KB | https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/11201-bldg-lod2-notexture-latest/tileset.json |
| `index.mini.json` | `public/plateau-index.json`（2026-10-10 生成）の 13112・23102・23113 だけの抜粋（形は同じ） | 2.0 KB | public/plateau-index.json から抜粋（カタログ: https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets ） |
| `geocoder_okusawa.json` | 逆ジオコーダ応答: 世田谷区奥沢 35.6019,139.6736 → muniCd 13112 | 0.1 KB | https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=35.6019&lon=139.6736 |
| `geocoder_nagoya_border.json` | 逆ジオコーダ応答: 名古屋の区境 35.1932,136.9545 → muniCd 23113（守山区。東区ではない） | 0.0 KB | https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=35.1932&lon=136.9545 |
| `mini_tileset.json` | 手書き（W3）: 3 階層・REPLACE・葉 2・box 1・transform 1・外部 .json 1（warnings の分岐） | — | — |

データセットの URL はハッシュ付きで年度更新のたびに変わります。取り直すときは `node scripts/plateau-fixture.mjs` を実行し、この表のサイズと URL を更新してください。

### b3dm の中身（テストが前提にしている実測値）

- `23113_lod1_data0.b3dm`: featureTable `{ BATCH_LENGTH: 6 }`、batchTable JSON 21,656 B・バイナリ 496 B・glb 8,756 B。
  `gml_id`・`city_name`・`bldg:usage` などは JSON の配列列、`bldg:measuredHeight`・`_x`・`_y`・`_xmin`〜`_zmax` は DOUBLE、
  `_lod`・`uro:BuildingIDAttribute_uro:branchID` は BYTE のバイナリ参照列（`{ byteOffset, componentType, type: 'SCALAR' }`）。
  `attributes` 列は 1 棟あたり数 KB の JSON オブジェクト（`numbers()`/`strings()` では読まない）。
- `23102_lod2nt_data1.b3dm`: 18 棟、`_lod` は全棟 1（深さ 2 の内部ノードで底面が無い）。
- `23102_lod2nt_data55.b3dm`: 20 棟、`_lod` に 2 が 5 棟（root の簡略形状）。
