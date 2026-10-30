"""Local pages for reviewing explicitly prepared source-to-target corrections."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


TEMPLATE = Path(__file__).with_name("annotation_review.html")


def digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def case_spans(case):
    """Keep both ends of a manually specified move bound to one decision."""
    spans = []
    for edit in case["corrections"]:
        spans.append({**edit, "primary": True, "correction_id": edit["id"]})
        for removal in edit.get("linked_removals", []):
            spans.append({**removal, "primary": False, "correction_id": edit["id"]})
    return sorted(spans, key=lambda span: (span["start"], span["end"]))


def load_case(root, text_id):
    case = json.loads((root / "cases" / f"text-{text_id}.json").read_text())
    if case["text_id"] != text_id:
        raise ValueError("Case ID mismatch")
    actual_hash = hashlib.sha256(case["source"].encode()).hexdigest()
    if case["source_sha256"] != actual_hash:
        raise ValueError("Source hash mismatch")
    last_end = 0
    ids = [edit["id"] for edit in case["corrections"]]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate correction ID")
    for edit in case_spans(case):
        start, end = edit["start"], edit["end"]
        if not 0 <= start <= end <= len(case["source"]) or start < last_end:
            raise ValueError("Invalid or overlapping source spans")
        if edit["original"] != case["source"][start:end]:
            raise ValueError("Correction source span does not match")
        last_end = end
    return case


def render_target(case, corrections):
    decisions = {edit["id"]: edit for edit in corrections}
    parts, cursor = [], 0
    for edit in case_spans(case):
        decision = decisions[edit["correction_id"]]
        parts.append(case["source"][cursor:edit["start"]])
        parts.append(
            case["source"][edit["start"]:edit["end"]]
            if decision["status"] == "rejected"
            else decision["replacement"] if edit["primary"] else ""
        )
        cursor = edit["end"]
    return "".join(parts) + case["source"][cursor:]


def save_decision(root, case, request):
    case_hash = digest(case)
    if request.get("case_hash") != case_hash:
        raise ValueError("Case changed; reload before saving")
    text_id = case["text_id"]
    destination = root / "decisions" / f"text-{text_id}.json"
    previous = json.loads(destination.read_text()) if destination.exists() else None
    if request.get("previous_revision") != (previous or {}).get("revision"):
        raise ValueError("Review changed in another tab; reload before saving")
    if request.get("state") not in ("draft", "confirmed"):
        raise ValueError("Invalid review state")
    corrections = request.get("corrections")
    expected = {edit["id"] for edit in case["corrections"]}
    if (
        not isinstance(corrections, list)
        or len(corrections) != len(expected)
        or any(not isinstance(edit, dict) for edit in corrections)
        or {edit.get("id") for edit in corrections} != expected
    ):
        raise ValueError("Include every correction exactly once")
    labels = {label["id"] for label in case["error_types"]}
    originals = {edit["id"]: edit["original"] for edit in case["corrections"]}
    for edit in corrections:
        if edit.get("status") not in ("pending", "accepted", "rejected"):
            raise ValueError("Invalid correction decision")
        if not isinstance(edit.get("replacement"), str):
            raise ValueError("Replacement must be text (empty text means delete)")
        if edit.get("error_type_id") not in labels:
            raise ValueError("Select an existing error type")
        if request["state"] == "confirmed" and edit["status"] == "pending":
            raise ValueError("Accept or reject every correction before confirming")
        if (
            request["state"] == "confirmed"
            and edit["status"] == "accepted"
            and edit["replacement"] == originals[edit["id"]]
        ):
            raise ValueError("Accepted corrections must change the text; reject unchanged edits")
    target = render_target(case, corrections)
    if request.get("target") != target:
        raise ValueError("Preview differs from saved corrections; reload before saving")
    note = request.get("note", "")
    if not isinstance(note, str):
        raise ValueError("Review note must be text")
    body = {
        "format": "manual-annotation-review-decision-v1",
        "text_id": text_id,
        "case_hash": case_hash,
        "source_sha256": case["source_sha256"],
        "state": request["state"],
        "corrections": corrections,
        "target": target,
        "note": note,
        "revision": (previous or {}).get("revision", 0) + 1,
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    history = root / "history" / f"text-{text_id}"
    history.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(body, ensure_ascii=False, indent=2) + "\n"
    revision_path = history / f"revision-{body['revision']:06d}.json"
    with revision_path.open("x") as stream:
        stream.write(encoded)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(encoded)
    temporary.replace(destination)
    return body


def make_handler(root):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            # Browsers may preconnect without sending a request. Keep the single
            # server thread available while preserving sequential draft writes.
            self.request.settimeout(2)
            super().setup()

        def respond(self, status, body, content_type="application/json; charset=utf-8"):
            data = body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            try:
                if self.path == "/":
                    ids = sorted(int(p.stem.removeprefix("text-")) for p in (root / "cases").glob("text-*.json"))
                    links = "".join(f'<li><a href="/text/{i}.html">Review text {i}</a></li>' for i in ids)
                    self.respond(200, '<!doctype html><meta charset="utf-8"><title>Manual review</title>'
                                 '<style>body{font:20px system-ui;max-width:700px;margin:80px auto;'
                                 'background:#f5f4ef;color:#203b37}a{color:#167368}li{margin:20px 0}</style>'
                                 f'<h1>Manual annotation review</h1><ul>{links}</ul>', "text/html; charset=utf-8")
                    return
                page = re.fullmatch(r"/text/(\d+)\.html", self.path)
                api = re.fullmatch(r"/api/cases/(\d+)", self.path)
                if page:
                    load_case(root, int(page[1]))
                    self.respond(200, TEMPLATE.read_text(), "text/html; charset=utf-8")
                elif api:
                    case = load_case(root, int(api[1]))
                    saved_path = root / "decisions" / f"text-{api[1]}.json"
                    saved = json.loads(saved_path.read_text()) if saved_path.exists() else None
                    self.respond(200, {"case": case, "case_hash": digest(case), "saved": saved})
                else:
                    self.respond(404, {"error": "Page not found"})
            except FileNotFoundError:
                self.respond(404, {"error": "Case not prepared yet"})
            except (ValueError, KeyError) as exc:
                self.respond(422, {"error": str(exc)})

        def do_POST(self):
            match = re.fullmatch(r"/api/cases/(\d+)/decision", self.path)
            if not match:
                self.respond(404, {"error": "Page not found"})
                return
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{self.headers.get('Host')}":
                self.respond(403, {"error": "Use the local review page to save"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 2_000_000:
                    raise ValueError("Invalid request size")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError("Expected a review object")
                case = load_case(root, int(match[1]))
                self.respond(200, save_decision(root, case, request))
            except FileNotFoundError:
                self.respond(404, {"error": "Case not found"})
            except (ValueError, KeyError, TypeError) as exc:
                self.respond(422, {"error": str(exc)})

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("output/manual-review"))
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = HTTPServer(("127.0.0.1", args.port), make_handler(args.data_dir.resolve()))
    print(f"Manual review: http://127.0.0.1:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
