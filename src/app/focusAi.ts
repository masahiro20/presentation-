/**
 * 参考画像から、こだわり指定の中身（階段のつくり・桁・手すり・踏板の色・段数／吹抜の手すり／造作の形／照明の雰囲気、仕上げの担当に伝えるひとこと）を AI に読んでもらう。
 * 鍵とモデルは「AI 設計士」と同じ（このブラウザに保存した Google AI Studio の鍵）。押したときだけ、画像を Google の API に送る。
 * 読んだ結果は下書きで、人が確かめてから保存する。
 */
import { GEMINI_BASE, describeHttpError, splitDataUrl } from './aiFinish';
import { cleanLighting, cleanStairLook, FOCUS_GUARDS, FOCUS_PART_LABEL, JOINERY_LABEL, JOINERY_VARIANTS, STAIR_BUILDS, type FocusGuard, type FocusLighting, type FocusPart } from '../core/focus';
import type { BuiltinVariant, StairBuild, StairLook } from '../core/types';

export interface FocusReadRequest {
  part: FocusPart;
  /** 参考画像（data URL。3 枚まで） */
  images: string[];
  /** 先に書いてあるひとこと（あれば、それを踏まえて読む） */
  note?: string;
}

export interface FocusReadResult {
  /** 階段のつくり（家に 1 つ。保存するとコーディネートの「階段」の品目になる） */
  build?: StairBuild;
  /** 階段の手すり・桁・踏板の色・鉄の色・段数 */
  stair?: StairLook;
  /** 吹抜の縁（落下防止）の種類（保存すると、家全体の「納まり」の設定になる） */
  guard?: FocusGuard;
  /** 造作の形 */
  joinery?: BuiltinVariant;
  /** 照明の雰囲気（保存すると、間接照明・ダイニングの照明・照明の色・時間帯の設定になる） */
  lighting?: FocusLighting;
  /** 仕上げの担当に伝えるひとこと */
  note: string;
  /** そう読んだ根拠 */
  reason?: string;
  /** JSON として読めなかったときの生の文章 */
  raw?: string;
  model: string;
}

/** 依頼文（純粋な関数） */
export function buildFocusReadPrompt(req: FocusReadRequest): string {
  const part = FOCUS_PART_LABEL[req.part];
  const lines = [
    'あなたは日本の木造住宅の設計士です。工務店の社内ツールが、提案用の 3D とパースを作っています。',
    `添付は、設計担当が「${part}はこのように提案したい」と選んだ参考画像です。画像の${part}だけを見て、3D とパースの仕上げに反映するための指定を読み取ってください。`,
    '画像に写っている部屋の広さ・間取り・家具は関係ありません（提案する家の間取りは別に決まっています）。',
  ];
  if (req.part === 'stair') {
    lines.push(
      '',
      '階段は次の中から選びます（当てはまるものが無い・見えないときは、その項目を入れない）。',
      'build（つくり）: "steel" = 鉄骨の桁（中央か両側）に踏板を載せた、蹴込みの無い階段／"woodSkeleton" = 木の側板で踏板を支える、蹴込みの無い階段／"box" = 蹴込み板のある箱階段（段の下が閉じている）／"cantilever" = 壁から踏板だけが出る片持ち階段',
      'stringer（鉄骨階段の桁。build が "steel" のときだけ）: "side" = 両側の鋼板のささら桁で踏板を挟む／"center" = 中央の力桁 1 本に踏板を載せる',
      'rail（手すり）: "bar" = 細い鉄の支柱・横桟や丸パイプ／"glass" = ガラスのパネル／"wall" = 腰壁／"wood" = 木の支柱や木の格子／"none" = 手すりが無い',
      'tread（踏板の色）: "oak" = 明るい木（オーク・ナラ）／"walnut" = 濃い茶の木／"white" = 白／"black" = 黒／"mortar" = モルタル・左官のグレー',
      'frame（鉄の骨組み・手すりの色）: "black" = 黒／"white" = 白',
      'steps（段数）: 1 つの階を上がる段数が画像から数えられるときだけ（6〜30 の整数）。途中までしか写っていなければ入れない。',
    );
  }
  if (req.part === 'void') {
    lines.push(
      '',
      '吹抜の 2 階側の縁（落下防止）は次の中から選びます（見えないときは入れない）。',
      'guard: "rail" = 細い鉄の手すり（支柱と横桟）／"half" = 腰壁／"glass" = ガラスの手すり／"halfGlass" = 腰壁の上にガラス／"wall" = 天井までの壁',
    );
  }
  if (req.part === 'joinery') {
    lines.push(
      '',
      '造作（造り付けの家具）は、次の中でいちばん近い形を選びます（どれにも当たらなければ入れない）。',
      ...JOINERY_VARIANTS.map((k) => `joinery: "${k}" = ${JOINERY_LABEL[k]}`),
    );
  }
  if (req.part === 'lighting') {
    lines.push(
      '',
      '照明の雰囲気は、画像から分かる項目だけを入れます（分からない項目は入れない）。',
      'indirect: 天井際・下がり天井の縁・棚の下などの間接照明が効いているか（true / false）',
      'pendant（ダイニングのペンダント）: "ph5" = 白い多層シェード／"dome" = 黒い大きなドーム／"globes" = 乳白ガラスの小さな球が 2〜3 灯',
      'kelvin（光の色）: 2700 = 電球色（赤みのある暖かい光）／3000 = 電球色（標準）／3500 = 温白色（白に近い）',
      'tod（見せたい時間帯）: "day" = 昼の自然光／"evening" = 夕方／"night" = 夜の室内照明',
    );
  }
  lines.push(
    '',
    'note: 素材・色・納まりの要点を、設計士が仕上げの担当に伝える言葉で 60 字以内（例: 「黒皮鉄の桁にオーク無垢の踏板。手すりは細いフラットバーで軽く」）。メーカー名・人名は書かない。',
    ...(req.note?.trim() ? [`設計担当のメモ（これを尊重し、画像で分かることを足す）: ${req.note.trim()}`] : []),
    '',
    '出力は次の JSON だけ（前後に文章やコードフェンスを付けない）。',
    req.part === 'stair'
      ? '{"stair":{"build":"steel","stringer":"side","rail":"bar","tread":"oak","frame":"black","steps":14},"note":"…","reason":"そう読んだ根拠を 1 文"}'
      : req.part === 'void'
        ? '{"guard":"rail","note":"…","reason":"そう読んだ根拠を 1 文"}'
        : req.part === 'joinery'
          ? '{"joinery":"floatTv","note":"…","reason":"そう読んだ根拠を 1 文"}'
          : req.part === 'lighting'
            ? '{"lighting":{"indirect":true,"pendant":"dome","kelvin":2700,"tod":"evening"},"note":"…","reason":"そう読んだ根拠を 1 文"}'
            : '{"note":"…","reason":"そう読んだ根拠を 1 文"}',
  );
  return lines.join('\n');
}

