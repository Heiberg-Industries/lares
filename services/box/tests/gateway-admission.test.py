"""Offline tests. Native LiteLLM/client compatibility is proved separately in CI."""
import asyncio
import importlib.util
import json
import pathlib
import unittest
from unittest import mock
import ast
import io
import gzip
import http.server
import threading
import time
import uuid
import hashlib
import subprocess
import tempfile
import os
import base64
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
import sys
sys.path.insert(0, str(ROOT / "images/gateway-runtime"))
from admission_contract import RequestState, Refused, request_hash, sign, verify, parse_json, Profile, TerminalEvidence, WireEvidence, MAX_RESPONSE_BYTES


class ContractTests(unittest.TestCase):
    def test_raw_bytes_and_route_are_bound(self):
        a = request_hash("POST", "/v1/messages", b'{"a":1}')
        self.assertNotEqual(a, request_hash("POST", "/v1/messages", b'{ "a":1}'))
        self.assertNotEqual(a, request_hash("POST", "/v1/chat/completions", b'{"a":1}'))

    def test_signature_separates_request_response_and_exact_bytes(self):
        key = bytes(range(32))
        signature = sign(key, "request", "POST", "/v1/admit", b'{}')
        self.assertTrue(verify(key, signature, "request", "POST", "/v1/admit", b'{}'))
        for direction, path, body in [("response", "/v1/admit", b'{}'), ("request", "/v1/settle", b'{}'), ("request", "/v1/admit", b'{ }')]:
            self.assertFalse(verify(key, signature, direction, "POST", path, body))

    def test_duplicate_json_fields_and_nonfinite_numbers_refuse(self):
        for body in [b'{"model":"a","model":"b"}', b'{"n":NaN}', b'{"n":1e999}', b'[]']:
            with self.assertRaises(Refused): parse_json(body)

    def test_expiry_and_dispatch_are_forward_only(self):
        state = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        state.arm(12)
        state.burn(now=11)
        for now in [11, 20]:
            with self.assertRaises(Refused): state.burn(now=now)
        late = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        late.arm(11)
        with self.assertRaises(Refused): late.burn(now=11)
        with self.assertRaises(Refused): late.arm(20)

    def test_requests_do_not_share_a_right(self):
        a = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        b = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        self.assertNotEqual(a.nonce, b.nonce)
        a.arm(12); b.arm(12); a.burn(now=11); b.burn(now=11)

    def test_closed_state_cannot_be_rearmed_by_a_child_context(self):
        state = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        state.arm(12); state.close()
        with self.assertRaises(Refused): state.burn(now=11)
        with self.assertRaises(Refused): state.arm(20)

    def test_profile_refuses_unbounded_or_override_requests(self):
        profile = Profile({"version":1,"provider":"openai","model":"gpt-4o-mini","providerBaseUrl":"https://provider.example.invalid/v1","aliases":["lares-brain","lares-writer","lares-utility","lares-gate"],"maxBodyBytes":4096,"maxOutputTokens":123})
        body = {"model":"lares-brain","messages":[{"role":"user","content":"hello"}],"max_tokens":123}
        self.assertEqual(profile.check_body("/v1/messages", json.dumps(body).encode()), body)
        for extra in [{"max_tokens":124},{"api_base":"https://elsewhere.invalid"},{"num_retries":2},{"metadata":{"user_id":"spoof"}},{"n":2},{"rust":True},{"user_config":{}}]:
            with self.assertRaises(Refused): profile.check_body("/v1/messages", json.dumps({**body,**extra}).encode())
        for content in [[{"type":"image_url","image_url":{"url":"https://outside.invalid/picture"}}], [{"type":"document","source":{"type":"url","url":"https://outside.invalid"}}]]:
            with self.assertRaises(Refused): profile.check_body("/v1/messages", json.dumps({**body,"messages":[{"role":"user","content":content}]}).encode())
        with self.assertRaises(TypeError): profile.document["maxOutputTokens"] = 999
        with self.assertRaises(TypeError): profile.document["aliases"][0] = "changed"

    def test_only_exact_terminal_anthropic_stream_settles(self):
        start = {"type":"message_start","message":{"id":"msg_fixture","usage":{"input_tokens":12,"output_tokens":0,"cache_read_input_tokens":0}}}
        delta = {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}
        stop = {"type":"message_stop"}
        good = TerminalEvidence("/v1/messages")
        for chunk in [start,delta,stop]: good.feed(chunk)
        self.assertEqual(good.result()["outputTokens"], 4)
        for chunks in [[start,stop],[start,delta],[start,{**delta,"usage":{}},stop],[start,{**delta,"usage":{"output_tokens":-1}},stop],[start,delta,{**delta,"usage":{"output_tokens":3}},stop],[start,delta,{"error":{}},stop]]:
            evidence = TerminalEvidence("/v1/messages")
            for chunk in chunks: evidence.feed(chunk)
            self.assertIsNone(evidence.result())


