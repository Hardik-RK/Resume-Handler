"""Generate the golden fixtures that pin the TypeScript port to the Python reference.

Usage (run with the reference's interpreter, isolated mode):
    python -I scripts/gen-golden.py --reference <reference folder> --out test/golden --fixtures test/fixtures

It imports the reference pipeline modules, feeds them synthetic inputs (fictional people, example.com addresses)
and records the outputs as JSON. The vitest suite then asserts the TypeScript output is identical.
Nothing here touches the network.
"""
import argparse
import copy
import datetime
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import types
import zipfile
from pathlib import Path

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
sys.dont_write_bytecode = True

ap = argparse.ArgumentParser()
ap.add_argument("--reference", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--fixtures", required=True)
args = ap.parse_args()
sys.path.insert(0, args.reference)

import pymupdf  # noqa: E402
import requests  # noqa: E402

from engine import events  # noqa: E402
from engine import pipeline  # noqa: E402
from engine.pipeline import cache, csvout, drive, jd, llm, names, parse, zips  # noqa: E402

OUT = Path(args.out)
FIX = Path(args.fixtures)
OUT.mkdir(parents=True, exist_ok=True)
(FIX / "pdf").mkdir(parents=True, exist_ok=True)
(FIX / "zips").mkdir(parents=True, exist_ok=True)


def dump(name, data):
    (OUT / f"{name}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False, sort_keys=False), encoding="utf-8")


def jsonable(value):
    """JSON form that keeps what the TypeScript side can represent."""
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return {"__float__": repr(value)}
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, set):
        return sorted(jsonable(v) for v in value)
    if isinstance(value, Path):
        return str(value)
    return value


# ── names ─────────────────────────────────────────────────────────────────────

NAME_TEXTS = [
    "# Ankit Arvind Chaudhari\nIndia | +91 7715030550 | ankit@example.com",
    "Senior Software Engineer | Bangalore\nMUHAMMED ASHFAQ\nBangalore, India",
    "# **SHAKIL AHMAD Java Full Stack Developer | Spring Boot**\nSome Technology Pvt Ltd | Software Developer",
    "Some Technology Pvt Ltd | Software Developer",
    "Dr. Priya Nair\npriya@example.com",
    "NAME: Rahul Verma\nphone 98765 43210",
    "Résumé\nJosé Álvarez\nMadrid",
    "John O'Neil-Smith\nAddress line",
    "Curriculum Vitae\nAnanya Iyer\nBengaluru",
    "asha@example.com\nAsha Rao",
    "B.Tech Computer Science\nKiran Kumar",
    "[Asha Rao](http://example.com/a)\nSkills",
    "![img](a.png)\n# Asha Rao\n",
    "ASHA RAO | Senior Engineer | 98765 43210",
    "Zoë Müller\nBerlin",
    "One Two Three Four Five Six\nNext",
    "Mr. Vikram Singh Rathore",
    "Profile\nSummary\nExperience\nGanesh Pillai",
    "12 Main Road\nMeera Joshi",
    "Candidate: Test Person A cand0@example.com",
    "• Neha Kapoor •\nDelhi",
    "",
    "Software Engineer",
    "Ravi\n",
    "  \n\n  Sanjay Rao Technical Lead\n",
    "Sales Manager Priya Menon",
    "Manish K. Gupta\nEngineer",
    "ÉMILIE DUPONT\nParis",
    "Name: \nSomeone Else",
    "Teacher Anita Desai",
]
names_golden = {
    "fromText": [{"text": t, "name": names.name_from_resume_text(t)} for t in NAME_TEXTS],
    "usable": [],
    "normalise": [],
}
for value in ["Asha Rao", "N/A", "none", "", None, "a@b.com", "Asha 2", "http://x.com", "Candidate", " Unknown ", "Not  Specified", "Zoë"]:
    names_golden["usable"].append({"value": value, "usable": names.usable_resume_name(value)})
for value in ["SAHIL KASHYAP", "Sahil Kashyap", "  mixed   CASE ", "O'NEIL", "ÉMILIE DUPONT", "123", "a-b C", "ASHA  RAO"]:
    names_golden["normalise"].append({"value": value, "out": names.normalise_resume_name_value(value)})
dump("names", names_golden)

# ── csvout ────────────────────────────────────────────────────────────────────

PHONES = [
    "98765 43210", "+91 98765 43210", "09876543210", "+1 650-253-0000", "+44 20 7946 0958", "(650) 253-0000",
    "12345", "Not Specified", "nan", "-", "", None, "+919876543210", "9876543210 ext 12", "+91-98765-43210",
    "0091 98765 43210", "00000 00000", "123456789012", "+971 50 123 4567", "tel:+91-98765-43210",
    "98765-43210/98765-43211", "+91 (987) 654-3210", "abc9876543210", "1800 123 4567", "044 2345 6789",
    "+9198765", "+1234567", "7000000000", "6123456789", "5123456789", "+91 12345 67890", "  +91 98765 43210  ",
    "91 98765 43210", "+86 138 0013 8000", "+61 412 345 678", "98765.43210", "+91 98765 4321O", "n/a", "N/A",
]
csv_golden = {
    "phone": [{"raw": p, "key": csvout.phone_key(p), "e164": csvout.normalize_phone_e164(p)} for p in PHONES],
    "leadId": [],
}
LEADS = [
    ("Asha@Example.com ", "+91 98765 43210", "Asha Rao"), ("asha@example.com", "98765-43210", "Other"),
    ("Not Specified", "", "Ásha  Rao!"), ("", "", ""), (None, None, None), ("n/a", "12", "X Y"),
    ("-", "", "Zoë Müller"), ("nan", "98765 43210", "A"), ("a@b.co", "", "Name"), ("", "+1 650 253 0000", "Name"),
    ("A@B.co", "0091 98765 43210", ""), ("x@y.z", "1234567", "q"), (" a@b.co ", "9876543210", "é"),
]
for e, p, n in LEADS:
    csv_golden["leadId"].append({"email": e, "phone": p, "name": n, "id": csvout.lead_id(e, p, n)})

CELLS = [
    None, "", "plain", "with,comma", 'with "quote"', "line\nbreak", "cr\rhere", "crlf\r\nhere", " lead and trail ",
    "ünïcode — ✓", ["a", "b"], [], [{"name": "Python", "years": 4}], [{"name": "Go", "proficiency": "expert", "years": 2.5}, {"name": "SQL"}],
    {"k": "v", "n": [1, 2, {"z": None}]}, True, False, 0, 5, 2.5, -1, 1000000, ["a", 1], [1, 2], "tab\there",
    [{"name": "é", "x": "line\nbreak"}],
]
csv_golden["cells"] = [{"value": c, "cell": csvout.cell_value(c)} for c in CELLS]
rows = [{"A": c, "B": "x"} for c in CELLS]
csv_golden["csvText"] = csvout.rows_to_csv_text(rows, ["A", "B"])
csv_golden["csvSingleEmpty"] = csvout.rows_to_csv_text([{"A": ""}, {"A": "x"}, {"A": None}], ["A"])
csv_golden["csvTextRows"] = [{"A": c if not isinstance(c, float) else c, "B": "x"} for c in CELLS]
csv_golden["normName"] = [
    {"in": n, "out": csvout._normalize_name_for_id(n)} for n in ["Ásha  Rao!", "Zoë-Müller", "  ", "O'Neil", "日本語 name", "A.B. C", None]
]
dump("csvout", jsonable(csv_golden))

# ── config / redaction / cache keys ───────────────────────────────────────────

dump("defaults", {"DEFAULTS": pipeline.DEFAULTS})
REDACT_TEXTS = [
    ("key sk-secret-123456 Bearer abc.def mail a@b.com phone +91 98765 43210 ok 12", ["sk-secret-123456"]),
    ("short secret abc123 and abcdefgh long", ["abc123", "abcdefgh"]),
    ("call 98765 43210 or 2021-2023 or 12 34", []),
    ("Bearer   tok.en/with=chars and x@y.zz, z@w.com.", []),
    ("plain text", []),
    ("+1 (650) 253-0000 and 1234567890 and 123456789", []),
]
events.register_secret("hunter-two-secret-value")
EVENT_TEXTS = [
    "key sk-or-v1-abcdef0123456789xyz and AIzaSyD-example-google-key-0123456789 Bearer abc.def-token ; token=abc123def password: hunter2 hunter-two-secret-value",
    "Processed 12 files for Asha Rao, 3 tokens used, cost 0.02 USD",
    '{"api_key": "abc", "refresh_token":"zzz", "x": 1}',
    "eyJhbGciOiJFZERTQSJ9abcdef.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
    "client-secret = hush; ID_TOKEN: aaa; passwd=bbb&x=1",
]
dump("redact", {
    "pipeline": [{"text": t, "secrets": s, "out": pipeline.redact(t, s)} for t, s in REDACT_TEXTS],
    "events": [{"text": t, "out": events.redact(t)} for t in EVENT_TEXTS],
    "scrub": [
        {"value": v, "out": events.scrub(v)}
        for v in [{"a": "sk-live-abcdefgh123", "b": [1, "Bearer zzz", {"c": None}], "d": 2.5}, ["x", True], "plain", None, 5]
    ],
    "extractedSecretValues": pipeline._secret_values({
        "openrouterApiKey": "sk-test-key-0123456789",
        "googleTokenJson": json.dumps({"refresh_token": "r-tok-1", "client_secret": "c-sec-1", "access_token": "a-tok-1"}),
        "googleClientSecrets": {"installed": {"client_secret": "inst-sec"}},
    }),
})
dump("cache-keys", {
    "extract": [
        {"args": a, "key": cache.extract_key(*a)}
        for a in [("abc", "m1/m2", "f1/f2", "TECH"), ("abc", "m1/m2", "f1/f2", "sales"), ("def", None, None, None), ("x", "", "", "")]
    ],
    "score": [{"args": a, "key": cache.score_key(*a)} for a in [("abc", "s", "jd1"), ("abc", None, "")]],
    "versions": [cache.PROMPT_VERSION, cache.SCORE_VERSION],
})

# ── llm: prompts, schemas, bodies ─────────────────────────────────────────────

FIELDS = [
    {"name": "Name", "description": "Candidate full name"},
    {"name": "Skills", "description": "List of skills", "campaign_types": ["TECH"]},
    {"name": "Subjects taught", "description": "Subjects", "campaignTypes": ["TEACHER"]},
    {"name": "Date", "description": "supplied", "source": "pipeline"},
    {"name": "ATS score", "description": "ats", "extractor": "ats", "campaign_types": ["TECH"]},
]
OPENROUTER = "https://openrouter.ai/api/v1"
INSTR_CFGS = [
    {"CRM_CAMPAIGN_TYPE": "TECH"}, {"CRM_CAMPAIGN_TYPE": "TEACHER"}, {"CRM_CAMPAIGN_TYPE": "SALES"}, {"CRM_CAMPAIGN_TYPE": ""},
    {}, {"CRM_CAMPAIGN_TYPE": "TECH", "EXTRACT_ATS": True}, {"campaignType": "sales"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_PROMPT_MODE": "legacy"}, {"CRM_CAMPAIGN_TYPE": "SALES", "LLM_PROMPT_MODE": "legacy"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_PROMPT_MODE": "validated"}, {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_PROMPT_MODE": "verbose", "EXTRACT_ATS": "yes"},
    {"CRM_CAMPAIGN_TYPE": "teacher", "LLM_PROMPT_MODE": " Legacy "}, {"LLM_PROMPT_MODE": "validated"}, {"CRM_CAMPAIGN_TYPE": "TECH", "EXTRACT_ATS": "0"},
]
dump("prompts", {
    "fields": FIELDS,
    "cases": [{
        "cfg": c,
        "instructions": llm._instructions(FIELDS, c),
        "schema": llm._response_schema(FIELDS, c),
    } for c in INSTR_CFGS],
    "messages": {
        "text": llm._messages("INSTR", "Candidate: A\nb@c.de", [], vision=False),
        "vision": llm._messages("INSTR", "", ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"], vision=True),
    },
})

BODY_CFGS = [
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER},
    {"CRM_CAMPAIGN_TYPE": "SALES", "LLM_BASE_URL": OPENROUTER, "_LLM_RUN_ID": "run-20260101T000000Z-abcdef12"},
    {"CRM_CAMPAIGN_TYPE": "TEACHER", "LLM_BASE_URL": "https://api.example.test/v1"},
    {"CRM_CAMPAIGN_TYPE": "", "LLM_BASE_URL": OPENROUTER, "EXTRACT_ATS": True},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_TEMPERATURE": "0.2"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_TEMPERATURE": "hot"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_RESPONSE_FORMAT": "json_object"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_RESPONSE_FORMAT": "legacy"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_REASONING_EFFORT": "HIGH", "OPENROUTER_ZDR": True,
     "OPENROUTER_DATA_COLLECTION": "deny", "OPENROUTER_SORT": "price", "OPENROUTER_PROVIDER_ORDER": "a, b ,c",
     "OPENROUTER_REQUIRE_PARAMETERS": "no", "OPENROUTER_ALLOW_FALLBACKS": False},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "OPENROUTER_PROVIDER_ORDER": ["x"], "OPENROUTER_ZDR": False, "OPENROUTER_DATA_COLLECTION": ""},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": "https://api.example.test/v1", "LLM_REASONING_EFFORT": "medium"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_MAX_OUTPUT_TOKENS": "100", "LLM_FALLBACK_MAX_OUTPUT_TOKENS": 5000.9},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_MAX_OUTPUT_TOKENS": "abc"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_MAX_OUTPUT_TOKENS": None},
    {"CRM_CAMPAIGN_TYPE": "TECH"},
    {"CRM_CAMPAIGN_TYPE": "TECH", "LLM_BASE_URL": OPENROUTER, "LLM_VISION_REASONING_EFFORT": "bogus", "LLM_FALLBACK_REASONING_EFFORT": "max",
     "LLM_FALLBACK_VISION_REASONING_EFFORT": "xhigh"},
]
body_cases = []
for cfg in BODY_CFGS:
    for vision in (False, True):
        for fallback in (False, True):
            b = llm._build_body("model/x", [{"role": "user", "content": "hi"}], FIELDS, cfg, vision=vision, fallback=fallback)
            if "user" in b:
                b["user"] = "resume-intake:" + b["user"].split(":", 1)[1]   # the reference prefixes its own product name
            body_cases.append({"cfg": cfg, "vision": vision, "fallback": fallback, "body": b})
