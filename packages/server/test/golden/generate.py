"""Golden fixtures for the server tests: runs the Python reference modules on synthetic inputs and records what they return.

Usage (the reference folder is the Python project that holds the `engine` package; its interpreter must have `cryptography`):

    python -I generate.py <reference folder> [output file]

Everything here is synthetic: a throw-away Ed25519 key, made-up people, example addresses. The reference constants that carry
product branding (token audience, default source) are overridden below so that only the logic is compared.
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
from pathlib import Path

reference = Path(sys.argv[1]).resolve()
out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name("fixtures.json")
sys.path.insert(0, str(reference))

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

from engine import auth, crm_commit, events, server, settings_store  # noqa: E402

NOW = 1_800_000_000
AUDIENCE = "resume-intake"
auth.AUDIENCE = AUDIENCE
crm_commit.DEFAULT_SOURCE = "Resume intake"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# ── tokens ──────────────────────────────────────────────────────────────────────────────────────────────────────
key = Ed25519PrivateKey.generate()
other = Ed25519PrivateKey.generate()
public_pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def sign(claims, signer=key, ensure_ascii=True) -> str:
    payload = b64url(json.dumps(claims, separators=(",", ":"), ensure_ascii=ensure_ascii).encode("utf-8"))
    return f"{payload}.{b64url(signer.sign(payload.encode('ascii')))}"


def claims(**over):
    base = {"aud": AUDIENCE, "sub": "operator@example.test", "role": "admin", "iat": NOW - 10, "exp": NOW + 900}
    base.update(over)
    return {k: v for k, v in base.items() if v is not ...}


valid = sign(claims())
payload_part, sig_part = valid.split(".")
raw_payload = lambda text: b64url(text.encode("utf-8"))  # noqa: E731


def sign_text(text: str) -> str:
    payload = raw_payload(text)
    return f"{payload}.{b64url(key.sign(payload.encode('ascii')))}"


token_cases = {
    "valid": valid,
    "valid_unicode_raw": sign(claims(sub="José Müller"), ensure_ascii=False),
    "valid_unicode_escaped": sign(claims(sub="José Müller")),
    "valid_extra_claims": sign(claims(scope=["a", "b"], n=1.5)),
    "exp_equals_now": sign(claims(exp=NOW)),
    "exp_one_second_ago": sign(claims(exp=NOW - 1)),
    "exp_float_future": sign(claims(exp=NOW + 0.5)),
    "exp_missing": sign(claims(exp=...)),
    "exp_true": sign_text(json.dumps(claims(exp=True))),
    "exp_string": sign(claims(exp=str(NOW + 900))),
    "exp_null": sign(claims(exp=None)),
    "wrong_role": sign(claims(role="viewer")),
    "role_missing": sign(claims(role=...)),
    "wrong_audience": sign(claims(aud="another-app")),
    "audience_missing": sign(claims(aud=...)),
    "claims_is_list": sign_text("[1,2,3]"),
    "claims_is_string": sign_text('"admin"'),
    "payload_not_json": sign_text("not json at all"),
    "payload_invalid_utf8": f"{b64url(bytes([0xff, 0xfe, 0x7b]))}.{b64url(key.sign(b64url(bytes([0xff, 0xfe, 0x7b])).encode('ascii')))}",
    "signed_by_other_key": sign(claims(), signer=other),
    "tampered_payload": f"{raw_payload(json.dumps(claims(sub='someone@else.example')))}.{sig_part}",
    "signature_truncated": f"{payload_part}.{sig_part[:-4]}",
    "signature_padded": f"{payload_part}.{sig_part}==",
    "signature_length_mod4_is_1": f"{payload_part}.AAAAA",
    "signature_empty": f"{payload_part}.",
    "signature_not_base64url": f"{payload_part}.%%%%",
    "payload_only": payload_part,
    "three_segments": f"{payload_part}.{sig_part}.{sig_part}",
    "empty": "",
    "dots_only": "....",
    "garbage": "garbage",
    "payload_with_padding": f"{payload_part}=.{sig_part}",
    "payload_with_space": f"{payload_part} .{sig_part}",
    "too_long": "A" * 9000 + "." + sig_part,
    "non_ascii": "é." + sig_part,
}
tokens = []
for name, token in token_cases.items():
    result = auth.verify_token(token, key.public_key(), now=NOW)
    tokens.append({"name": name, "token": token, "claims": result})

bearer_cases = [
    "Bearer abc", "bearer abc", "BEARER abc", "  Bearer   abc  ", "Bearer", "Bearer ", "Basic abc", "Bearer a b", "Bearerabc", "",
    "Bearer abc.def-ghi_jkl", "Bearer\tabc",
]
bearer = [{"header": h, "token": auth.bearer_token(h)} for h in bearer_cases]
bearer.append({"header": None, "token": auth.bearer_token(None)})

allowed = ["https://app.example.test", "http://localhost:5173"]
origin_cases = [None, "", "null", "https://app.example.test", "https://app.example.test/", "https://APP.example.test", "http://localhost:5173",
                "http://localhost:9999", "https://app.example.test.evil.test"]
origins = [{"origin": o, "allowed": allowed, "status": auth.origin_status(o, allowed)} for o in origin_cases]

# ── ingestion commit ────────────────────────────────────────────────────────────────────────────────────────────
rows = [
    {"Lead ID": "L-1", "Name": "  Asha   Rao ", "Email Address": " ASHA@Example.TEST ", "Phone Number": "+91 98765 43210",
     "Resume": "https://files.example.test/a", "Current Location": "Pune  City", "Graduation": "B.Tech"},
    {"Lead ID": "L-2", "Name": "Ben Kaur", "Email Address": "", "Phone Number": "(555) 010-2030"},
    {"Lead ID": "L-3", "Name": "Cy Short", "Email Address": "", "Phone Number": "12345"},
    {"Lead ID": "L-4", "Name": "No Contact", "Email Address": "", "Phone Number": ""},
    {"Lead ID": "L-5", "Name": "Not Specified", "Email Address": "ns@example.test", "Phone Number": ""},
    {"Lead ID": "L-6", "Name": "not specified", "Email Address": "", "Phone Number": "9999999999"},
    {"Lead ID": "L-7", "Name": "Zoe M\u00fcller", "Email Address": "zoe@example.test", "Phone Number": None},
    {"Lead ID": "L-\u00e9\U0001f600", "Name": "Emoji Id", "Email Address": "", "Phone Number": "123"},
    {"Name": "No Lead Id", "Email Address": "", "Phone Number": "1234567"},
    {"Lead ID": 12, "Name": "Numeric Lead", "Email Address": "num@example.test"},
    {"Lead ID": "L-8", "Name": "Tab\tSeparated\nName", "Email Address": "tab@example.test"},
]
request_main = crm_commit.parse_request({"enabled": True, "campaignId": 7, "source": "  Demo  ", "stage": " lead "})
items, keys, left_out = crm_commit.build_items(rows, request_main)
build = {"request": request_main, "rows": rows, "items": items, "keys": keys, "leftOut": left_out}

identity_items = [
    {"email": "A@B.test"}, {"email": "", "phone": "+1 (555) 123-4567"}, {"phone": "12345"}, {"phone": "123456", "leadId": "X"},
    {"leadId": "L-9"}, {}, {"phone": "\u0661\u0662\u0663\u0664\u0665\u0666\u0667"},
]
identities = [{"item": i, "key": crm_commit.identity_key(i)} for i in identity_items]

key_sets = [
    (["email:a@x.test", "phone:9876543210"], 7),
    (["phone:9876543210", "email:a@x.test"], 7),
    (["email:a@x.test", "phone:9876543210"], 8),
    ([], 1),
    (["lead:\u00e9", "lead:z", "lead:\U0001f600", "lead:\uffff", "lead:A"], 2_147_483_647),
]
idempotency = [{"keys": k, "campaignId": c, "key": crm_commit.idempotency_key(k, c)} for k, c in key_sets]

request_cases = [
    None, {}, {"enabled": False}, {"enabled": True}, {"enabled": True, "campaignId": 7}, {"enabled": True, "campaignId": True},
    {"enabled": True, "campaignId": 0}, {"enabled": True, "campaignId": "7"}, {"enabled": True, "campaignId": 2_147_483_648},
    {"enabled": True, "campaignId": 2_147_483_647, "source": "x" * 120}, {"enabled": True, "campaignId": 7, "source": "x" * 121},
    {"enabled": True, "campaignId": 7, "source": "   "}, {"enabled": True, "campaignId": 7, "source": 5},
    {"enabled": True, "campaignId": 7, "stage": "bad stage!"}, {"enabled": True, "campaignId": 7, "stage": " Won_Lead "},
    {"enabled": True, "campaignId": 7, "stage": "1ABC"}, {"enabled": True, "campaignId": 7, "stage": "A" * 41},
    {"enabled": True, "campaignId": 7, "stage": "A" * 40}, {"enabled": True, "campaignId": 7, "stage": None},
    {"enabled": "yes", "campaignId": 7}, "x", [1], 5, {"enabled": False, "campaignId": 7, "source": "ignored"},
]
parse = []
for case in request_cases:
    try:
        parse.append({"input": case, "ok": crm_commit.parse_request(case)})
    except ValueError as exc:
        parse.append({"input": case, "error": str(exc)})

# ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────
url_cases = [
    "https://app.example.test", "https://app.example.test/", "  https://app.example.test  ", "HTTPS://App.Example.Test:8443",
    "http://127.0.0.1:5400", "http://localhost:5400", "http://LOCALHOST", "http://[::1]:5400", "http://app.example.test",
    "ftp://app.example.test", "https://app.example.test/api", "https://user:pw@app.example.test", "https://user@app.example.test",
    "https://app.example.test?x=1", "https://app.example.test#frag", "https://app.example.test?", "https://app.example.test:99999",
    "https://app.example.test:abc", "https://app.example.test:", "https://:443", "https://", "app.example.test", "//app.example.test",
    "", "   ", None, 12, "x" * 301, "https://openrouter.ai/api/v1", "https://openrouter.ai", "https://openrouter.ai/", "https://openrouter.ai:443/api/v1",
    "https://openrouter.ai:8443/api/v1", "http://openrouter.ai/api/v1", "https://openrouter.ai.evil.test/api/v1",
    "https://user@openrouter.ai/api/v1", "http://127.0.0.1:9999/api/v1", "http://127.0.0.1:9999/api/v1/", "http://localhost:9999/api/v1",
    "https://example.test/api/v1", "https://app.example.test/\t", "ht\ttps://app.example.test", "https://app.example.test\n",
]


def outcome(fn, value):
    try:
        return {"input": value, "ok": fn(value)}
    except settings_store.SettingsRejected as exc:
        return {"input": value, "error": str(exc)}


sink_urls = [outcome(settings_store.validate_crm_base, v) for v in url_cases]
llm_urls = [outcome(settings_store.validate_llm_base_url, v) for v in url_cases]

secret_cases = [
    ("openrouterApiKey", "sk-or-v1-0123456789abcdef"), ("openrouterApiKey", "short"), ("openrouterApiKey", "has space in it"),
    ("openrouterApiKey", "12345678"), ("openrouterApiKey", ""), ("openrouterApiKey", None), ("openrouterApiKey", 12345678),
    ("openrouterApiKey", True), ("ingestionToken", "x" * 15), ("ingestionToken", "x" * 16), ("ingestionToken", "x" * 512),
    ("ingestionToken", "x" * 513), ("ingestionToken", "has space in the middle of it"), ("googleTokenJson", '{"refresh_token": "r"}'),
    ("googleTokenJson", {"refresh_token": "r", "n": [1, 2]}), ("googleTokenJson", "{not json"), ("googleTokenJson", ["a"]),
    ("googleClientSecrets", '{"installed": {"client_id": "c"}}'), ("googleClientSecrets", "plain text"), ("googleClientSecrets", 5),
]
secrets_norm = []
for name, value in secret_cases:
    try:
        secrets_norm.append({"name": name, "value": value, "ok": settings_store._normalise_secret(name, value)})
    except ValueError as exc:
        secrets_norm.append({"name": name, "value": value, "error": str(exc)})


class MemoryKeyring:
    def __init__(self):
        self.store = {}

    def get_password(self, service, username):
        return self.store.get((service, username))

    def set_password(self, service, username, password):
        self.store[(service, username)] = password

    def delete_password(self, service, username):
        self.store.pop((service, username), None)


apply_steps = [
    {"config": {"llmBaseUrl": "https://openrouter.ai/api/v1", "maxConcurrency": 4}},
    {"config": {"crmBaseUrl": "https://app.example.test"}, "secrets": {"ingestionToken": "ingest-token-0123456789abcdef"}},
    {"secrets": {"openrouterApiKey": "sk-or-v1-0123456789abcdef", "googleTokenJson": '{"refresh_token":"r"}'}},
    {"config": {"crmBaseUrl": None}},
    {"config": {"maxConcurrency": None, "openrouterApiKey": "must-not-persist"}},
    {"secrets": {"openrouterApiKey": None}},
    {"config": {"llmBaseUrl": "https://example.test/api/v1"}},
    {"config": {"crmBaseUrl": "http://app.example.test"}, "secrets": {"ingestionToken": "ingest-token-9999999999999999"}},
    {"secrets": {"somethingElse": "x", "other": "y"}},
    {"secrets": {"openrouterApiKey": "short"}},
    {"config": ["nope"]},
    {"secrets": "nope"},
    {},
    {"config": {"crmBaseUrl": ""}},
    {"config": {"x": 1}, "secrets": {"ingestionToken": ""}},
]
steps_out = []
with tempfile.TemporaryDirectory() as tmp:
    store = settings_store.SettingsStore(settings_store.ConfigStore(Path(tmp) / "config.json"), settings_store.SecretStore(keyring_backend=MemoryKeyring(), dpapi_path=None))
    store.load()
    for step in apply_steps:
        entry = {"step": step}
        try:
            status = store.apply(step.get("config"), step.get("secrets"))
            status.pop("secretStore")
            entry["status"] = status
        except settings_store.SettingsRejected as exc:
            entry["rejected"] = str(exc)
        except ValueError as exc:
            entry["invalid"] = str(exc)
        entry["settings"] = dict(store.settings)
        entry["secretPresence"] = store.secrets.presence()
        steps_out.append(entry)

# ── upload names ────────────────────────────────────────────────────────────────────────────────────────────────
name_cases = [
    "Asha Rao.pdf", "../../evil.pdf", "..\\..\\windows\\evil.CSV", "C:\\temp\\roster.xlsx", "con.pdf", "COM1.zip", "lpt9.csv", "bad<>name?.zip",
    "trailing.dots...pdf", "r\u00e9sum\u00e9-\u00df.pdf", "e\u0301.pdf", "malware.exe", "noextension", ".pdf", "", "   ", "archive.tar.gz", "..",
    None, 5, "a" * 200 + ".pdf", "\u00e9" * 130 + ".pdf", " . lead.PDF ", "a/b/c.zip", "x.PdF", "tab\tname.pdf", "colon:name.pdf", "\x00.pdf",
    "...pdf", "a..pdf", "name.", "name .pdf", "UPPER.XLSX", "dir/", "a.b.c.csv",
]
names = []
for raw in name_cases:
    try:
        stem, ext = server.sanitise_upload_name(raw)
        names.append({"input": raw, "stem": stem, "ext": ext})
    except ValueError as exc:
        names.append({"input": raw, "error": str(exc)})

# ── redaction ───────────────────────────────────────────────────────────────────────────────────────────────────
registered = ["hunter-two-secret-value", "another-registered-value-xyz", "short", "abcdef"]
for value in registered:
    events.register_secret(value)
redact_inputs = [
    "key sk-or-v1-abcdef0123456789xyz and AIzaSyD-example-google-key-0123456789 Bearer abc.def-token ; token=abc123def password: hunter2 hunter-two-secret-value",
    "Processed 12 files for Asha Rao, 3 tokens used, cost 0.02 USD",
    "Authorization: bearer aaaa.bbbb",
    '{"api_key": "value123", "client_secret":"zzz", "keep": "me"}',
    "a1b2c3d4e5f6g7h8.i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6 trailing",
    "x" * 15 + "." + "y" * 31 + " short pair",
    "secret = spaced ; password=  ; token:x,next",
    "contains abcdef inside and another-registered-value-xyz twice another-registered-value-xyz",
    "hunter-two-secret-value-extended hunter-two-secret-value",
    "refresh_token=1//0gAbCdEf private-key: -----BEGIN",
    "ACCESS-TOKEN: t0k3n\nid_token=abc",
    None, 12, "",
]
redactions = [{"input": t, "output": events.redact(t)} for t in redact_inputs]
scrub_input = {"message": "using sk-live-abcdefgh123", "nested": {"key": "sk-live-zzzzzzzz9", "list": ["Bearer qq.ww", 1, True, None, 2.5]}, "n": 3,
               "tuple": ["a", "hunter-two-secret-value"]}
scrubbed = {"input": scrub_input, "output": events.scrub(scrub_input)}

fixtures = {
    "NOW": NOW,
    "AUDIENCE": AUDIENCE,
    "publicKeyPem": public_pem,
    "tokens": tokens,
    "bearer": bearer,
    "origins": origins,
    "build": build,
    "identities": identities,
    "idempotency": idempotency,
    "parseRequest": parse,
    "sinkUrls": sink_urls,
    "llmUrls": llm_urls,
    "secretsNormalise": secrets_norm,
    "applySteps": steps_out,
    "uploadNames": names,
    "registeredSecrets": registered,
    "redactions": redactions,
    "scrub": scrubbed,
}
out_path.write_text(json.dumps(fixtures, indent=1, ensure_ascii=True), encoding="utf-8")
print(f"wrote {out_path} ({len(tokens)} tokens, {len(idempotency)} keys, {len(names)} names)")