/** generateContent の本文（純粋な関数） */
export function buildFocusReadBody(req: FocusReadRequest): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [{ text: buildFocusReadPrompt(req) }];
  for (const url of req.images.slice(0, 3)) {
    const { mimeType, data } = splitDataUrl(url);
    parts.push({ inline_data: { mime_type: mimeType, data } });
  }
  return { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } };
}

/** 応答の文章から指定を取り出す（純粋な関数）。読めなければ raw に文章を入れて返す */
export function parseFocusReadText(text: string, part: FocusPart, model: string): FocusReadResult {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const body = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  try {
    const js = JSON.parse(body) as { stair?: StairLook & { build?: unknown }; guard?: unknown; joinery?: unknown; lighting?: unknown; note?: unknown; reason?: unknown };
    const stair = part === 'stair' ? cleanStairLook(js.stair) : undefined;
    const build = part === 'stair' && STAIR_BUILDS.includes(js.stair?.build as StairBuild) ? (js.stair!.build as StairBuild) : undefined;
    const guard = part === 'void' && FOCUS_GUARDS.includes(js.guard as FocusGuard) ? (js.guard as FocusGuard) : undefined;
    const joinery = part === 'joinery' && JOINERY_VARIANTS.includes(js.joinery as BuiltinVariant) ? (js.joinery as BuiltinVariant) : undefined;
    const lighting = part === 'lighting' ? cleanLighting(js.lighting) : undefined;
    return {
      ...(build ? { build } : {}),
      ...(stair ? { stair } : {}),
      ...(guard ? { guard } : {}),
      ...(joinery ? { joinery } : {}),
      ...(lighting ? { lighting } : {}),
      note: typeof js.note === 'string' ? js.note.trim().slice(0, 120) : '',
      ...(typeof js.reason === 'string' && js.reason.trim() ? { reason: js.reason.trim().slice(0, 200) } : {}),
      model,
    };
  } catch {
    return { note: '', raw: text.trim().slice(0, 1000), model };
  }
}

export function parseFocusReadResponse(js: unknown, part: FocusPart, model: string): FocusReadResult {
  const r = js as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  if (r.promptFeedback?.blockReason) throw new Error(`安全性の判定で止められました（${r.promptFeedback.blockReason}）`);
  const text = (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n');
  if (!text.trim()) throw new Error(`文章が返りませんでした（${r.candidates?.[0]?.finishReason ?? '理由不明'}）`);
  return parseFocusReadText(text, part, model);
}

/** 参考画像を読んでもらう（1 回の呼び出し） */
export async function readFocusImages(key: string, model: string, req: FocusReadRequest, opts: { signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<FocusReadResult> {
  if (!req.images.length) throw new Error('参考画像がありません');
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(buildFocusReadBody(req)),
    signal: opts.signal,
  });
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* 本文なし */
    }
    throw new Error(describeHttpError(res.status, body));
  }
  return parseFocusReadResponse(await res.json(), req.part, model);
}
