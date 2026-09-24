// Tests for lib/telegram-photo.ts's sendTelegramPhoto (Fix Wave B, Finding 3).
//
// These assert the STRUCTURAL shape of the multipart request (a real undici FormData body
// with the expected fields, POSTed to the right URL) against a mocked `fetch` — this
// environment cannot make a real network call to Telegram, so the wire format is verified as
// far as a mock allows: FormData/Blob construction, field names, and the HTML-then-plain
// caption fallback sequence. It does NOT prove Telegram's servers accept the resulting
// request — that needs a real Telegram bot token and a live send, which is out of reach here.
import { describe, it, expect, vi } from "vitest";
import { sendTelegramPhoto } from "../lib/telegram-photo.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("sendTelegramPhoto", () => {
  it("POSTs a real multipart FormData body to /bot<token>/sendPhoto with the photo as a Blob", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return jsonResponse({ ok: true, result: { message_id: 42 } });
    }) as unknown as typeof fetch;

    const photo = new Uint8Array([1, 2, 3, 4]);
    const result = await sendTelegramPhoto({
      chatId: "-100123",
      photo,
      botToken: "test-token",
      fetch: fetchMock,
    });

    expect(result).toEqual({ id: "42", raw: { ok: true, result: { message_id: 42 } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bottest-token/sendPhoto");
    expect(calls[0]!.init.method).toBe("POST");

    // undici's FormData/File are distinct classes from Node's globals — not `instanceof`
    // compatible with them — so this asserts duck-typed shape (the real multipart contract)
    // rather than a same-realm class identity that undici deliberately doesn't share.
    const body = calls[0]!.init.body as FormData;
    expect(typeof body.get).toBe("function");
    expect(typeof body.append).toBe("function");
    expect(body.get("chat_id")).toBe("-100123");
    const photoField = body.get("photo") as { type: string; size: number; name?: string };
    expect(photoField.type).toBe("image/jpeg");
    expect(photoField.size).toBe(4);
    expect(photoField.name).toBe("photo.jpg");
    // No caption was given — the caption/parse_mode fields must be entirely absent, not empty.
    expect(body.has("caption")).toBe(false);
    expect(body.has("parse_mode")).toBe(false);
  });

  it("sends an HTML caption with parse_mode: HTML on the first attempt", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 1 } })) as unknown as typeof fetch;

    await sendTelegramPhoto({
      chatId: "1",
      photo: new Uint8Array([9]),
      caption: "**Chez Fonfon** — [kart](https://maps.example/?a=1&b=2)",
      botToken: "tok",
      fetch: fetchMock,
    });

    const init = (fetchMock as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1];
    const body = init.body as FormData;
    expect(body.get("parse_mode")).toBe("HTML");
    expect(body.get("caption")).toBe('<b>Chez Fonfon</b> — <a href="https://maps.example/?a=1&amp;b=2">kart</a>');
  });

  it("retries with a plain-text caption when the HTML attempt is rejected — the photo still sends", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return jsonResponse({ ok: false, description: "can't parse entities" }, false, 400);
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    }) as unknown as typeof fetch;

    const result = await sendTelegramPhoto({
      chatId: "1",
      photo: new Uint8Array([9]),
      caption: "**Broken <caption",
      botToken: "tok",
      fetch: fetchMock,
    });

    expect(result.id).toBe("7");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = (fetchMock as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[1]![1];
    const secondBody = secondInit.body as FormData;
    expect(secondBody.has("parse_mode")).toBe(false); // plain-text fallback carries no parse_mode
    expect(secondBody.get("caption")).toBe("Broken <caption");
  });

  it("resolves the bot token via the injected credential provider, never hardcoding it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 1 } })) as unknown as typeof fetch;

    await sendTelegramPhoto({
      chatId: "1",
      photo: new Uint8Array([1]),
      botToken: async () => "async-token",
      fetch: fetchMock,
    });

    const url = (fetchMock as unknown as { mock: { calls: [string, unknown][] } }).mock.calls[0]![0];
    expect(url).toContain("/botasync-token/sendPhoto");
  });

  it("sends a pre-rendered HTML caption as-is, never re-escaping already-real tags", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 3 } })) as unknown as typeof fetch;

    await sendTelegramPhoto({
      chatId: "1",
      photo: new Uint8Array([1]),
      captionHtml: '<b>🧭 Hotel</b>\n⭐ <a href="https://maps.example/?a=1&amp;b=2">Joe\'s Pizza</a> (4.7★)',
      botToken: "tok",
      fetch: fetchMock,
    });

    const init = (fetchMock as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1];
    const body = init.body as FormData;
    expect(body.get("parse_mode")).toBe("HTML");
    // Passed through verbatim — no double-escaping of the already-real <b>/<a> tags.
    expect(body.get("caption")).toBe('<b>🧭 Hotel</b>\n⭐ <a href="https://maps.example/?a=1&amp;b=2">Joe\'s Pizza</a> (4.7★)');
  });

  it("falls back to tag-stripped plain text when a captionHtml attempt is rejected", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return jsonResponse({ ok: false, description: "can't parse entities" }, false, 400);
      return jsonResponse({ ok: true, result: { message_id: 9 } });
    }) as unknown as typeof fetch;

    await sendTelegramPhoto({
      chatId: "1",
      photo: new Uint8Array([1]),
      captionHtml: '<b>🧭 Hotel</b>\n<a href="https://maps.example">Joe\'s Pizza</a>',
      botToken: "tok",
      fetch: fetchMock,
    });

    const secondInit = (fetchMock as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[1]![1];
    const secondBody = secondInit.body as FormData;
    expect(secondBody.has("parse_mode")).toBe(false);
    expect(secondBody.get("caption")).toBe("🧭 Hotel\nJoe's Pizza");
  });

  it("throws when Telegram rejects the plain-text retry too (never silently swallows)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, description: "chat not found" }, false, 400)) as unknown as typeof fetch;

    await expect(
      sendTelegramPhoto({ chatId: "1", photo: new Uint8Array([1]), caption: "hei", botToken: "tok", fetch: fetchMock }),
    ).rejects.toThrow(/chat not found/);
  });
});
