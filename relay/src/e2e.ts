import nacl from "tweetnacl";

// E2E 加密封装：tweetnacl box（与 libsodium crypto_box 同构），云桥只见 {n,c} 密文。
// 本文件零 Node 依赖——relay 与 expo-app 各持一份相同拷贝（两边无共享构建链路）。
// 改动任一份时必须同步另一份（expo-app/src/e2e.ts）。

// PRNG 注入：Node 18+ 自带全局 crypto，nacl 默认即可；RN/Hermes 无全局 crypto，
// 必须由宿主调用 setPRNG 注入（expo-crypto），否则 keyPair/randomBytes 直接抛错
type RandomFn = (n: number) => Uint8Array;
export function setRandomBytes(fn: RandomFn): void {
  nacl.setPRNG((x: Uint8Array, n: number) => {
    const b = fn(n);
    x.set(b.subarray(0, n));
  });
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const b1 = b[i]!;
    const b2 = i + 1 < b.length ? b[i + 1]! : null;
    const b3 = i + 2 < b.length ? b[i + 2]! : null;
    s += B64[b1 >> 2];
    s += B64[((b1 & 3) << 4) | (b2 === null ? 0 : b2 >> 4)];
    s += b2 === null ? "=" : B64[((b2 & 15) << 2) | (b3 === null ? 0 : b3 >> 6)];
    s += b3 === null ? "=" : B64[b3! & 63];
  }
  return s;
}

export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("bad base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export interface BoxKeyPair {
  publicKey: string;
  secretKey: string;
}

export function generateKeyPair(): BoxKeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: toB64(kp.publicKey), secretKey: toB64(kp.secretKey) };
}

// 设备 id 由公钥派生：relay 侧无需试解即可 dev → 公钥映射
export function devId(publicKeyB64: string, prefix: "rl" | "ph"): string {
  const hex = [...fromB64(publicKeyB64).slice(0, 8)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}-${hex}`;
}

export interface SealedBox {
  n: string;
  c: string;
}

export function seal(obj: unknown, theirPublicKeyB64: string, mySecretKeyB64: string): SealedBox {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const msg = new TextEncoder().encode(JSON.stringify(obj));
  const c = nacl.box(msg, nonce, fromB64(theirPublicKeyB64), fromB64(mySecretKeyB64));
  return { n: toB64(nonce), c: toB64(c) };
}

export function unseal<T>(box: SealedBox, theirPublicKeyB64: string, mySecretKeyB64: string): T | null {
  const opened = nacl.box.open(
    fromB64(box.c),
    fromB64(box.n),
    fromB64(theirPublicKeyB64),
    fromB64(mySecretKeyB64),
  );
  if (!opened) return null;
  return JSON.parse(new TextDecoder().decode(opened)) as T;
}