model_cases = []
for cfg in [{}, {"LLM_MODEL": "legacy/m", "LLM_VISION_MODEL": "legacy/v"}, {"LLM_PRIMARY_MODEL": " p/m ", "LLM_MODEL": "x"},
            {"LLM_FALLBACK_MODEL": " f/m ", "LLM_FALLBACK_VISION_MODEL": None}, {"LLM_PRIMARY_VISION_MODEL": ""}]:
    model_cases.append({
        "cfg": cfg,
        "primary": llm._model_for(cfg), "vision": llm._model_for(cfg, vision=True),
        "fallback": llm._model_for(cfg, fallback=True), "fallbackVision": llm._model_for(cfg, vision=True, fallback=True),
    })
dump("bodies", {"bodies": body_cases, "models": model_cases})

# ── llm: normalisers and heuristics ───────────────────────────────────────────

RAWS = [
    ({
        "name": "Asha Rao", "email": "asha@example.com", "phone": "+919876543210", "location": "Bengaluru", "graduation": "2024 - B.Tech",
        "skill_tags": ["Python", "python", "AWS"],
        "skill_details": [{"name": "Python", "proficiency": "expert", "years": 4}, {"name": "AWS", "proficiency": None, "years": None}],
        "certifications": ["AWS SAA"], "certification_details": [],
    }, "TECH"),
    ({"skill_tags": ["Python"], "skill_details": [{"name": "Python", "years": 2023}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": "2018"}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": -1}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": float("nan")}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": float("inf")}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": 0}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": 2.5}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": "4"}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": 100}]}, "TECH"),
    ({"skill_details": [{"name": "Python", "years": 4.0, "proficiency": "EXPERT"}, {"name": "go", "proficiency": "wizard"},
                        {"name": "Rust", "proficiency": "Not Specified"}, {"title": "C", "proficiency": "Beginner"}, "plain", 5, None]}, "TECH"),
    ({"Skills": "Python, Java; Go|Rust", "Resume parsed skill tags": "a;b", "Certifications": "AWS"}, "TECH"),
    ({"skill_tags": "Python Node Angular Linux"}, "TECH"),
    ({"skill_tags": "single"}, "TECH"),
    ({"name": "Not Specified", "Name": "Asha", "email": "N/A", "Email Address": "a@b.co", "phone": "", "location": "-", "graduation": None}, "TECH"),
    ({"name": ["x"], "email": [], "phone": 0, "location": 5}, "TECH"),
    ({"atsScore": 80, "atsSummary": "ok"}, "TECH"),
    ({"atsScore": 0, "ATS summary": "", "Summary": "s"}, "TECH"),
    ({"subjects": ["Math", "math"], "subject_details": [{"name": "Physics", "category": "STEM"}],
      "grade_levels": ["9", "10"], "curricula": "CBSE, ICSE", "organizations": ["Acme School"],
      "organization_details": [{"name": "Acme School", "type": "school", "years": 3}, {"name": "X", "type": "bad", "years": 200}]}, "TEACHER"),
    ({"Subjects taught": [{"name": "Chem"}], "Grade levels taught": "11; 12", "Curriculum expertise": ["IB"], "Ed tech names/school name": ["Foo"]}, "TEACHER"),
    ({"sales_types": ["inside sales", "SMB", "inside sales"], "industries": "SaaS, Retail", "team_level": "manager", "team_size": 12}, "SALES"),
    ({"CS / Sales type": ["B2B"], "Industry background": ["x"], "Team level": "Not Specified", "Team size": 0}, "SALES"),
    ({"name": "All Fields", "skill_tags": ["Py"], "subjects": ["Art"], "sales_types": ["B2C"], "team_size": 3.0}, ""),
    ({"name": "No Type"}, "TECH"),
    ({}, "SALES"),
]
norm_cases = []
for raw, ctype in RAWS:
    cfg = {"CRM_CAMPAIGN_TYPE": ctype}
    norm_cases.append({"raw": jsonable(raw), "ctype": ctype, "row": jsonable(llm._normalise_model_row(copy.deepcopy(raw), cfg))})
