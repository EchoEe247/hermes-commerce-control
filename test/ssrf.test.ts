import test from "node:test";
import assert from "node:assert/strict";
import {
  isBlockedAddress,
  assertPublicAddress,
  assertAllowedUrl,
  BLOCKED_HOSTNAMES,
} from "../src/network/ssrf.js";

test("ssrf: loopback IPv4 is blocked", () => {
  for (const ip of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "127.1"]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test("ssrf: private IPv4 ranges are blocked", () => {
  for (const ip of [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.20.10.5",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.1.100",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.0.1",
    "198.18.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test("ssrf: cloud metadata address is blocked", () => {
  assert.equal(isBlockedAddress("169.254.169.254"), true);
});

test("ssrf: public IPv4 is allowed", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "104.18.32.7", "172.32.0.1", "11.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test("ssrf: IPv6 loopback, ULA and link-local are blocked", () => {
  for (const ip of [
    "::1",
    "::",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "fe80::abcd",
    "febf::1",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test("ssrf: IPv4-mapped and IPv4-compatible IPv6 forms are blocked", () => {
  for (const ip of [
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test("ssrf: public IPv6 is allowed", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test("ssrf: assertPublicAddress throws SSRF_BLOCKED for a private target", () => {
  assert.throws(() => assertPublicAddress("127.0.0.1"), /SSRF_BLOCKED/);
  assert.throws(() => assertPublicAddress("::1"), /SSRF_BLOCKED/);
  assert.doesNotThrow(() => assertPublicAddress("1.1.1.1"));
});

test("ssrf: local hostnames are blocked by name", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    "localhost.localdomain",
    "ip6-localhost",
    "127.0.0.1",
    "[::1]",
  ]) {
    assert.throws(
      () => assertAllowedUrl(`http://${host}/x`),
      /SSRF_BLOCKED/,
      `${host} must be blocked`,
    );
  }
  assert.ok(BLOCKED_HOSTNAMES.has("localhost"));
});

test("ssrf: .local and .internal suffixes are blocked", () => {
  for (const host of ["printer.local", "svc.internal", "db.localdomain", "api.home.arpa"]) {
    assert.throws(() => assertAllowedUrl(`https://${host}/x`), /SSRF_BLOCKED/, host);
  }
});

test("ssrf: non-http schemes are rejected", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
    "data:text/plain,hi",
    "unix:/var/run/docker.sock",
    "jar:http://example.com/!/",
  ]) {
    assert.throws(() => assertAllowedUrl(url), /SSRF_BLOCKED|INVALID_URL/, url);
  }
});

test("ssrf: embedded credentials in a URL are rejected", () => {
  assert.throws(() => assertAllowedUrl("https://user:pass@example.com/x"), /SSRF_BLOCKED/);
});

test("ssrf: a public https URL passes", () => {
  assert.doesNotThrow(() => assertAllowedUrl("https://api.cdp.coinbase.com/platform/v2/x402/discovery/"));
  assert.doesNotThrow(() => assertAllowedUrl("https://agent402.tools/api/find?q=data"));
});

test("ssrf: decimal, octal and hex IPv4 encodings of loopback are blocked", () => {
  // 2130706433 == 0x7f000001 == 127.0.0.1
  for (const host of ["2130706433", "0x7f000001", "017700000001", "0177.0.0.1"]) {
    assert.throws(
      () => assertAllowedUrl(`http://${host}/x`),
      /SSRF_BLOCKED/,
      `${host} must be blocked`,
    );
  }
});

test("ssrf: an empty or malformed host is rejected", () => {
  for (const url of ["http:///x", "http://./x", "http://../x"]) {
    assert.throws(() => assertAllowedUrl(url), /SSRF_BLOCKED|INVALID_URL/, url);
  }
});
