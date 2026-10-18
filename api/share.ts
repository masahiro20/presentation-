/**
 * お客様向け「体験リンク」の受け口。
 * ブラウザから Vercel Blob へ直接アップロードするための署名（トークン）を発行する。
 * プロジェクトの中身（図面の読み取り結果・テイスト・画像・動画）はこの関数を通らず、ブラウザから保存先へ直接送られる。
 *
 * 必要な設定: Vercel のプロジェクトに Blob ストアをつなぐ（Storage → Create Database → Blob）。
 * つなぐと BLOB_READ_WRITE_TOKEN が自動で入る。
 */
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: 'no-store', message: 'Vercel の Storage で Blob ストアを作り、このプロジェクトにつないでください（BLOB_READ_WRITE_TOKEN）' });
    return;
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as HandleUploadBody;
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^share\/[a-z0-9]{10,}\/[\w.-]+$/i.test(pathname)) throw new Error('invalid path');
        return {
          allowedContentTypes: ['application/json', 'video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'model/gltf-binary', 'model/vnd.usdz+zip', 'application/octet-stream'],
          addRandomSuffix: false,
          allowOverwrite: true,
          maximumSizeInBytes: 300 * 1024 * 1024,
          tokenPayload: '',
        };
      },
      onUploadCompleted: async () => {},
    });
    res.status(200).json(json);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}