bad_raw = []
for value in [None, [], "text", 5]:
    try:
        llm._normalise_model_row(value, {})
        bad_raw.append({"value": value, "error": None})
    except ValueError as exc:
        bad_raw.append({"value": value, "error": str(exc)})

PHONE_TEXTS = [
    "Contact: sampleperson8076547911@samp.test | 98765 43210\nCity",
    "Address 464046, 7974341200 Bhopal",
    "Mobile: +91-98765-43210 email x@y.com",
    "References: 9123456780 is my manager",
    "no digits here at all",
    "Phone 9999999999 and 8123456789",
    "Tel: 0 98765 43210 end",
    "abc9876543210 and 9876543211def",
    "x" * 450 + " References: 9123456780",
    "Intro text\n" + "y" * 300 + "\nReferees\nCall 9123456780\n",
    "Home 9876543210, Mobile: 8765432109",
    "contact 98765 43211 then Mobile - 91234 56780",
    "+91 98765 43210 www.example.com/9876543211 end",
    "00919876543210 and 919876543211",
    "12345678901234",
    "Ph. 7012345678",
    "tel\n\n\n9876543210",
    "98765.43210 / 98765-43211",
    "",
]
snap_cases = []
for text, row in [
    ("Priya N  priya.nair92@samp.test | +91 98765 43210\nSkills: Java", {"Email Address": "priya.nair82@samp.test", "Phone Number": "+91 98765 43211"}),
    ("Priya N  priya.nair92@samp.test | +91 98765 43210", {"Email Address": "other@x.com", "Phone Number": "+91 55555 55555"}),
    ("", {"Email Address": "a@b.com", "Phone Number": "9876543210"}),
    ("priya . nair92 @ samp . test and 98765 43210", {"Email Address": "priya.nair82@samp.test", "Phone Number": ""}),
    ("a@b.com", {"Email Address": "A@B.com", "Phone Number": "Not Specified"}),
    ("Reach me at asha.rao@example.com  9876543210 www.example.com/9123456789", {"Email Address": "asha.rao@example.org", "Phone Number": "9876543219"}),
]:
    snap_cases.append({"text": text, "row": copy.deepcopy(row), "out": llm._snap_contacts_to_text(copy.deepcopy(row), text)})
fill_cases = []
for text, row in [
    ("Name\nPhone 98765 43210 mail a@b.com", {"Phone Number": "Not Specified", "Email Address": "a@b.com"}),
    ("Name\nno phone here", {"Phone Number": None, "Email Address": "a@b.com"}),
    ("Name 98765 43210", {"Phone Number": "98765 43210", "Email Address": "Not Specified"}),
]:
    fill_cases.append({"text": text, "row": copy.deepcopy(row), "out": llm._fill_local_contacts(copy.deepcopy(row), text)})
VALIDATE = [
    ({"Name": "Not Specified", "Email Address": "bad-email", "Phone Number": "123"}, "a@b.co"),
    ({"Name": "Asha Rao", "Email Address": "asha@example.com", "Phone Number": "+91 98765 43210"}, "asha@example.com"),
    ({"Name": "Asha Rao", "Email Address": "other@example.com", "Phone Number": "9876543210"}, "text asha@example.com"),
    ({"Name": "Asha Rao", "Email Address": "other@example.com", "Phone Number": "9876543210"}, "a@x.com b@y.com"),
    ({"Name": "A1", "Email Address": "Not Specified", "Phone Number": "Not Specified"}, ""),
    ({"Name": "Asha", "Email Address": "a b@ex ample.com", "Phone Number": ""}, ""),
    ({"Name": "http://x", "Email Address": "", "Phone Number": "12345"}, ""),
    ({"Name": "Asha"}, ""),
    ({"Name": "x@y.z", "Email Address": "a@b.co", "Phone Number": "0123456789012"}, "q"),
]
EXTRACT = [
    '{"a": 1}', '```json\n{"a": 1}\n```', 'Here is it: {"a": {"b": "}"}} thanks', 'prefix ```json {"a": [1,2]} ```', '{"a": "unterminated',
    'no object', '[1, 2]', '{"a": 1} {"b": 2}', '{bad json}', '  {"nested": {"x": "a\\"b}"}}  ', '{"a": 1,}', 'text {"a": "x\\\\"} more',
    '{"a": NaN}', '',
]
extract_cases = []
for text in EXTRACT:
    try:
        extract_cases.append({"text": text, "ok": True, "value": jsonable(llm._extract_json(text))})
    except (ValueError, json.JSONDecodeError) as exc:
        extract_cases.append({"text": text, "ok": False, "message": str(exc) if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError) else "JSONDecodeError"})
LISTS = [None, "", "a, b;c|d", "Python Node", ["x", "y"], [], 5, "Not Specified", "none", " ; ", {"a": 1}, [None, "", "q"], "a\nb"]
DEDUPE = [["A", "a", " A  b ", None, "", "n/a", {"name": "Z"}, {"x": 1}, 5, "Not Specified"], [], ["é", "É"], ["ß", "SS"]]
RATIOS = [
    ("priya.nair82@samp.test", "priya.nair92@samp.test"), ("abcdef", "abcdef"), ("", ""), ("a", ""), ("9876543211", "9876543210"),
    ("kitten", "sitting"), ("abcde" * 50, "abcde" * 50 + "x"), ("a" * 250 + "b" * 10, "a" * 250 + "c" * 10), ("ab" * 120 + "q", "q" + "ab" * 120),
    ("x@y.com", "z@w.org"), ("the quick brown fox", "the quick brown fax"), ("é" * 5, "e" * 5),
]
meta_cases = []
USAGE_PAYLOADS = [
    {"id": "gen-1", "request_id": "r-1", "provider_name": "P", "model": "m/x", "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.001,
                                                                                        "completion_tokens_details": {"reasoning_tokens": 3}, "prompt_tokens_details": {"cached_tokens": 4}}},
    {"id": "gen-1", "usage": {"prompt_tokens": "7", "completion_tokens": None, "reasoning_tokens": 2, "cached_tokens": 1, "cost": "0.5"}},
    {"usage": "bad"}, {}, None, {"usage": {"cost": "abc", "total_tokens": 3.9}},
]
tot = {"prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0, "cached_tokens": 0, "total_tokens": 0, "cost": 0.0,
       "generation_ids": [], "request_ids": [], "provider_names": []}
