/**
 * pdf.js（legacy ビルド）は Node では @napi-rs/canvas から DOMMatrix / Path2D / ImageData を取る。
 * Vercel の関数にはその native パッケージが同梱されないため、読み込みの時点で `new DOMMatrix()` が落ちる
 * （FUNCTION_INVOCATION_FAILED）。図面の読み取りは線と文字を取り出すだけで描画はしないので、
 * 最小の DOMMatrix を先に置いておく。pdf.js を import する前に、このモジュールを import すること。
 */
if (!globalThis.DOMMatrix) {
  class DOMMatrix {
    constructor(init) {
      const m = Array.isArray(init) && init.length >= 6 ? init : init instanceof DOMMatrix ? [init.a, init.b, init.c, init.d, init.e, init.f] : [1, 0, 0, 1, 0, 0];
      [this.a, this.b, this.c, this.d, this.e, this.f] = m.map(Number);
      this.is2D = true;
    }
    static fromMatrix(o) {
      return new DOMMatrix([o.a, o.b, o.c, o.d, o.e, o.f]);
    }
    multiply(o) {
      return new DOMMatrix([
        this.a * o.a + this.c * o.b,
        this.b * o.a + this.d * o.b,
        this.a * o.c + this.c * o.d,
        this.b * o.c + this.d * o.d,
        this.a * o.e + this.c * o.f + this.e,
        this.b * o.e + this.d * o.f + this.f,
      ]);
    }
    multiplySelf(o) {
      return this.#assign(this.multiply(o));
    }
    preMultiplySelf(o) {
      return this.#assign(new DOMMatrix(o).multiply(this));
    }
    translate(tx = 0, ty = 0) {
      return this.multiply(new DOMMatrix([1, 0, 0, 1, tx, ty]));
    }
    translateSelf(tx = 0, ty = 0) {
      return this.#assign(this.translate(tx, ty));
    }
    scale(sx = 1, sy = sx) {
      return this.multiply(new DOMMatrix([sx, 0, 0, sy, 0, 0]));
    }
    scaleSelf(sx = 1, sy = sx) {
      return this.#assign(this.scale(sx, sy));
    }
    inverse() {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return new DOMMatrix([NaN, NaN, NaN, NaN, NaN, NaN]);
      return new DOMMatrix([this.d / det, -this.b / det, -this.c / det, this.a / det, (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det]);
    }
    invertSelf() {
      return this.#assign(this.inverse());
    }
    toFloat32Array() {
      return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]);
    }
    #assign(o) {
      this.a = o.a;
      this.b = o.b;
      this.c = o.c;
      this.d = o.d;
      this.e = o.e;
      this.f = o.f;
      return this;
    }
  }
  globalThis.DOMMatrix = DOMMatrix;
}
