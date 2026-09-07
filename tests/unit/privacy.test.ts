// Pure-function tests for what leaves the browser. Run: npm test
// (Node ≥ 22.6 strips the types; no bundler, no browser.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutgoingMap,
  isExcludedUrl,
  isPrivateHost,
  mapProposalBack,
  outgoingKey,
  parseExcludedDomains,
  redactTitle,
  redactUrlForSending,
} from "../../src/sidepanel/domain/privacy.ts";

test("parseExcludedDomains: newlines, commas, schemes and paths are tolerated", () => {
  assert.deepEqual(
    parseExcludedDomains("Bank.example.com\nhttps://www.mail.google.com/inbox, intranet"),
    ["bank.example.com", "mail.google.com", "intranet"]
  );
});

test("isExcludedUrl: exact host and subdomains match, lookalikes don't", () => {
  const d = ["bank.example.com"];
  assert.equal(isExcludedUrl("https://bank.example.com/x", d), true);
  assert.equal(isExcludedUrl("https://online.bank.example.com/x", d), true);
  assert.equal(isExcludedUrl("https://notbank.example.com/x", d), false);
  assert.equal(isExcludedUrl("https://example.com/bank.example.com", d), false);
  assert.equal(isExcludedUrl("not a url", d), false);
});

test("isPrivateHost: loopback, RFC1918, .local/.internal, bare intranet names", () => {
  for (const u of [
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://10.1.2.3/admin",
    "http://192.168.1.10/",
    "http://172.16.5.5/",
    "http://nas.local/",
    "https://wiki.internal/",
    "http://intranet/",
  ]) assert.equal(isPrivateHost(u), true, u);
  for (const u of ["https://example.com/", "https://172.32.0.1/", "https://8.8.8.8/", "https://internal.example.com/"])
    assert.equal(isPrivateHost(u), false, u);
});

test("redactUrlForSending: credentials always go; query/fragment go when stripping", () => {
  assert.equal(
    redactUrlForSending("https://user:pa55@example.com/a?b=1#c", false),
    "https://example.com/a?b=1#c"
  );
  assert.equal(redactUrlForSending("https://example.com/a?b=1#c", true), "https://example.com/a");
});

test("redactUrlForSending: token-like path segments are masked, ordinary paths kept", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.equal(redactUrlForSending(`https://app.example.com/reset/${jwt}`, true), "https://app.example.com/reset/~");
  assert.equal(
    redactUrlForSending("https://api.example.com/v1/users/3f2a9c1e-7b4d-4c8e-9a1f-2b3c4d5e6f70/keys", true),
    "https://api.example.com/v1/users/~/keys"
  );
  assert.equal(
    redactUrlForSending("https://files.example.com/d/0123456789abcdef0123456789abcdef", true),
    "https://files.example.com/d/~"
  );
  assert.equal(
    redactUrlForSending("https://github.com/KucherenkoSerhiy/tab-librarian/issues/12", true),
    "https://github.com/KucherenkoSerhiy/tab-librarian/issues/12"
  );
  assert.equal(
    redactUrlForSending("https://developer.mozilla.org/en-US/docs/Web/API/DataTransfer", true),
    "https://developer.mozilla.org/en-US/docs/Web/API/DataTransfer"
  );
});

test("redactTitle: emails and long digit runs are masked, normal titles untouched", () => {
  assert.equal(redactTitle("Invoice for jane.doe@example.com – Acme"), "Invoice for [email] – Acme");
  assert.equal(redactTitle("Account 1234 5678 9012 3456 – MyBank"), "Account [number] – MyBank");
  assert.equal(redactTitle("Order #4521 confirmed"), "Order #4521 confirmed");
  assert.equal(redactTitle("TypeScript 5.4 release notes (2024)"), "TypeScript 5.4 release notes (2024)");
});

test("buildOutgoingMap: deterministic, unique, and maps back", () => {
  const urls = ["https://youtube.com/watch?v=b", "https://youtube.com/watch?v=a", "https://example.com/x?q=1"];
  const m1 = buildOutgoingMap(urls, true);
  const m2 = buildOutgoingMap([...urls].reverse(), true);
  assert.deepEqual([...m1.sentFor.entries()], [...m2.sentFor.entries()]);
  const sent = [...m1.sentFor.values()];
  assert.equal(new Set(sent).size, sent.length, "sent URLs must be unique");
  for (const real of urls) assert.equal(m1.realFor.get(m1.sentFor.get(real)!), real);
  assert.equal(m1.sentFor.get("https://example.com/x?q=1"), "https://example.com/x");
});

test("mapProposalBack: every URL the model echoes resolves to the real one", () => {
  const map = buildOutgoingMap(["https://a.com/p?id=1", "https://b.com/q?id=2"], true);
  const back = mapProposalBack(
    {
      folders: [{ path: ["X"], tabs: [{ url: "https://a.com/p", title: "A" }], note: "" }],
      questions: [{ url: "https://b.com/q", question: "?" }],
      removals: [{ url: "https://unknown.com/z", reason: "r" }],
    },
    map
  );
  assert.equal(back.folders[0]!.tabs[0]!.url, "https://a.com/p?id=1");
  assert.equal(back.questions[0]!.url, "https://b.com/q?id=2");
  assert.equal(back.removals[0]!.url, "https://unknown.com/z");
});

test("outgoingKey: order-independent, content-sensitive", () => {
  assert.equal(outgoingKey(["a", "b"]), outgoingKey(["b", "a"]));
  assert.notEqual(outgoingKey(["a", "b"]), outgoingKey(["a", "c"]));
});