usage_steps = []
for payload in USAGE_PAYLOADS:
    llm._accumulate_usage(tot, payload)
    usage_steps.append({"payload": payload, "total": copy.deepcopy(tot)})
meta = llm._usage_meta({"model": "m/x"}, response_model=None, elapsed=1.23456, attempts=2, retries=1, usage=copy.deepcopy(tot))
primary = {"model": "p", "attempts": 1, "retries": 0, "prompt_tokens": 5, "cost": 0.1, "latency_seconds": 1.0, "generation_ids": ["a"], "request_ids": [], "provider_names": ["x"]}
secondary = {"model": "s", "attempts": 2, "retries": 1, "prompt_tokens": 7, "cost": 0.2, "latency_seconds": 0.5, "generation_ids": ["a", "b"], "total_tokens": 9}
merged = llm._merge_meta(primary, secondary, run_id="r", vision=False)
merged_none = llm._merge_meta(primary, None, extra="e")
merged_empty = llm._merge_meta(primary, {}, extra="e")
classify = [{"status": s, "body": b, "kind": llm._classify(s, b)} for s, b in [
    (429, "requests per day exceeded"), (429, "slow down"), (429, "TPD limit"), (429, "daily"), (500, ""), (502, ""), (503, ""), (504, ""),
    (400, ""), (401, ""), (403, ""), (404, ""), (200, "")]]


class _Resp:
    def __init__(self, status=200, text="", headers=None, payload=None):
        self.status_code = status
        self.text = text
        self.headers = headers or {}
        self._payload = payload

    def json(self):
        if self._payload is not None:
            return self._payload
        return json.loads(self.text)


retry_after = [
    {"headers": h, "text": t, "default": d, "out": llm._retry_after(_Resp(headers=h, text=t), d)}
    for h, t, d in [({"retry-after": "3"}, "", 2), ({"retry-after": "100"}, "", 2), ({"retry-after": "abc"}, "try again in 4.5s", 2),
                    ({}, "Please try again in 12.5s.", 2), ({}, "", 8), ({"retry-after": "0"}, "", 4), ({}, "try again in 100s", 1),
                    ({"retry-after": "1.5"}, "", 1)]
]
content_text = [{"message": m, "out": llm._content_text(m)} for m in [
    {"content": "plain"}, {"content": [{"text": "a"}, {"text": None}, {"type": "x"}, "str", {"text": "b"}]}, {"content": {"text": "t"}},
    {"content": {"value": "v"}}, {"content": None}, {}, "notadict", {"content": 5}, {"content": []}]]
dump("llm-helpers", jsonable({
    "normalise": norm_cases, "badRaw": bad_raw,
    "recoverPhone": [{"text": t, "out": llm._recover_phone(t)} for t in PHONE_TEXTS],
    "snap": snap_cases, "fill": fill_cases,
    "validate": [{"row": r, "text": t, "issues": llm._validate_row(copy.deepcopy(r), text=t, cfg={})} for r, t in VALIDATE],
    "extractJson": extract_cases,
    "asList": [{"value": v, "out": llm._as_list(v)} for v in LISTS],
    "dedupe": [{"values": v, "out": llm._dedupe_strings(v)} for v in DEDUPE],
    "missing": [{"value": v, "out": llm._missing(v)} for v in [None, "", " N/A ", "none", "-", 0, "0", [], [""], "x", False]],
    "ratios": [{"a": a, "b": b, "ratio": difflib.SequenceMatcher(None, a, b).ratio()} for a, b in RATIOS],
    "closest": [{"value": v, "cands": c, "out": llm._closest(v, c)} for v, c in [
        ("priya.nair82@samp.test", ["priya.nair92@samp.test", "other@x.com"]), ("abc", ["xyz"]), ("9876543211", ["9876543210", "9876543211"])]],
    "usageSteps": usage_steps, "usageMeta": meta, "mergeMeta": {"merged": merged, "none": merged_none, "empty": merged_empty},
    "classify": classify, "retryAfter": retry_after, "contentText": content_text,
    "isOpenrouter": [{"url": u, "out": llm._is_openrouter(u)} for u in [None, "", "https://OpenRouter.ai/api", "https://x.test"]],
    "usable": [{"value": v, "out": llm._usable_name(v)} for v in ["Asha", "A1", "a@b", "http://x", "N/A", None, " x "]],
    "portable": llm._portable_schema(llm._nullable_enum(["a", "b"])),
}))


# ── transport flows with a scripted session ───────────────────────────────────

class ScriptedSession:
    def __init__(self, script):
        self.script = list(script)
        self.bodies = []

    def post(self, url, headers=None, json=None, timeout=None):
        self.bodies.append(copy.deepcopy(json))
        if not self.script:
            raise requests.exceptions.ConnectionError("script exhausted")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        status, text, hdrs = item
        return _Resp(status, text, hdrs)


def ok_payload(content, model="resp/model", cost=0.001, **extra):
    payload = {"id": "gen-" + hashlib.sha1(content.encode()).hexdigest()[:6], "model": model,
               "choices": [{"message": {"content": content}}],
               "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150, "cost": cost}}
    payload.update(extra)
    return json.dumps(payload)


GOOD = ok_payload('{"name": "Asha Rao", "email": "asha@example.com", "phone": "+919876543210"}')
TRUNC = ok_payload('{"name": "Asha Rao", "skill_tags": ["Py')
POST_FLOWS = {
    "ok": [(200, GOOD, {})],
    "fenced": [(200, ok_payload('```json\n{"name": "F"}\n```'), {})],
    "emptyThenOk": [(200, ok_payload(""), {}), (200, GOOD, {})],
    "badShapeThenOk": [(200, json.dumps({"choices": []}), {}), (200, GOOD, {})],
    "unparseableThenOk": [(200, ok_payload("no json here"), {}), (200, GOOD, {})],
    "truncatedThenOk": [(200, TRUNC, {}), (200, GOOD, {})],
    "transientThenOk": [(503, "busy", {}), (200, GOOD, {})],
    "minuteThenOk": [(429, "slow", {"retry-after": "0"}), (200, GOOD, {})],
    "daily": [(429, "requests per day exceeded", {})],
    "fatal": [(400, "bad request", {})],
    "networkThenOk": [requests.exceptions.ConnectionError("x"), (200, GOOD, {})],
    "timeoutThenOk": [requests.exceptions.ReadTimeout("x"), (200, GOOD, {})],
    "allTransient": [(500, "x", {}), (500, "x", {})],
    "allNetwork": [requests.exceptions.ConnectionError("x"), requests.exceptions.ConnectionError("x")],
    "allEmpty": [(200, ok_payload(""), {}), (200, ok_payload(""), {})],
    "allUnparseable": [(200, ok_payload("zzz"), {}), (200, ok_payload("zzz"), {})],
}
post_out = {}
for name, script in POST_FLOWS.items():
    sess = ScriptedSession(script)
    notes = []
    tr = llm.Transport(gate=llm.RateGate(2, cooldown_seconds=0.5), session_factory=lambda s=sess: s, on_retry=notes.append)
    body = {"model": "req/model", "max_tokens": 1000, "messages": []}
    try:
        parsed, meta = llm._post("http://x.test/chat/completions", {"Authorization": "Bearer k"}, body, "lbl", max_retries=2, return_meta=True, transport=tr)
        out = {"ok": True, "parsed": parsed, "meta": meta}
    except Exception as exc:
        out = {"ok": False, "error": type(exc).__name__, "message": str(exc), "meta": getattr(exc, "_llm_meta", None)}
    for m in (out.get("meta") or {}),:
        m.pop("latency_seconds", None)
    out["notes"] = notes
    out["maxTokens"] = [b.get("max_tokens") for b in sess.bodies]
    out["calls"] = len(sess.bodies)
    out["trips"] = tr.gate.trips
    post_out[name] = {"script": [list(s) if isinstance(s, tuple) else {"throw": type(s).__name__} for s in script], "result": out}
dump("post-flows", jsonable(post_out))

# ── PDFs ──────────────────────────────────────────────────────────────────────


def text_pdf(path, lines, size=10, header=None, links=()):
    doc = pymupdf.open()
    page = doc.new_page()
    y = 72
    if header:
        page.insert_text((60, y), header, fontsize=18)
        y += 26
    for line in lines:
        page.insert_text((60, y), line, fontsize=size)
        y += 14
    for uri in links:
        page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 60, 200, 80), "uri": uri})
    doc.save(str(path))
    doc.close()


