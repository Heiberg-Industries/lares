// The owner's browser for real-install-image.probe.py. It uses the console's real pages and buttons,
// so a page that errors or a button that does nothing fails the proof the way it would stop a person.
//
//   node browser.mjs <step> <settings.json>
//
// Chromium is installed by the workflow, outside the repository's dependencies. The test authority
// is not in Chromium's own trust store; only this browser ignores that, never the installation.
// Chromium also refuses any stand-in for the sign-in provider's address outright, because that
// address is pinned inside it, so this script carries those requests itself.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(`${process.env.PLAYWRIGHT_DIR}/`)("playwright");
const [step, settingsFile] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
const origin = `https://${settings.domain}`;
const STEP_MS = 90_000;

const steps = {
  // The first sign-in on a fresh install issues no session; it shows the owner what to paste.
  async "discover-owner"(page) {
    await startSignIn(page);
    await page.waitForURL(/\/sign-in/, { timeout: STEP_MS });
    const receipt = (await page.getByLabel("Owner setup JSON").innerText({ timeout: 30_000 })).trim();
    writeFileSync(settings.receiptFile, receipt, { mode: 0o600 });
  },
  async "sign-in"(page, context) {
    await startSignIn(page);
    await page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith("/sign-in") && !url.pathname.startsWith("/api/auth"), { timeout: STEP_MS });
    if (!(await context.cookies()).some((cookie) => cookie.name === "lares_session")) throw new Error("Signed in, but no session cookie was issued");
  },
  async "create-agent"(page) {
    await page.goto(`${origin}/agents/new`);
    await page.getByRole("radio", { name: "Chief of staff" }).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue →" }).click();
    await page.getByLabel("Name (permanent slug)").fill(settings.agent);
    await page.getByRole("button", { name: "Continue →" }).click();
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.waitForURL((url) => url.pathname !== "/agents/new", { timeout: STEP_MS });
  },
  async adopt(page) {
    await page.goto(`${origin}/agents/${settings.agent}`);
    await page.getByRole("tab", { name: "Access" }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Adopt under my identity" }).click();
    await page.getByText("Agent access saved.").waitFor({ timeout: 60_000 });
  },
  async "member-limit"(page) {
    await page.goto(`${origin}/members`);
    await page.locator('input[name="monthlyLimit"]').fill(settings.memberLimit, { timeout: 30_000 });
    await page.getByRole("button", { name: "Save initial limit" }).click();
    await page.getByText("Initial monthly limit saved.").waitFor({ timeout: 60_000 });
  },
  // A tool that just runs, a tool that needs the owner's answer on its card, then one more message
  // in the same conversation.
  async chat(page) {
    await page.goto(`${origin}/chat/${settings.agent}`);
    const send = async (text) => {
      const box = page.getByPlaceholder(/^Message /);
      await box.fill(text, { timeout: 60_000 });
      await page.getByRole("button", { name: "Send message" }).click();
    };
    await send(settings.toolPrompt);
    await page.locator(".lares-tool-line", { hasText: "completed" }).first().waitFor({ timeout: STEP_MS });
    await page.locator(".lares-message-agent", { hasText: settings.toolReply }).first().waitFor({ timeout: STEP_MS });
    await send(settings.approvalPrompt);
    await page.locator(".lares-actions button", { hasText: /approve/i }).first().click({ timeout: STEP_MS });
    await page.getByText("You approved this, and it ran.").waitFor({ timeout: STEP_MS });
    await page.locator(".lares-message-agent", { hasText: settings.approvalReply }).first().waitFor({ timeout: STEP_MS });
    await send(settings.followUpPrompt);
    await page.locator(".lares-message-agent", { hasText: settings.followUpReply }).first().waitFor({ timeout: STEP_MS });
    if (await page.getByText("This conversation is unavailable").count()) throw new Error("The conversation became unavailable");
  },
};

async function startSignIn(page) {
  await page.goto(`${origin}/sign-in`);
  await page.getByRole("link", { name: "Continue with Google" }).click({ timeout: 30_000 });
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: ["discover-owner", "sign-in"].includes(step) ? undefined : settings.stateFile });
await context.route(/^https:\/\/accounts\.google\.com\//, async (route) => {
  try {
    const answer = await fetch(route.request().url(), { redirect: "manual" });
    await route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: Buffer.from(await answer.arrayBuffer()) });
  } catch (error) {
    console.log(`sign-in provider request failed: ${error.cause?.message ?? error.message}`);
    await route.abort();
  }
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
page.on("requestfailed", (request) => console.log(`request failed: ${request.url().split("?")[0]} ${request.failure()?.errorText}`));
page.on("response", (response) => { if (response.status() >= 300) console.log(`${response.status()} ${response.url().split("?")[0]}`); });
let failed = null;
try {
  await steps[step](page, context);
  await context.storageState({ path: settings.stateFile });
} catch (error) {
  failed = error;
  console.log(`step ${step} stopped on ${page.url()}`);
  console.log((await page.locator("body").innerText().catch(() => "")).slice(0, 2000));
  await page.screenshot({ path: `${settings.screenshotDir}/${step}.png`, fullPage: true }).catch(() => {});
}
await browser.close();
if (failed) throw failed;
