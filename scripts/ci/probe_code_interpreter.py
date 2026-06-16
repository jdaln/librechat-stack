#!/usr/bin/env python3
"""Two-step probe used by smoke.sh to assert the code-interpreter contract.

Step 1: a plain /exec call (basic forward path).
Step 2: /exec with a files[] entry carrying *only* `storage_session_id`.

Step 2 is the contract that broke when the running image was silently swapped
to a stock upstream LibreCodeInterpreter without the AliasChoices
("storage_session_id", "session_id") patch on RequestFile. Without this
assertion, every follow-up bash_tool / execute_code call in the UI would
422 silently (file injection from the prior turn is the trigger).

This script is run inside the LibreChat container by smoke.sh:
    docker exec -i LibreChat python3 < scripts/ci/probe_code_interpreter.py

LibreChat (GA v0.8.6+) ships no curl/jq, so we use stdlib urllib. An empty
ProxyHandler bypasses the egress proxy so the call goes direct to the
internal code-interpreter alias instead of through Squid.
"""

import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    api_key = os.environ["LIBRECHAT_CODE_API_KEY"]
    base = os.environ["LIBRECHAT_CODE_BASEURL"].rstrip("/")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def post(body):
        req = urllib.request.Request(
            f"{base}/exec",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "x-api-key": api_key},
        )
        try:
            with opener.open(req, timeout=120) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    # Step 1 — basic exec.
    status, body = post(
        {
            "lang": "py",
            "code": "print(2+2)",
            "entity_id": "ci-smoke",
            "user_id": "ci-smoke",
        },
    )
    print(f"STEP1 status={status} stdout={body.get('stdout')!r}")
    if status != 200 or body.get("stdout") != "4\n":
        print(f"STEP1 FAILED: {body}", file=sys.stderr)
        return 1

    # Step 2 — exec with files[] carrying storage_session_id only (no
    # session_id). Codeapi's RequestFile model must accept this alias.
    status, body = post(
        {
            "lang": "py",
            "code": "print(7+8)",
            "files": [
                {
                    "id": "ci-smoke-fake-file",
                    "resource_id": "ci-smoke",
                    "name": "smoke.txt",
                    "storage_session_id": "ci-smoke-session",
                    "kind": "user",
                }
            ],
        },
    )
    print(f"STEP2 status={status} body={json.dumps(body)[:200]}")
    if status != 200:
        print(
            "STEP2 FAILED: codeapi rejected storage_session_id alias on files[]. "
            "Image likely missing the AliasChoices('storage_session_id','session_id') "
            "patch on RequestFile. Verify CODE_INTERPRETER_IMAGE in .env points "
            "at the locally-built image, not a stock upstream tag.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