def image_pdf(path, lines=()):
    doc = pymupdf.open()
    page = doc.new_page()
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 40), False)
    pix.set_rect(pix.irect, (30, 90, 160))
    page.insert_image(pymupdf.Rect(60, 300, 360, 500), pixmap=pix)
    y = 72
    for line in lines:
        page.insert_text((60, y), line, fontsize=10)
        y += 14
    doc.save(str(path))
    doc.close()


def resume_lines(candidate, email, phone, extra=""):
    return [
        f"Candidate: {candidate}",
        f"{email}   {phone}   Bengaluru, India",
        "Education: B.Tech 2021, Example Institute of Technology",
        "Skills: Python, SQL, data analysis and reporting with dashboards and automation.",
        "Experience: built ETL pipelines and automated weekly reports for the operations team.",
        "Projects: inventory forecasting service and an internal resume screening tool.",
        extra,
    ]


PDF = FIX / "pdf"
for i, (cand, em, ph) in enumerate([("Test Person A", "cand0@example.com", "9876543200"), ("Test Person B", "cand1@example.com", "9876543201"),
                                    ("Test Person C", "cand2@example.com", "9876543202"), ("Test Person D", "cand3@example.com", "9876543200")]):
    text_pdf(PDF / f"cv{i}.pdf", resume_lines(cand, em, ph))
text_pdf(PDF / "priya.pdf", [
    "priya.nair92@example.com | +91 98765 43210 | Bengaluru, India",
    "Education: B.Tech 2021, Example Institute of Technology",
    "Skills: Python, SQL, data analysis and reporting with dashboards and automation.",
    "Experience: built ETL pipelines and automated weekly reports for the operations team.",
    "Projects: inventory forecasting service and an internal resume screening tool.",
], header="PRIYA NAIR")
text_pdf(PDF / "links.pdf", [
    "Meera Joshi  Bengaluru, India  Education: B.Tech 2021, Example Institute of Technology",
    "Skills: Python, SQL, data analysis and reporting with dashboards and automation.",
    "Experience: built ETL pipelines and automated weekly reports for the operations team.",
    "Projects: inventory forecasting service and an internal resume screening tool and more words here.",
], links=["mailto:meera@example.com", "https://www.linkedin.com/in/meera-example", "https://example.com/other", "https://github.com/meera-example"])
text_pdf(PDF / "spaced.pdf", [
    "Kiran Rao  kiran . rao @ example . com  +91 98765 43210",
    "Education: B.Tech 2021, Example Institute of Technology",
    "Skills: Python, SQL, data analysis and reporting with dashboards and automation.",
    "Experience: built ETL pipelines and automated weekly reports for the operations team.",
    "Projects: inventory forecasting service and an internal resume screening tool and more words.",
])
image_pdf(PDF / "scan.pdf")
image_pdf(PDF / "hybrid.pdf", [
    "Hybrid Person  Bengaluru, India  Education: B.Tech 2021, Example Institute of Technology",
    "Skills: Python, SQL, data analysis and reporting with dashboards and automation.",
    "Experience: built ETL pipelines and automated weekly reports for the operations team.",
    "Projects: inventory forecasting service and an internal resume screening tool and more words.",
])
text_pdf(PDF / "short.pdf", ["Tiny doc", "email a@b.co"])
(PDF / "corrupt.pdf").write_bytes(b"%PDF-1.4\nthis is not a real pdf at all\n")

text_pdf(PDF / "quota.pdf", resume_lines("QUOTA Person", "q@example.com", "9876543288"))
text_pdf(PDF / "failparse.pdf", resume_lines("FAILPARSE Person", "x@example.com", "9876543299"))
with zipfile.ZipFile(FIX / "zips" / "pipeline-batch.zip", "w") as zf:
    zf.write(PDF / "cv2.pdf", "one/CV.pdf")
    zf.write(PDF / "cv1.pdf", "two/CV.pdf")
    zf.writestr("readme.txt", "x")
with zipfile.ZipFile(FIX / "zips" / "two-cv.zip", "w") as zf:
    zf.write(PDF / "cv0.pdf", "one/CV.pdf")
    zf.write(PDF / "cv1.pdf", "two/CV.pdf")
with zipfile.ZipFile(FIX / "zips" / "quota.zip", "w") as zf:
    zf.write(PDF / "quota.pdf", "quota.pdf")

# parse-level golden: what PdfDoc and the decisions report
parse_cases = []
for name in ["cv0.pdf", "priya.pdf", "links.pdf", "spaced.pdf", "scan.pdf", "hybrid.pdf", "short.pdf", "corrupt.pdf"]:
    with parse.PdfDoc(PDF / name) as doc:
        text = parse._extract_text(PDF / name, doc)
        parse_cases.append({
            "file": name, "rawLen": doc.raw_len, "hasImages": doc.has_images, "uris": doc.uris, "pages": len(doc.pages),
            "extractedEmpty": not text.strip(), "needsVision": parse._needs_vision(text, doc) if text.strip() else None,
            "useVision": not (text.strip() and not parse._needs_vision(text, doc)),
            "linksText": parse._links_text(doc.uris),
            "recover": parse._recover_contacts(text, doc.raw_text) if doc.pages else "",
            "renderCount": len(doc.render(150, 4)),
        })
dump("parse-docs", jsonable(parse_cases))
dump("parse-helpers", {
    "hasPhone": [{"text": t, "out": parse._has_phone(t)} for t in ["call 98765 43210", "2021-2023 2024", "+91 98765 43210", "", "12345 67890"]],
    "linksText": [{"uris": u, "out": parse._links_text(u)} for u in [
        ["mailto:a@b.co", "MAILTO:A@B.CO", "https://linkedin.com/in/x", "https://linkedin.com/in/x", "http://github.com/y", "https://other.com", "", None],
        []]],
    "recover": [{"md": m, "raw": r, "out": parse._recover_contacts(m, r)} for m, r in [
        ("no contacts", "a @ samp . test and 98765 43210"), ("mail a@b.co phone 98765 43210", "x"), ("a@b.co", "call 98765-43210"), ("", ""),
        ("a@b.co", "2021 2022 2023 and 1234567890")]],
})


# ── extract_resume flows ──────────────────────────────────────────────────────

def extract_cfg(**over):
    cfg = {
        "LLM_API_KEY": "sk-test-key-0123456789", "LLM_BASE_URL": OPENROUTER, "LLM_PRIMARY_MODEL": "p/text", "LLM_PRIMARY_VISION_MODEL": "p/vision",
        "LLM_FALLBACK_MODEL": "f/text", "LLM_FALLBACK_VISION_MODEL": "f/vision", "CRM_CAMPAIGN_TYPE": "TECH", "LLM_MAX_RETRIES": 1,
        "VISION_DPI": 100, "_LLM_RUN_ID": "run-test",
    }
    cfg.update(over)
    return cfg


