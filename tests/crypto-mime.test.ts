import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptJson, encryptJson, verifySvixSignature } from "@/lib/crypto";
import { buildMimeMessage } from "@/lib/mime";

describe("crypto", () => {
  it("cifra e decifra tokens; segredo curto é recusado", () => {
    const secret = "um-segredo-bem-comprido-123";
    const enc = encryptJson({ access_token: "abc", refresh_token: "r" }, secret);
    assert.ok(enc.startsWith("v1."));
    assert.deepEqual(decryptJson(enc, secret), { access_token: "abc", refresh_token: "r" });
    assert.throws(() => decryptJson(enc, "outro-segredo-comprido-xyz"));
    assert.throws(() => encryptJson({}, "curto"));
  });

  it("verifica assinatura Svix: válida, forjada, repetida (timestamp velho)", () => {
    const raw = crypto.randomBytes(24);
    const secret = `whsec_${raw.toString("base64")}`;
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
    const id = "msg_1";
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const sig = crypto.createHmac("sha256", raw).update(`${id}.${ts}.${body}`).digest("base64");

    assert.deepEqual(verifySvixSignature(secret, { id, timestamp: ts, signature: `v1,${sig}` }, body, 300, now), { ok: true });
    // várias assinaturas no cabeçalho (rotação de segredo)
    assert.deepEqual(verifySvixSignature(secret, { id, timestamp: ts, signature: `v1,AAAA v1,${sig}` }, body, 300, now), { ok: true });
    assert.equal(verifySvixSignature(secret, { id, timestamp: ts, signature: `v1,${sig}` }, body + " ", 300, now).ok, false);
    assert.equal(verifySvixSignature(secret, { id: "outro", timestamp: ts, signature: `v1,${sig}` }, body, 300, now).ok, false);
    const old = String(Math.floor(now / 1000) - 3600);
    const oldSig = crypto.createHmac("sha256", raw).update(`${id}.${old}.${body}`).digest("base64");
    assert.equal(verifySvixSignature(secret, { id, timestamp: old, signature: `v1,${oldSig}` }, body, 300, now).ok, false, "replay antigo");
    assert.equal(verifySvixSignature(secret, { id: null, timestamp: ts, signature: null }, body, 300, now).ok, false);
  });
});

describe("mime", () => {
  it("monta multipart com anexo e impede injeção de cabeçalho", () => {
    const msg = buildMimeMessage({
      from: "a@b.com",
      to: "vagas@x.com\r\nBcc: espiao@y.com",
      subject: "Candidatura — Ação\nX-Injected: 1",
      text: "corpo",
      html: "<p>corpo</p>",
      messageId: "app_1@b.com",
      attachment: { filename: "cv.pdf", content: new TextEncoder().encode("%PDF-1.4"), contentType: "application/pdf" },
    });
    assert.match(msg, /^To: vagas@x\.com Bcc: espiao@y\.com\r\n/m);
    assert.doesNotMatch(msg, /\nBcc:/);
    assert.doesNotMatch(msg, /\nX-Injected:/);
    assert.match(msg, /Subject: =\?UTF-8\?B\?/);
    assert.match(msg, /Content-Disposition: attachment; filename="cv\.pdf"/);
    assert.match(msg, new RegExp(Buffer.from("%PDF-1.4").toString("base64")));
  });
});
