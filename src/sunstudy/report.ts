/**
 * 印刷用レポート（A4 横・新しいウィンドウ・印刷ダイアログ）
 *  表紙（案件名・お客様・住所・緯度経度・作成日・会社）、建設地（地図画像・敷地・地盤高・データ出典）、
 *  季節×時刻の比較画像、地面の日照時間マップ、建物の面の日照時間、測定点の表（季節別の日照時間と時間帯）、日影図、前提・注意事項
 *
 * ★ スタブ: 実装は担当エージェントが行う。シグネチャは変えないこと。
 */

/** レポートの HTML 文字列を作る（画像は dataURL を埋め込む） */
export function buildReportHtml(): string {
  throw new Error('not implemented');
}

/** 新しいウィンドウで開いて印刷ダイアログを出す（ポップアップが開けなければ HTML をダウンロード） */
export function openReport(): void {
  throw new Error('not implemented');
}

/** HTML をファイルとして保存 */
export function downloadReport(): void {
  throw new Error('not implemented');
}
