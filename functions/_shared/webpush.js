// Workers-native Web Push sender.
// Implements RFC 8291 (aes128gcm message encryption) + RFC 8292 (VAPID) using
// only WebCrypto, so it runs on the Cloudflare Pages Functions runtime with no
// Node dependencies (the `web-push` npm relies on Node crypto and won't bundle).
//
// Env required: VAPID_PUBLIC (base64url, 65-byte uncompressed P-256 point),
// VAPID_PRIVATE (base64url, the 32-byte private scalar `d`), and optional
// VAPID_SUBJECT (mailto: or https contact). Generate the pair once and store as
// Cloudflare Pages secrets.

const enc = new TextEncoder();

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  const b = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// HKDF-SHA256: Extract(salt, ikm) then Expand(info, length). WebCrypto does both.
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ---- VAPID JWT (ES256) ----
async function importVapidPrivate(vapidPublic, vapidPrivate) {
  const pub = b64urlToBytes(vapidPublic); // 0x04 || x(32) || y(32)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: String(vapidPrivate),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function makeVapidJwt(endpoint, subject, vapidPublic, vapidPrivate) {
  const url = new URL(endpoint);
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: `${url.protocol}//${url.host}`,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  };
  const signingInput =
    bytesToB64url(enc.encode(JSON.stringify(header))) + "." +
    bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await importVapidPrivate(vapidPublic, vapidPrivate);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)));
  return `${signingInput}.${bytesToB64url(sig)}`;
}

// ---- Payload encryption (RFC 8291 / RFC 8188 aes128gcm) ----
export async function encryptPayload(payload, p256dhB64, authB64) {
  const uaPublic = b64urlToBytes(p256dhB64); // 65 bytes
  const authSecret = b64urlToBytes(authB64); // 16 bytes

  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey)); // 65 bytes
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0" || ua_public || as_public)
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // Single record: plaintext followed by the 0x02 last-record delimiter.
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext));

  // aes128gcm header: salt(16) | rs(uint32 BE = 4096) | idlen(1) | keyid(as_public)
  const rs = new Uint8Array([0, 0, 0x10, 0]);
  const idlen = new Uint8Array([asPublic.length]);
  return concat(salt, rs, idlen, asPublic, ciphertext);
}

// Send one push. Returns the fetch Response. Callers should treat 404/410 as a
// dead subscription to prune, and 201/2xx as success.
export async function sendPush(subscription, payload, env) {
  const vapidPublic = env.VAPID_PUBLIC;
  const vapidPrivate = env.VAPID_PRIVATE;
  const subject = env.VAPID_SUBJECT || "mailto:johnsonjacob96@gmail.com";
  if (!vapidPublic || !vapidPrivate) throw new Error("VAPID keys not set");

  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const jwt = await makeVapidJwt(subscription.endpoint, subject, vapidPublic, vapidPrivate);
  const body = await encryptPayload(payloadStr, subscription.p256dh, subscription.auth);

  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
      Authorization: `vapid t=${jwt}, k=${vapidPublic}`,
    },
    body,
  });
}
