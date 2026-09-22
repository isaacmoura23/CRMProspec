import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, isBlockedAddress, validatePublicUrl } from "@/lib/safe-url";

describe("safe-url: bloqueio de SSRF", () => {
  it("bloqueia loopback, redes privadas, link-local e metadados de nuvem", () => {
    for (const ip of ["127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });
  it("bloqueia IPv6 reservado e IPv4 mapeado", () => {
    for (const ip of ["::1", "::", "fe80::1", "fd12:3456::1", "fc00::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });
  it("permite endereços públicos", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "2606:4700:4700::1111", "172.32.0.1", "11.0.0.1"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });
  it("valida URL: esquema, host interno, credenciais, porta", () => {
    assert.equal(validatePublicUrl("https://github.com/x").ok, true);
    assert.equal(validatePublicUrl("file:///etc/passwd").ok, false);
    assert.equal(validatePublicUrl("ftp://example.com").ok, false);
    assert.equal(validatePublicUrl("http://localhost:3000").ok, false);
    assert.equal(validatePublicUrl("http://foo.internal/").ok, false);
    assert.equal(validatePublicUrl("http://metadata.google.internal/computeMetadata").ok, false);
    assert.equal(validatePublicUrl("http://169.254.169.254/latest/meta-data").ok, false);
    assert.equal(validatePublicUrl("http://[::1]/").ok, false);
    assert.equal(validatePublicUrl("http://user:pass@example.com/").ok, false);
    assert.equal(validatePublicUrl("http://example.com:22/").ok, false);
    assert.equal(validatePublicUrl("not a url").ok, false);
  });
  it("canoniza URL removendo fragmento e rastreadores", () => {
    assert.equal(canonicalUrl("https://Example.com/vaga?utm_source=x&id=1#top"), "https://example.com/vaga?id=1");
    assert.equal(canonicalUrl("https://example.com/"), "https://example.com");
  });
});