def good_row(name="Priya Nair", email="priya.nair92@example.com", phone="+91 98765 43210", **over):
    row = {"name": name, "email": email, "phone": phone, "location": "Bengaluru", "graduation": "2021 - B.Tech",
           "skill_tags": ["Python", "SQL"], "skill_details": [{"name": "Python", "proficiency": "expert", "years": 3}],
           "certifications": [], "certification_details": []}
    row.update(over)
    return ok_payload(json.dumps(row))


EXTRACT_FLOWS = [
    {"id": "text-ok", "file": "priya.pdf", "script": [(200, good_row(), {})]},
    {"id": "email-slip-snapped", "file": "priya.pdf", "script": [(200, good_row(email="priya.nair82@example.com"), {})]},
    {"id": "invalid-email-falls-back", "file": "priya.pdf", "script": [(200, good_row(email="not-an-email"), {}), (200, good_row(), {})]},
    {"id": "fallback-worse-keeps-primary", "file": "priya.pdf", "script": [(200, good_row(email="not-an-email"), {}), (200, good_row(email="x", phone="1"), {})]},
    {"id": "name-only-fixed-by-heuristic", "file": "priya.pdf", "script": [(200, good_row(name="Not Specified"), {})]},
    {"id": "name-bad-heuristic-fails-then-fallback", "file": "short.pdf", "script": [(200, good_row(name="N/A"), {}), (200, good_row(name="Fallback Name"), {})]},
    {"id": "primary-500-fallback-ok", "file": "priya.pdf", "script": [(500, "x", {}), (200, good_row(), {})]},
    {"id": "both-fail", "file": "priya.pdf", "script": [(400, "x", {}), (400, "y", {})]},
    {"id": "primary-fail-fallback-fail-network", "file": "priya.pdf", "script": [(400, "x", {}), requests.exceptions.ConnectionError("n"), requests.exceptions.ConnectionError("n")]},
    {"id": "daily-quota", "file": "priya.pdf", "script": [(429, "requests per day exceeded", {})]},
    {"id": "daily-quota-on-fallback", "file": "priya.pdf", "script": [(200, good_row(email="bad"), {}), (429, "daily", {})]},
    {"id": "scan-vision", "file": "scan.pdf", "script": [(200, good_row(name="SCAN PERSON"), {})]},
    {"id": "hybrid-vision", "file": "hybrid.pdf", "script": [(200, good_row(name="Hybrid Person"), {})]},
    {"id": "links-merged", "file": "links.pdf", "script": [(200, good_row(name="Meera Joshi", email="meera@example.com", phone=None), {})]},
    {"id": "spaced-email-recovered", "file": "spaced.pdf", "script": [(200, good_row(name="Kiran Rao", email=None, phone=None), {}), (200, good_row(name="Kiran Rao", email="kiran.rao@example.com"), {})]},
    {"id": "corrupt", "file": "corrupt.pdf", "script": []},
    {"id": "no-key", "file": "priya.pdf", "script": [], "cfg": {"LLM_API_KEY": ""}},
    {"id": "same-model-no-fallback", "file": "priya.pdf", "script": [(200, good_row(email="bad"), {})], "cfg": {"LLM_FALLBACK_MODEL": "p/text"}},
    {"id": "no-fallback-configured", "file": "priya.pdf", "script": [(200, good_row(email="bad"), {})], "cfg": {"LLM_FALLBACK_MODEL": ""}},
    {"id": "all-caps-name", "file": "priya.pdf", "script": [(200, good_row(name="PRIYA  NAIR"), {})]},
    {"id": "non-object-reply", "file": "priya.pdf", "script": [(200, ok_payload("[1,2]"), {}), (200, good_row(), {})]},
    {"id": "sales-campaign", "file": "priya.pdf", "script": [(200, ok_payload(json.dumps({"name": "Priya Nair", "email": "priya.nair92@example.com", "phone": "98765 43210", "sales_types": ["B2B"], "industries": ["SaaS"], "team_level": "manager", "team_size": 4})), {})], "cfg": {"CRM_CAMPAIGN_TYPE": "SALES"}},
]
extract_out = []
for flow in EXTRACT_FLOWS:
    sess = ScriptedSession(flow["script"])
    notes = []
    tr = llm.Transport(gate=llm.RateGate(2, cooldown_seconds=0.5), session_factory=lambda s=sess: s, on_retry=notes.append)
    cfg = extract_cfg(**flow.get("cfg", {}))
    try:
        row = parse.extract_resume(PDF / flow["file"], cfg, tr, [], label="lbl")
        meta = row.pop("_llm_meta")
        meta.pop("latency_seconds", None)
        result = {"ok": True, "row": row, "meta": meta}
    except Exception as exc:
        em = dict(getattr(exc, "_llm_meta", {}) or {})
        em.pop("latency_seconds", None)
        result = {"ok": False, "error": type(exc).__name__, "message": str(exc), "meta": em}
    bodies = []
    for b in sess.bodies:
        content = b["messages"][1]["content"]
        bodies.append({
            "model": b["model"], "max_tokens": b["max_tokens"], "vision": isinstance(content, list),
            "images": len(content) - 1 if isinstance(content, list) else 0, "keys": sorted(b), "system": b["messages"][0]["content"],
            "reasoning": b.get("reasoning"),
        })
    extract_out.append({"id": flow["id"], "file": flow["file"], "cfg": flow.get("cfg", {}),
                        "script": [list(s) if isinstance(s, tuple) else {"throw": type(s).__name__} for s in flow["script"]],
                        "result": result, "bodies": bodies, "notes": notes})
dump("extract-flows", jsonable(extract_out))

# ── jd scoring ───────────────────────────────────────────────────────────────

JD_FLOWS = [
    {"id": "ok-pass", "script": [(200, ok_payload('{"score": 80, "verdict": "pass", "missing_critical": [], "reason": "good fit"}'), {})]},
    {"id": "ok-reject", "script": [(200, ok_payload('{"score": 20, "verdict": "reject", "missing_critical": ["Kubernetes"], "reason": "gap"}'), {})]},
    {"id": "score-clamped-high", "script": [(200, ok_payload('{"score": 250, "verdict": "pass", "reason": "x"}'), {})]},
    {"id": "score-clamped-low", "script": [(200, ok_payload('{"score": -5, "verdict": "reject"}'), {})]},
    {"id": "score-string", "script": [(200, ok_payload('{"score": "70", "verdict": "pass"}'), {})]},
    {"id": "score-bad", "script": [(200, ok_payload('{"score": "abc", "verdict": "pass"}'), {})]},
    {"id": "score-float-string", "script": [(200, ok_payload('{"score": "70.5", "verdict": "pass"}'), {})]},
    {"id": "verdict-invalid", "script": [(200, ok_payload('{"score": 50, "verdict": "maybe", "missing_critical": ["x"], "reason": "' + "r" * 400 + '"}'), {})]},
    {"id": "not-an-object", "script": [(200, ok_payload('[1,2,3]'), {})]},
    {"id": "http-400", "script": [(400, "x", {})]},
    {"id": "daily", "script": [(429, "requests per day", {})]},
    {"id": "no-key", "script": [], "cfg": {"LLM_API_KEY": ""}},
    {"id": "no-text", "script": [], "resume": "   "},
    {"id": "fields-text", "script": [(200, ok_payload('{"score": 61, "verdict": "pass"}'), {})], "resume": "", "fields": {"Name": "A B", "Email Address": "Not Specified", "_x": "hidden", "Skills": [{"name": "Py"}], "Phone Number": ""}},
    {"id": "missing-null", "script": [(200, ok_payload('{"score": 61, "verdict": "pass", "missing_critical": null}'), {})]},
]
jd_out = []
for flow in JD_FLOWS:
    sess = ScriptedSession(flow["script"])
    tr = llm.Transport(gate=llm.RateGate(2, cooldown_seconds=0.5), session_factory=lambda s=sess: s)
    cfg = {"LLM_API_KEY": "sk-test-key-0123456789", "LLM_BASE_URL": OPENROUTER + "/", "LLM_SCORING_MODEL": "s/model", "LLM_MAX_RETRIES": 2}
    cfg.update(flow.get("cfg", {}))
    try:
        res, meta = jd.score_resume("lbl", "JD text", cfg, tr, resume_text=flow.get("resume", "Resume text here"), extracted_fields=flow.get("fields"))
        if meta:
            meta.pop("latency_seconds", None)
        out = {"ok": True, "result": res, "meta": meta}
    except Exception as exc:
        out = {"ok": False, "error": type(exc).__name__}
    out["bodies"] = sess.bodies
    jd_out.append({"id": flow["id"], "flow": {k: v for k, v in flow.items() if k != "script"}, "script": [list(s) for s in flow["script"]], "out": out})
