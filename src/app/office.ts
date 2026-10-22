/**
 * 事務所の情報（事務所名・ロゴ・資格と氏名・設計者）をブラウザに覚え、新しいプロジェクトでも表題欄・ヘッダーに自動で入れる。
 * プロジェクトファイルに保存した値が優先。空欄のときだけ前回の値を使う
 */
import { state } from './state';

const KEY = 'officeInfo';

interface OfficeInfo {
  company?: string;
  logo?: string;
  license?: string;
  designer?: string;
}

export function rememberOffice() {
  try {
    const cur: OfficeInfo = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const next: OfficeInfo = {
      company: state.company || cur.company,
      logo: state.logo || cur.logo,
      license: state.license || cur.license,
      designer: state.designer || cur.designer,
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 保存できない環境（プライベートウィンドウなど）
  }
}

/** 空欄の項目を前回の値で埋める */
export function restoreOffice() {
  try {
    const saved: OfficeInfo = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!state.company && saved.company) state.company = saved.company;
    if (!state.logo && saved.logo) state.logo = saved.logo;
    if (!state.license && saved.license) state.license = saved.license;
    if (!state.designer && saved.designer) state.designer = saved.designer;
  } catch {
    // 読めない環境
  }
}

/** 「ロゴを外す」などで消したときは覚えた値も消す */
export function forgetOfficeLogo() {
  try {
    const cur: OfficeInfo = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    delete cur.logo;
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    // 保存できない環境
  }
}
