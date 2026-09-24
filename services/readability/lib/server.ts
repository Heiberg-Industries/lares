import { createServer, type Server } from "node:http";
import { fetchAndExtract } from "./extract.js";

export function makeServer(opts: { token: string }): Server {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/extract") return send(404, { error: "not found" });
    if (req.headers["x-readability-token"] !== opts.token) return send(401, { error: "unauthorized" });
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on("end", async () => {
      let url = "";
      try { url = String(JSON.parse(raw).url ?? ""); } catch { return send(400, { error: "bad json" }); }
      try { send(200, await fetchAndExtract(url)); }
      catch (e) { const status = (e as { status?: number }).status ?? 500; send(status, { error: (e as Error).message }); }
    });
  });
}