dump("jd-flows", jsonable(jd_out))
dump("jd-helpers", {
    "body": jd.build_scoring_body("m", "JD", "RESUME"),
    "fieldsToText": [{"fields": f, "out": jd._fields_to_text(f)} for f in [None, {}, {"Name": "A", "Skills": "B", "_x": 1}, {"A": "not specified", "B": "  ", "C": 0, "D": [], "E": "ok"}]],
    "passes": [{"result": r, "threshold": t, "out": jd.passes(r, t)} for r, t in [
        ({"verdict": "reject", "score": 49}, 50), ({"verdict": "reject", "score": 50}, 50), ({"verdict": "pass", "score": 0}, 50), ({"verdict": "cannot_determine", "score": 0}, 50)]],
    "constants": [jd.DEFAULT_SCORING_MODEL, jd.CANNOT_DETERMINE_LIMIT, jd.MIN_SCORED],
})

# ── zips ─────────────────────────────────────────────────────────────────────

ZIPS = FIX / "zips"


def make_zip(path, entries, compression=zipfile.ZIP_DEFLATED):
    with zipfile.ZipFile(path, "w", compression) as zf:
        for name, data in entries:
            zf.writestr(name, data)
    return path


make_zip(ZIPS / "mixed.zip", [
    ("batch/a/CV.pdf", b"%PDF-1.4 candidate one"), ("batch/b/CV.pdf", b"%PDF-1.4 candidate two"), ("c/CV.pdf", b"%PDF-1.4 candidate one"),
    ("roster.csv", b"a,b"), ("sheets/people.XLSX", b"x"), ("notes.txt", b"hello"), ("dir/", b""), ("UPPER.PDF", b"%PDF upper"),
    ("../../escape.pdf", b"%PDF escape"), ("win\\path\\Resume Final.pdf", b"%PDF win"), ("empty.pdf", b""),
])
make_zip(ZIPS / "bomb.zip", [("bomb.pdf", b"\x00" * (3 * 1024 * 1024)), ("ok.pdf", b"%PDF fine")])
make_zip(ZIPS / "many.zip", [(f"f{i}.pdf", b"%PDF-x") for i in range(501)])
make_zip(ZIPS / "exact.zip", [(f"f{i}.pdf", f"%PDF-x{i}".encode()) for i in range(500)])
make_zip(ZIPS / "sizes.zip", [("small.pdf", b"%PDF small"), ("large.pdf", b"z" * 6000), ("other.pdf", b"%PDF other")])
make_zip(ZIPS / "total.zip", [("a.pdf", b"x" * 4000), ("b.pdf", b"y" * 4000)])
make_zip(ZIPS / "stored.zip", [("s1.pdf", b"%PDF stored one"), ("s2.pdf", b"%PDF stored two")], zipfile.ZIP_STORED)
(ZIPS / "bad.zip").write_bytes(b"not a zip")
(ZIPS / "empty.zip").write_bytes(b"PK\x05\x06" + b"\x00" * 18)
# a stored entry whose payload is altered after writing: the CRC no longer matches
raw = bytearray((ZIPS / "stored.zip").read_bytes())
at = raw.find(b"stored one")
raw[at:at + 6] = b"TAMPER"
(ZIPS / "badcrc.zip").write_bytes(bytes(raw))
make_zip(ZIPS / "dupnames.zip", [("x/one.pdf", b"%PDF 1"), ("y/one.pdf", b"%PDF 2"), ("z/one.pdf", b"%PDF 3")])

MBX = 1024 * 1024
ZIP_CASES = [
    ("mixed.zip", {}), ("bomb.zip", {}), ("many.zip", {}), ("exact.zip", {}), ("sizes.zip", {"max_entry_bytes": 5000}),
    ("total.zip", {"max_total_bytes": 5000}), ("total.zip", {"max_total_bytes": 20000}), ("stored.zip", {}), ("bad.zip", {}),
    ("empty.zip", {}), ("badcrc.zip", {}), ("dupnames.zip", {}), ("bomb.zip", {"max_ratio": 100000.0}), ("mixed.zip", {"max_entries": 5}),
    ("sizes.zip", {"max_total_bytes": 6100}),
]
zip_out = []
for name, limits in ZIP_CASES:
    dest = Path(tempfile.mkdtemp())
    lim = zips.ZipLimits(**limits)
    try:
        result = zips.extract_zip(ZIPS / name, dest, lim)
        out = {"ok": True, "files": [{"sha256": f.sha256, "displayName": f.display_name, "source": f.source, "onDisk": f.path.name} for f in result.files],
               "skipped": [list(s) for s in result.skipped], "ignored": result.ignored, "dirListing": sorted(p.name for p in dest.iterdir())}
    except zips.ZipRejected as exc:
        out = {"ok": False, "message": str(exc), "dirListing": sorted(p.name for p in dest.iterdir())}
    shutil.rmtree(dest, ignore_errors=True)
    zip_out.append({"zip": name, "limits": limits, "out": out})
dump("zips", jsonable(zip_out))

# ── whole-pipeline golden ────────────────────────────────────────────────────

class Responder:
    """A deterministic fake provider: answers from the 'Test Person X' marker in the résumé text."""

    PEOPLE = {
        "A": ("Test Person A", "cand0@example.com", "9876543200"), "B": ("Test Person B", "cand1@example.com", "9876543201"),
        "C": ("Test Person C", "cand2@example.com", "9876543202"), "D": ("Test Person D", "cand3@example.com", "9876543200"),
    }

    def __init__(self):
        self.lock = threading.Lock()
        self.requests = []

    def post(self, url, headers=None, json=None, timeout=None):
        body = json
        is_score = (body.get("response_format") or {}).get("type") == "json_object"
        content = body["messages"][1]["content"]
        with self.lock:
            self.requests.append({"kind": "score" if is_score else "extract", "model": body["model"], "vision": isinstance(content, list)})
        if is_score:
            text = content
            verdict = {"score": 80, "verdict": "pass", "missing_critical": [], "reason": "good fit"} if "Kubernetes experience" in text.split("Candidate Resume:")[1] \
                else {"score": 20, "verdict": "reject", "missing_critical": ["Kubernetes"], "reason": "gap"}
            return _Resp(200, ok_payload(globals()["json"].dumps(verdict)))
        props = body["response_format"]["json_schema"]["schema"]["properties"]
        data = {k: ([] if "array" in (v.get("type") if isinstance(v.get("type"), list) else [v.get("type")]) else None) for k, v in props.items()}
        if isinstance(content, list):
            data.update({"name": "SCAN PERSON", "email": "scan@example.com", "phone": "+91 98765 43299", "location": "Pune", "graduation": "2020 - B.E"})
        else:
            m = re.search(r"Test Person ([A-Z])", content)
            if m:
                name, email, phone = self.PEOPLE[m.group(1)]
                data.update({"name": name, "email": email, "phone": phone, "location": "Bengaluru, India", "graduation": "2021 - B.Tech",
                             "skill_tags": ["Python"], "skill_details": [{"name": "Python", "proficiency": None, "years": None}]})
        return _Resp(200, ok_payload(globals()["json"].dumps(data)))


class _Exec:
    def __init__(self, fn):
        self._fn = fn

    def execute(self):
        return self._fn()


