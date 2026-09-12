// #95 新协议全链验证：{dev, box{nonce}} → 回箱 token
import nacl from "tweetnacl";
import { readFileSync, writeFileSync } from "node:fs";
const peersPath = "data/cloud-peers.json";
const peers = JSON.parse(readFileSync(peersPath, "utf8"));
const kp = nacl.box.keyPair();
const b64 = (u8) => Buffer.from(u8).toString("base64");
const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const pub = b64(kp.publicKey), sec = b64(kp.secretKey);
const hex = [...kp.publicKey.slice(0, 8)].map(x => x.toString(16).padStart(2, "0")).join("");
const dev = `wb-t${hex.slice(0, 5)}`;
peers[dev] = { pubkey: pub, paired_at: Date.now() };
writeFileSync(peersPath, JSON.stringify(peers, null, 2));
const rk = JSON.parse(readFileSync("data/cloud-keypair.json", "utf8"));
const relayPub = rk.publicKey;
const seal = (obj, theirPubB64, mySecB64) => {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const c = nacl.box(new TextEncoder().encode(JSON.stringify(obj)), nonce, fromB64(theirPubB64), fromB64(mySecB64));
  return { n: b64(nonce), c: b64(c) };
};
const unseal = (box, theirPubB64, mySecB64) => {
  const m = nacl.box.open(fromB64(box.c), fromB64(box.n), fromB64(theirPubB64), fromB64(mySecB64));
  return m ? JSON.parse(new TextDecoder().decode(m)) : null;
};
try {
  const h = await (await fetch("http://127.0.0.1:8787/api/lan-hello")).json();
  console.log("hello:", h.ok, h.relay_dev);
  const box = seal({ nonce: h.nonce }, relayPub, sec);
  const r = await (await fetch("http://127.0.0.1:8787/api/lan-auth", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dev, box }),
  })).json();
  console.log("auth:", r.ok, r.error ?? "");
  if (r.ok) {
    const out = unseal(r.box, relayPub, sec);
    console.log("token:", out?.token ? "✓ " + out.token.slice(0, 6) + "…" : "FAIL");
  }
} finally {
  delete peers[dev];
  writeFileSync(peersPath, JSON.stringify(peers, null, 2));
}
