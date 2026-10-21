"""Manual, billed provider-wire evidence probe. LAST RUN: UNRUN.

Run one explicitly selected mode per invocation after separate spending approval:
  I_UNDERSTAND_THIS_SPENDS_MONEY=1 python3 -B <this-file> \
    --profile <reviewed-profile.json> --key-file <protected-provider-key-file> \
    --provider anthropic --model <exact-profile-model> --mode stream \
    --max-output-tokens 16

This reads the adapter's actual WireEvidence parser, makes exactly one tiny synthetic
request, and prints only fixed labels and the validated terminal-counts digest. It does
not exercise gateway authentication, admission, native policy, prices or recovery. No
automatic run, administration, account creation, redirects, retries or SDK synthesis.
"""
import argparse
import hashlib
import http.client
import os
import pathlib
import ssl
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "images/gateway-runtime"))
from admission_contract import (
    MAX_RESPONSE_BYTES, PHYSICAL_BODY_SECONDS, PHYSICAL_HEADER_SECONDS,
    Profile, Refused, WireEvidence, canonical, parse_json,
)

MAX_PROBE_OUTPUT_TOKENS = 32
MAX_KEY_BYTES = 4096
WORKER_DEADLINE_SECONDS = PHYSICAL_HEADER_SECONDS + PHYSICAL_BODY_SECONDS + 2


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        # argparse's normal errors can echo arbitrary caller-provided values.
        self.exit(2, "FAIL: invalid probe arguments; use --help.\n")


def arguments(argv):
    parser = Arguments(description="Manual billed provider usage evidence; one request, no response content output.")
    parser.add_argument("--profile", required=True, help="Existing reviewed adapter profile file")
    parser.add_argument("--key-file", required=True, help="Existing protected provider key file (not a gateway/master/service key)")
    parser.add_argument("--provider", required=True, choices=("openai", "anthropic"))
    parser.add_argument("--model", required=True, help="Exact model from the reviewed profile")
    parser.add_argument("--mode", required=True, choices=("stream", "nonstream"))
    parser.add_argument("--max-output-tokens", required=True, type=int, help="Explicit integer from 1 to 32, within profile cap")
    return parser.parse_args(argv)


def provider_key(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077: raise Refused()
        raw = source.read(MAX_KEY_BYTES + 1)
    if len(raw) > MAX_KEY_BYTES: raise Refused()
    value = raw.decode("ascii").strip()
    if not value or any(ord(char) < 33 or ord(char) > 126 for char in value): raise Refused()
    return value


def probe(args):
    # Guard before files, credentials, TLS setup or any connection can be accessed.
    if os.environ.get("I_UNDERSTAND_THIS_SPENDS_MONEY") != "1": raise Refused()
    with pathlib.Path(args.profile).open("rb") as source:
        raw_profile = source.read(MAX_RESPONSE_BYTES + 1)
    if len(raw_profile) > MAX_RESPONSE_BYTES: raise Refused()
    profile = Profile(parse_json(raw_profile))
    p = profile.document
    if args.provider != p["provider"] or args.model != p["model"]: raise Refused()
    if not 1 <= args.max_output_tokens <= min(MAX_PROBE_OUTPUT_TOKENS, p["maxOutputTokens"]): raise Refused()
    key = provider_key(args.key_file)
    streaming = args.mode == "stream"
    document = {"model": args.model, "messages": [{"role": "user", "content": "Reply with OK."}], "max_tokens": args.max_output_tokens, "stream": streaming}
    headers = {"content-type": "application/json", "accept-encoding": "identity"}
    if args.provider == "anthropic":
        headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
        suffix = "/v1/messages"
    else:
        headers["authorization"] = "Bearer " + key
        if streaming: document["stream_options"] = {"include_usage": True}
        suffix = "/chat/completions"
    url = urlsplit(p["providerBaseUrl"])
    path = url.path.rstrip("/") + suffix
    # http.client follows no redirects and implements no request retry loop.
    connection = http.client.HTTPSConnection(url.hostname, port=url.port, context=ssl.create_default_context(), timeout=PHYSICAL_HEADER_SECONDS)
    try:
        header_deadline = time.monotonic() + PHYSICAL_HEADER_SECONDS
        connection.connect()
        sock = connection.sock
        sock.settimeout(max(.001, header_deadline - time.monotonic()))
        connection.request("POST", path, body=canonical(document), headers=headers)
        sock.settimeout(max(.001, header_deadline - time.monotonic()))
        response = connection.getresponse()
        if time.monotonic() >= header_deadline or response.getheader("content-encoding", "identity").lower() != "identity": raise Refused()
        evidence = WireEvidence(args.provider, response.getheader("content-type", ""), response.status)
        if evidence.poisoned or evidence.sse != streaming: raise Refused()
        deadline = time.monotonic() + PHYSICAL_BODY_SECONDS
        # Keep the connected socket reference even if HTTPResponse detaches it.
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise Refused()
            sock.settimeout(remaining)
            chunk = response.read1(min(8192, MAX_RESPONSE_BYTES + 1 - evidence.total))
            if not chunk: break
            evidence.feed(chunk)
            if evidence.poisoned: raise Refused()
        usage = evidence.finish()
        if usage is None: raise Refused()
        return {"format": args.provider, "mode": args.mode, "success": True, "terminalCountsDigest": hashlib.sha256(canonical(usage)).hexdigest()}
    finally:
        connection.close()


def worker_main(argv=None):
    args = arguments(argv)
    try:
        result = probe(args)
    except (Exception, KeyboardInterrupt):
        # Exception repr/traceback can contain provider URLs, headers or response text.
        print("FAIL: probe refused or terminal provider usage was not verified.", file=sys.stderr)
        return 1
    print(canonical(result).decode("ascii"))
    return 0


def bounded_worker(command, deadline):
    # A separate process gives DNS, trickled HTTP framing and cleanup one absolute
    # deadline, independent of socket per-read timers. Timeout kills and reaps it.
    return subprocess.run(command, text=True, capture_output=True, timeout=deadline, check=False)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    args = arguments(argv) # --help never launches a worker.
    try:
        if os.environ.get("I_UNDERSTAND_THIS_SPENDS_MONEY") != "1": raise Refused()
        code = "import runpy,sys; m=runpy.run_path(sys.argv[1]); sys.exit(m['worker_main'](sys.argv[2:]))"
        child = bounded_worker([sys.executable, "-B", "-c", code, str(pathlib.Path(__file__).resolve()), *argv], WORKER_DEADLINE_SECONDS)
        if child.returncode != 0 or len(child.stdout) > 1024: raise Refused()
        result = parse_json(child.stdout)
        if set(result) != {"format", "mode", "success", "terminalCountsDigest"} or result["format"] != args.provider or result["mode"] != args.mode or result["success"] is not True: raise Refused()
        digest = result["terminalCountsDigest"]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest): raise Refused()
    except (Exception, KeyboardInterrupt):
        print("FAIL: probe refused or terminal provider usage was not verified.", file=sys.stderr)
        return 1
    print(canonical(result).decode("ascii"))
    return 0


if __name__ == "__main__": sys.exit(main())