class FakeDriveFiles:
    def __init__(self, d):
        self.d = d

    def list(self, q="", fields=None, pageSize=None, pageToken=None, **_):
        folder = re.search(r"'([^']+)' in parents", q).group(1)

        def run():
            with self.d.lock:
                return {"files": [dict(f) for f in self.d.store.values() if folder in f["parents"]]}
        return _Exec(run)

    def create(self, body=None, media_body=None, fields=None, **_):
        def run():
            with self.d.lock:
                self.d.counter += 1
                fid = f"file{self.d.counter}"
                rec = {"id": fid, "name": body["name"], "parents": list(body.get("parents", [])), "appProperties": dict(body.get("appProperties") or {}),
                       "webViewLink": f"https://drive.google.com/file/d/{fid}/view"}
                self.d.store[fid] = rec
                return {"id": fid, "name": body["name"], "webViewLink": rec["webViewLink"]}
        return _Exec(run)


class FakeDrive:
    def __init__(self):
        self.store, self.lock, self.counter = {}, threading.Lock(), 0

    def files(self):
        return FakeDriveFiles(self)


class Ctx:
    def __init__(self, root, responder, drive_, config=None, options=None):
        root = Path(root)
        self.dirs = {n: root / n for n in ("input", "output", "old", "database", "logs", "cache")}
        for p in self.dirs.values():
            p.mkdir(parents=True, exist_ok=True)
        base = {"llmBaseUrl": OPENROUTER, "modelExtract": "test/extractor", "modelFallback": "test/fallback", "modelVision": "test/vision",
                "modelFallbackVision": "test/fallback-vision", "modelScoring": "test/scorer", "maxConcurrency": 3, "driveConcurrency": 2,
                "maxRetries": 1, "cooldownSeconds": 0.5, "jdFilterEnabled": False, "jdDryRun": True, "jdThreshold": 50, "writeUsageLog": True}
        self.config = {**base, **(config or {})}
        self.options = {"campaignType": "TECH", "platform": "Unstop", "driveFolderId": "folder-1", "parallel": 3, **(options or {})}
        self.secrets = {"openrouterApiKey": "sk-test-key-0123456789", "googleTokenJson": "{}"}
        self.events = []
        self.cancelled = threading.Event()
        self.drive = (lambda: drive_)
        self.http = responder
        self.fields = []
        self._lock = threading.Lock()

    def emit(self, kind, **data):
        with self._lock:
            self.events.append((kind, data))


def build_input(folder, scenario):
    folder = Path(folder)
    if scenario == "basic":
        for i in range(3):
            shutil.copy(PDF / f"cv{i}.pdf", folder / f"cv{i}.pdf")
    elif scenario == "mixed":
        shutil.copy(PDF / "cv0.pdf", folder / "cv0.pdf")
        (folder / "sub").mkdir()
        shutil.copy(PDF / "cv0.pdf", folder / "sub" / "same-bytes.pdf")           # duplicate content
        shutil.copy(PDF / "cv1.pdf", folder / "cv1.pdf")
        shutil.copy(PDF / "cv3.pdf", folder / "cv3.pdf")                          # same phone as cv0: in-batch duplicate
        shutil.copy(PDF / "scan.pdf", folder / "scan.pdf")                        # vision path
        shutil.copy(PDF / "corrupt.pdf", folder / "corrupt.pdf")                  # quarantined
        (folder / "roster.csv").write_text("a,b\n", encoding="utf-8")
        shutil.copy(ZIPS / "pipeline-batch.zip", folder / "batch.zip")             # one/CV.pdf = cv2, two/CV.pdf = cv1 (same bytes as cv1.pdf)
        shutil.copy(ZIPS / "bad.zip", folder / "bad.zip")                          # rejected archive
    elif scenario == "jd":
        for i in range(3):
            shutil.copy(PDF / f"cv{i}.pdf", folder / f"cv{i}.pdf")


def mask_csv(path):
    text = Path(path).read_text(encoding="utf-8-sig")
    return text


def run_scenario(scenario, config=None, options=None):
    root = Path(tempfile.mkdtemp())
    responder, drive_ = Responder(), FakeDrive()
    ctx = Ctx(root, responder, drive_, config=config, options=options)
    build_input(ctx.dirs["input"], scenario)
    result = pipeline.run_batch(ctx)
    csv_rows = None
    if result.csv_path:
        import csv as _csv
        with open(result.csv_path, encoding="utf-8-sig", newline="") as handle:
            reader = _csv.reader(handle)
            header = next(reader)
            csv_rows = {"header": header, "rows": [r for r in reader]}
            for r in csv_rows["rows"]:
                r[header.index("Date")] = "<date>"
                r[header.index("Resume")] = "<resume>" if r[header.index("Resume")].startswith("https://drive.google.com/file/d/file") else r[header.index("Resume")]
        csv_name_tag = re.match(r"batch_([A-Za-z0-9]+)_", Path(result.csv_path).name).group(1)
    else:
        csv_name_tag = None
    file_events = sorted([[d.get("name"), d.get("status"), d.get("detail")] for k, d in ctx.events if k == "file"])
    phases = [[d.get("phase"), d.get("detail"), d.get("total")] for k, d in ctx.events if k == "phase"]
    usage = [json.loads(l) for l in (ctx.dirs["output"] / "llm_usage.jsonl").read_text().splitlines()] if (ctx.dirs["output"] / "llm_usage.jsonl").exists() else []
    out = {
        "scenario": scenario, "config": config or {}, "options": options or {},
        "error": result.error, "cancelled": result.cancelled, "counts": result.counts, "cost": result.cost,
        "failedFiles": sorted(result.failed_files, key=lambda f: f["name"]), "csv": csv_rows, "csvTag": csv_name_tag,
        "rowsLen": len(result.rows), "fileEvents": file_events, "phases": phases,
        "processed": sorted(str(Path(p).relative_to(ctx.dirs["input"])).replace("\\", "/") for p in result.processed),
        "requests": {"extract": sum(1 for r in responder.requests if r["kind"] == "extract"), "score": sum(1 for r in responder.requests if r["kind"] == "score"),
                     "models": sorted({r["model"] for r in responder.requests if r["kind"] == "extract"}),
                     "visionCalls": sum(1 for r in responder.requests if r["vision"])},
        "driveFiles": sorted([f["name"] for f in drive_.store.values()]),
        "retry": (Path(result.retry_path).read_text(encoding="utf-8-sig") if result.retry_path else None),
        "databaseFiles": sorted(p.name for p in ctx.dirs["database"].iterdir()),
        "databaseIndex": ((ctx.dirs["database"] / "index.csv").read_text(encoding="utf-8-sig") if (ctx.dirs["database"] / "index.csv").exists() else None),
        "usageRuns": [{k: v for k, v in u.items() if k not in ("timestamp", "run_id")} for u in usage],
        "cacheLines": len((ctx.dirs["cache"] / "parse-cache.jsonl").read_text().splitlines()) if (ctx.dirs["cache"] / "parse-cache.jsonl").exists() else 0,
    }
    shutil.rmtree(root, ignore_errors=True)
    return out


JD_TEXT = "Senior Python developer with Kubernetes experience."
pipe_out = [
    run_scenario("basic"),
    run_scenario("mixed"),
    run_scenario("mixed", options={"campaignType": "SALES"}),
    run_scenario("jd", options={"jdFilter": True, "jd": JD_TEXT}),
    run_scenario("jd", config={"jdDryRun": False}, options={"jdFilter": True, "jd": "Rust Go developer.", "dryRun": False}),
    run_scenario("basic", options={"inputs": ["cv1.pdf"]}),
    run_scenario("basic", options={"driveFolderId": ""}),
    run_scenario("basic", config={"driveFolders": [{"name": "tech", "id": "F-TECH"}]}, options={"driveFolderId": ""}),
    run_scenario("basic", config={"driveFolders": {"TECH": "F-DICT"}}, options={"driveFolderId": ""}),
    run_scenario("basic", options={"jdFilter": True, "jd": ""}),
    run_scenario("basic", options={"jdFilter": True, "jd": JD_TEXT, "jdThreshold": 0}),
    run_scenario("basic", options={"platform": "LinkedIn"}),
]
dump("pipeline-runs", jsonable(pipe_out))
print("golden written to", OUT)
