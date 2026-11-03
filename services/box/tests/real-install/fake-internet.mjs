// The outside world for real-install-image.probe.py: the model provider, the sign-in provider and an
// uptime check, answering at their real names over TLS from a throwaway test authority. Nothing in
// the installation knows these are stand-ins. Provider replies copy a real provider's shape,
// including `caller` on tool calls, which a real provider sends and earlier fixtures left out.
//
//   node fake-internet.mjs serve <fixture dir>    the stand-ins, on 443
//   node fake-internet.mjs forward <host>         every connection on 443 goes on to <host>:443, so
//                                                 a container reaches the public address the way a
//                                                 real server does: out, and back in through Caddy.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";

const [mode, target] = process.argv.slice(2);
if (mode === "forward") {
  net.createServer((client) => {
    const upstream = net.connect(443, target);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(443, "0.0.0.0");
} else {
  serve(target);
}

function serve(fixture) {
  const settings = JSON.parse(readFileSync(`${fixture}/settings.json`, "utf8"));
  const record = (entry) => appendFileSync(`${fixture}/calls.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = randomBytes(8).toString("hex");
  const codes = new Map();
  const base64url = (value) => Buffer.from(value).toString("base64url");

  function idToken(grant) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "https://accounts.google.com", aud: settings.clientId, azp: settings.clientId, sub: settings.subject, email: settings.email,
      email_verified: true, nonce: grant.nonce, iat: now, exp: now + 3600 };
    const signed = `${base64url(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
    return `${signed}.${createSign("RSA-SHA256").update(signed).sign(signingKey.privateKey).toString("base64url")}`;
  }

  function json(response, status, value) {
    const raw = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { "content-type": "application/json", "content-length": raw.length });
    response.end(raw);
  }

  function signIn(request, response, url, body) {
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(response, 200, {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["plain", "S256"],
      });
    }
    if (url.pathname === "/oauth2/v3/certs") {
      return json(response, 200, { keys: [{ ...signingKey.publicKey.export({ format: "jwk" }), use: "sig", alg: "RS256", kid: keyId }] });
    }
    if (url.pathname === "/o/oauth2/v2/auth") {
      const q = url.searchParams;
      if (q.get("client_id") !== settings.clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256")
        return json(response, 400, { error: "invalid_request" });
      const code = randomBytes(24).toString("base64url");
      codes.set(code, { nonce: q.get("nonce"), challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      record({ kind: "sign-in", step: "authorize", redirect: q.get("redirect_uri") });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state"));
      back.searchParams.set("iss", "https://accounts.google.com");
      response.writeHead(302, { location: back.href, "content-length": 0 });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(body.toString("utf8"));
      const grant = codes.get(form.get("code") ?? "");
      const presented = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      const basic = Buffer.from((request.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8").split(":").map(decodeURIComponent);
      const secret = form.get("client_secret") ?? basic[1];
      if (!grant || presented !== grant.challenge || form.get("redirect_uri") !== grant.redirect || secret !== settings.clientSecret)
        return json(response, 400, { error: "invalid_grant" });
      codes.delete(form.get("code"));
      record({ kind: "sign-in", step: "token" });
      return json(response, 200, { access_token: randomBytes(24).toString("base64url"), expires_in: 3599, scope: "openid email", token_type: "Bearer", id_token: idToken(grant) });
    }
    return json(response, 404, { error: "not_found" });
  }

  // Text of a message's blocks, whichever of the two shapes the provider API allows it arrived in.
  const textOf = (message) => typeof message?.content === "string" ? message.content
    : (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");

  function decide(body) {
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const toolNames = (body.tools ?? []).map((tool) => tool.name);
    const everything = messages.map(textOf).join("\n");
    if (blocks.some((block) => block.type === "tool_result")) {
      const called = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_use") : []).at(-1);
      return { text: called?.name === settings.approvalTool ? settings.approvalReply
        : called?.name === settings.noteTool ? settings.noteReply : settings.toolReply };
    }
    const asked = textOf(last);
    if (asked.includes(settings.approvalPrompt)) {
      return toolNames.includes(settings.approvalTool) ? { tool: settings.approvalTool, input: settings.approvalInput } : { text: "PROOF_NO_USABLE_TOOL" };
    }
    if (asked.includes(settings.notePrompt)) {
      return toolNames.includes(settings.noteTool) ? { tool: settings.noteTool, input: settings.noteInput } : { text: "PROOF_NO_USABLE_TOOL" };
    }
    if (asked.includes(settings.toolPrompt)) {
      const tool = settings.toolPreference.find((name) => toolNames.includes(name));
      if (tool) return { tool };
      return { text: "PROOF_NO_USABLE_TOOL" };
    }
    if (asked.includes(settings.followUpPrompt)) {
      const kept = everything.includes(settings.toolPrompt) && everything.includes(settings.toolReply);
      return { text: kept ? settings.followUpReply : "PROOF_HISTORY_LOST" };
    }
    return { text: "PROOF_OK" };
  }

  function provider(request, response, body) {
    let parsed;
    try { parsed = JSON.parse(body.toString("utf8")); } catch { return json(response, 400, { type: "error", error: { type: "invalid_request_error", message: "not json" } }); }
    if (!request.headers["x-api-key"] || request.headers["x-api-key"] !== settings.providerKey)
      return json(response, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const answer = decide(parsed);
    const toolCalls = (parsed.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_use") : []);
    const toolResults = (Array.isArray(parsed.messages?.at(-1)?.content) ? parsed.messages.at(-1).content : []).filter((block) => block.type === "tool_result");
    record({ kind: "model", model: parsed.model, toolResults: toolResults.map((block) => ({ isError: Boolean(block.is_error), content: JSON.stringify(block.content).slice(0, 300) })), stream: Boolean(parsed.stream), messages: (parsed.messages ?? []).length,
      lastText: textOf(parsed.messages?.at(-1)).slice(-200), tools: (parsed.tools ?? []).map((tool) => tool.name),
      returnedCallers: toolCalls.map((block) => block.caller ?? null), answer });
    const id = `msg_01${randomBytes(11).toString("hex")}`;
    const usage = { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 18, service_tier: "standard" };
    const headers = { "request-id": `req_01${randomBytes(11).toString("hex")}`, "anthropic-organization-id": "00000000-0000-4000-8000-000000000000" };
    const toolBlock = answer.tool ? { type: "tool_use", id: `toolu_01${randomBytes(11).toString("hex")}`, name: answer.tool, input: answer.input ?? {}, caller: { type: "direct" } } : null;
    const stopReason = toolBlock ? "tool_use" : "end_turn";
    if (!parsed.stream) {
      const raw = Buffer.from(JSON.stringify({ id, type: "message", role: "assistant", model: parsed.model, content: toolBlock ? [toolBlock] : [{ type: "text", text: answer.text, citations: null }],
        stop_reason: stopReason, stop_sequence: null, usage }));
      response.writeHead(200, { ...headers, "content-type": "application/json", "content-length": raw.length });
      return response.end(raw);
    }
    const events = [["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }]];
    if (toolBlock) {
      events.push(["content_block_start", { type: "content_block_start", index: 0, content_block: toolBlock }], ["ping", { type: "ping" }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } }], ["ping", { type: "ping" }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer.text } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }],
      ["message_stop", { type: "message_stop" }]);
    response.writeHead(200, { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "close" });
    for (const [kind, data] of events) response.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  }

  const tls = { key: readFileSync(`${fixture}/server-key.pem`), cert: readFileSync(`${fixture}/server.pem`) };
  https.createServer(tls, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const host = (request.headers.host ?? "").split(":")[0];
      const url = new URL(request.url, `https://${host}`);
      const body = Buffer.concat(chunks);
      if (host === "api.anthropic.com" && url.pathname === "/v1/messages" && request.method === "POST") return provider(request, response, body);
      if (host === settings.uptimeHost) { record({ kind: "uptime", path: url.pathname }); return json(response, 200, { ok: true }); }
      if (["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"].includes(host)) return signIn(request, response, url, body);
      record({ kind: "unexpected", host, path: url.pathname, method: request.method });
      return json(response, 404, { type: "error", error: { type: "not_found_error", message: "not found" } });
    });
  }).listen(443, "0.0.0.0");
}