class EmbeddedFixtureTests(unittest.TestCase):
    """Exercise the actual generated fixture wire bytes without Docker or a socket."""
    @classmethod
    def setUpClass(cls):
        module = ast.parse((ROOT / "services/keeper/tests/gateway-admission-image.probe.py").read_text())
        cls.scripts = {node.targets[0].id: ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ("FIXTURE", "CLIENT")}
        for script in cls.scripts.values():
            assert "\\\\n" not in script and "\\\\0" not in script
        cls.fixture_ast = ast.parse(cls.scripts["FIXTURE"])
        with tempfile.NamedTemporaryFile(suffix=".mjs") as source:
            source.write(cls.scripts["CLIENT"].encode());source.flush()
            subprocess.run(["node", "--check", source.name], check=True, capture_output=True)

    def fixture_request(self, provider, mode="normal", stream=True, path=None):
        from admission_contract import canonical, ADMIT_PATH, SETTLE_PATH
        release=threading.Event();release.set()
        namespace={"http":http,"ssl":None,"threading":threading,"json":json,"time":time,"pathlib":pathlib,"hashlib":hashlib,"uuid":uuid,"sys":sys,"gzip":gzip,"sign":sign,"verify":verify,"canonical":canonical,"ADMIT_PATH":ADMIT_PATH,"SETTLE_PATH":SETTLE_PATH,"key":bytes(range(32)),"lock":threading.Lock(),"release":release}
        data_node=next(n for n in self.fixture_ast.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id=="data")
        handler_node=next(n for n in self.fixture_ast.body if isinstance(n,ast.ClassDef))
        exec(compile(ast.Module(body=[data_node,handler_node],type_ignores=[]),"fixture-definitions","exec"),namespace)
        namespace["data"]["mode"]=mode
        handler=namespace["Handler"].__new__(namespace["Handler"])
        handler.path=path or ("/v1/messages" if provider=="anthropic" else "/v1/chat/completions")
        raw=json.dumps({"model":"fixture-model","messages":[{"role":"user","content":"fixture"}],"stream":stream}).encode()
        handler.headers={"content-length":str(len(raw))};handler.rfile=io.BytesIO(raw);handler.wfile=io.BytesIO();headers={}
        handler.send_response=lambda status:headers.update(status=status)
        handler.send_header=lambda key,value:headers.update({key:value})
        handler.end_headers=lambda:None
        handler.do_POST()
        return handler.wfile.getvalue(),headers,namespace["data"]

    def test_fixture_sse_is_real_framing_and_validates_actual_usage(self):
        for provider in ("openai","anthropic"):
            wire,headers,data=self.fixture_request(provider)
            self.assertIn(b"\n\n",wire);self.assertNotIn(b"\\n",wire)
            evidence=WireEvidence(provider,headers["content-type"],headers["status"])
            for start in range(0,len(wire),7):evidence.feed(wire[start:start+7])
            self.assertEqual(evidence.finish()["outputTokens"],4)
            self.assertEqual(data["upstream"],1)
            for mode in ("partial","malformed-usage","missing-finish","late-content","mixed-id","compressed"):
                wire,headers,_=self.fixture_request(provider,mode)
                evidence=WireEvidence(provider,headers["content-type"],headers["status"])
                evidence.feed(wire)
                self.assertIsNone(evidence.finish(),(provider,mode))

    def test_unknown_physical_routes_are_counted(self):
        _,headers,data=self.fixture_request("openai",path="/v1/responses")
        self.assertEqual(headers["status"],404)
        self.assertEqual(data["upstream"],1);self.assertEqual(data["routes"]["other"],1)

    def test_embedded_node_hash_matches_raw_bytes_after_shaping(self):
        code=self.scripts["CLIENT"]
        expression=code.split("hash=createHash('sha256')",1)[1].split(".digest('hex')",1)[0]
        raw='{"model":"lares-brain", "text":"ø cache_control"}'.encode()
        script="import{createHash}from'node:crypto';const path='/v1/messages';const init={body:Buffer.from("+json.dumps(list(raw))+")};console.log(createHash('sha256')"+expression+".digest('hex'));"
        result=subprocess.run(["node","--input-type=module","-e",script],text=True,capture_output=True,check=True).stdout.strip()
        self.assertEqual(result,request_hash("POST","/v1/messages",raw))

    def test_live_usage_probe_help_and_spending_guard_are_offline(self):
        path=ROOT / "services/keeper/tests/live/gateway-provider-usage.live.py"
        compile(path.read_text(),str(path),"exec")
        help_result=subprocess.run([sys.executable,"-B",str(path),"--help"],text=True,capture_output=True,check=True)
        self.assertIn("--max-output-tokens",help_result.stdout)
        arguments=["--profile","/nonexistent/probe-private-profile","--key-file","/nonexistent/probe-private-key","--provider","anthropic","--model","probe-private-model","--mode","stream","--max-output-tokens","8"]
        environment={**os.environ,"I_UNDERSTAND_THIS_SPENDS_MONEY":"0"}
        result=subprocess.run([sys.executable,"-B",str(path),*arguments],env=environment,text=True,capture_output=True)
        self.assertEqual(result.returncode,1)
        self.assertEqual(result.stdout,"")
        self.assertEqual(result.stderr,"FAIL: probe refused or terminal provider usage was not verified.\n")
        invalid=subprocess.run([sys.executable,"-B",str(path),*arguments,"--provider","private-invalid-value"],env=environment,text=True,capture_output=True)
        self.assertEqual(invalid.returncode,2)
        self.assertNotIn("private-invalid-value",invalid.stderr)

    def test_live_usage_worker_has_an_absolute_process_deadline(self):
        path=ROOT / "services/keeper/tests/live/gateway-provider-usage.live.py"
        spec=importlib.util.spec_from_file_location("live_usage_probe",path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        started=time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            module.bounded_worker([sys.executable,"-c","import time; time.sleep(60)"],.05)
        self.assertLess(time.monotonic()-started,2)

    def test_ci_startup_diagnostics_are_bounded_and_redacted(self):
        path=ROOT / "services/keeper/tests/gateway-admission-image.probe.py"
        spec=importlib.util.spec_from_file_location("admission_image_probe",path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        secret=b"sk-fixture-password-PRIVATE"
        service=bytes(range(32))
        representations=[secret.decode(),secret.hex(),repr(secret),base64.b64encode(secret).decode(),base64.urlsafe_b64encode(secret).decode().rstrip("="),repr(service),service.hex()]
        raw=json.dumps({"log":"\n".join(representations)+" https://user:PRIVATE@example.invalid/path Authorization: Bearer PRIVATE"})
        clean=module.sanitize_diagnostic(raw,[secret,service])
        self.assertNotIn("PRIVATE",clean);self.assertNotIn("example.invalid",clean)
        for representation in representations:self.assertNotIn(json.dumps(representation)[1:-1],clean)
        self.assertNotIn("PRIVATE",module.sanitize_diagnostic('{"token":"PRIVATE"}',[]))
        bounded=module.bounded_capture(sys.executable,"-c","print('safe-line');print('x'*10000)",maximum=80,seconds=1)
        self.assertIn("safe-line",bounded);self.assertIn("truncated",bounded);self.assertLess(len(bounded),160)
        started=time.monotonic()
        module.bounded_capture(sys.executable,"-c","import time;time.sleep(60)",seconds=.05)
        self.assertLess(time.monotonic()-started,2)

    def test_first_startup_failure_survives_shutdown_and_requires_both_ci_flags(self):
        source=ast.parse((ROOT / "images/gateway-runtime/lares_gateway.py").read_text())
        names={"STARTUP_STATE_FILE","STARTUP_FAILURE_FILE","STARTUP_PHASES","STARTUP_STAGES"}
        selected=[node for node in source.body if (isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) and node.targets[0].id in names) or (isinstance(node,ast.FunctionDef) and node.name=="record_startup_diagnostic")]
        from admission_contract import canonical
        namespace={"os":os,"pathlib":pathlib,"tempfile":tempfile,"canonical":canonical}
        exec(compile(ast.Module(body=selected,type_ignores=[]),"startup-diagnostic","exec"),namespace)
        probe_path=ROOT / "services/keeper/tests/gateway-admission-image.probe.py"
        spec=importlib.util.spec_from_file_location("startup_marker_probe",probe_path)
        probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
        self.assertEqual(namespace["STARTUP_PHASES"],probe.STARTUP_PHASES)
        self.assertEqual(namespace["STARTUP_STAGES"],probe.STARTUP_STAGES)
        with tempfile.TemporaryDirectory() as folder:
            state_file=pathlib.Path(folder)/"state.json";failure_file=pathlib.Path(folder)/"failure.json"
            namespace.update(STARTUP_STATE_FILE=str(state_file),STARTUP_FAILURE_FILE=str(failure_file))
            record=namespace["record_startup_diagnostic"]
            for environment in ({"CI":"false","LARES_GATEWAY_PROBE_DIAGNOSTICS":"1"},{"CI":"true","LARES_GATEWAY_PROBE_DIAGNOSTICS":"0"}):
                with mock.patch.dict(os.environ,environment):record("process-starting")
                self.assertFalse(state_file.exists())
            with mock.patch.dict(os.environ,{"CI":"true","LARES_GATEWAY_PROBE_DIAGNOSTICS":"1"}):
                record("process-starting");record("preflight-passed");record("native-lifespan-complete")
                record("runtime-validation-failed","callback-registry")
                record("native-lifespan-error","complete")
                first=failure_file.read_bytes()
                self.assertEqual(probe.validated_startup_marker(first),{"phase":"runtime-validation-failed","stage":"callback-registry"})
                record("PRIVATE","PRIVATE")
                self.assertEqual(first,failure_file.read_bytes())
            self.assertEqual(probe.validated_startup_marker(b'{"phase":"PRIVATE","stage":"PRIVATE"}'),"unknown")
            self.assertEqual(probe.validated_startup_marker(b'x'*1025),"unknown")
            archive_bytes=io.BytesIO()
            with tarfile.open(fileobj=archive_bytes,mode="w") as archive:
                info=tarfile.TarInfo("failure.json");info.size=len(first);archive.addfile(info,io.BytesIO(first))
            self.assertEqual(probe.startup_marker_from_archive(archive_bytes.getvalue(),"failure.json"),probe.validated_startup_marker(first))
            self.assertEqual(probe.startup_marker_from_archive(b"not tar","failure.json"),"unknown")
            noisy="Gateway admission runtime validation failed: callback-registry\n"+"shutdown traceback\n"*10000
            self.assertEqual(probe.fixed_startup_log_markers(noisy),["runtime-validation-failed:callback-registry"])

    def test_only_exact_terminal_openai_stream_settles(self):
        done = {"id":"completion_fixture","choices":[{"index":0,"finish_reason":"stop"}]}
        final = {"id":"completion_fixture","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}
        good = TerminalEvidence("/v1/chat/completions")
        for chunk in [done,final]: good.feed(chunk)
        self.assertEqual(good.result()["outputTokens"],4)
        for chunks in [[done],[final],[done,{**final,"usage":{"prompt_tokens":12,"completion_tokens":4}}],[done,{**final,"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":15}}],[done,{**final,"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":-1}}}],[done,final,final]]:
            evidence = TerminalEvidence("/v1/chat/completions")
            for chunk in chunks: evidence.feed(chunk)
            self.assertIsNone(evidence.result())

    def test_nonstream_needs_terminal_marker_and_valid_aggregate(self):
        anthropic = TerminalEvidence("/v1/messages")
        openai = TerminalEvidence("/v1/chat/completions")
        self.assertIsNone(anthropic.nonstream({"type":"message","stop_reason":None,"usage":{"input_tokens":12,"output_tokens":4}}))
        self.assertIsNone(openai.nonstream({"choices":[{"finish_reason":None}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}))
        self.assertIsNone(openai.nonstream({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}))
        self.assertIsNone(anthropic.nonstream({"type":"message","stop_reason":"end_turn","usage":{"input_tokens":12}}))

    def test_actual_wire_stream_requires_complete_termination(self):
        done = {"id":"completion_fixture","choices":[{"index":0,"finish_reason":"stop"}]}
        final = {"id":"completion_fixture","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}
        wire = b"".join(b"data: "+json.dumps(item).encode()+b"\n\n" for item in [done,final])+b"data: [DONE]\n\n"
        evidence = WireEvidence("openai","text/event-stream",200)
        for byte in wire: evidence.feed(bytes([byte]))
        self.assertEqual(evidence.finish()["outputTokens"],4)
        for bad in [wire[:-1],wire.replace(b"data: [DONE]\n\n",b""),wire+b"data: {}\n\n",wire.replace(b'"total_tokens": 16',b'"total_tokens": -1')]:
            evidence=WireEvidence("openai","text/event-stream",200);evidence.feed(bad)
            self.assertIsNone(evidence.finish())
        too_big=WireEvidence("openai","application/json",200)
        too_big.feed(b" "*(MAX_RESPONSE_BYTES+1))
        self.assertIsNone(too_big.finish());self.assertEqual(too_big.buffer,b"")

    def test_late_content_and_mixed_stream_ids_poison_usage(self):
        done={"id":"one","choices":[{"index":0,"finish_reason":"stop"}]}
        usage={"id":"one","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}
        for late in [{"id":"one","choices":[{"index":0,"delta":{"content":"late"},"finish_reason":None}]},{**usage,"id":"two"}]:
            evidence=TerminalEvidence("/v1/chat/completions")
            for chunk in [done,usage,late]:evidence.feed(chunk)
            self.assertIsNone(evidence.result())


if __name__ == "__main__": unittest.main()
