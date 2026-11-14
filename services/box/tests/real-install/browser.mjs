// The owner's browser for real-install-image.probe.py. It uses the console's real pages and buttons,
// so a page that errors or a button that does nothing fails the proof the way it would stop a person.
//
//   node browser.mjs <step> <settings.json>
//
// Chromium is installed by the workflow, outside the repository's dependencies. The test authority
// is not in Chromium's own trust store; only this browser ignores that, never the installation.
// Chromium also refuses any stand-in for the sign-in provider's address outright, because that
// address is pinned inside it, so this script carries those requests itself.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  // A tool that just runs, a Track change and a Vault note that each need the owner's answer on
  // their card, then one more message in the same conversation.
  async chat(page) {
    await page.goto(`${origin}/chat/${settings.agent}`);
    const send = async (text) => {
      // Wait as a person would until the answer has finished. Sending during an answer is a
      // different path, which this proof does not cover.
      await page.waitForTimeout(2000);
      await page.getByText("The agent is still answering").waitFor({ state: "hidden", timeout: STEP_MS });
      const box = page.getByPlaceholder(/^Message /);
      await box.fill(text, { timeout: 60_000 });
      await page.getByRole("button", { name: "Send message" }).click();
    };
    await send(settings.toolPrompt);
    await page.locator(".lares-tool-line", { hasText: "completed" }).first().waitFor({ timeout: STEP_MS });
    await page.locator(".lares-message-agent", { hasText: settings.toolReply }).first().waitFor({ timeout: STEP_MS });
    await send(settings.approvalPrompt);
    await page.locator(".lares-actions button", { hasText: /approve/i }).first().click({ timeout: STEP_MS });
    await page.locator(".lares-message-agent", { hasText: settings.approvalReply }).first().waitFor({ timeout: STEP_MS });
    console.log(`the answered card says: ${await page.locator(".lares-approval-note").first().innerText().catch(() => "(nothing)")}`);
    await send(settings.notePrompt);
    await page.locator(".lares-actions button", { hasText: /approve/i }).last().click({ timeout: STEP_MS });
    await page.locator(".lares-message-agent", { hasText: settings.noteReply }).first().waitFor({ timeout: STEP_MS });
    console.log(`the answered note card says: ${await page.locator(".lares-approval-note").last().innerText().catch(() => "(nothing)")}`);
    await send(settings.followUpPrompt);
    await page.locator(".lares-message-agent", { hasText: settings.followUpReply }).first().waitFor({ timeout: STEP_MS });
    if (await page.getByText("This conversation is unavailable").count()) throw new Error("The conversation became unavailable");
  },
  // A started agent takes an edit. One message in a new conversation; then the description is saved on
  // the agent's own page, which says first that saving ends open conversations. Back in the same tab the
  // old conversation is refused and reaches nothing; a new conversation is answered.
  async "edit-after-start"(page) {
    const agentReplies = () => page.locator(".lares-message-agent", { hasText: settings.afterUpdateReply }).count();
    await page.goto(`${origin}/chat/${settings.agent}`);
    await page.getByPlaceholder(/^Message /).fill(settings.beforeEditPrompt, { timeout: 60_000 });
    await page.getByRole("button", { name: "Send message" }).click();
    await page.locator(".lares-message-agent", { hasText: settings.afterUpdateReply }).first().waitFor({ timeout: STEP_MS });
    await page.getByText("The agent is still answering").waitFor({ state: "hidden", timeout: STEP_MS });
    await page.goto(`${origin}/agents/${settings.agent}/edit`);
    await page.getByText(settings.saveWarning).first().waitFor({ timeout: 30_000 });
    await page.getByLabel("Description").fill(settings.editedDescription);
    await page.getByRole("button", { name: "Save definition" }).click();
    await page.getByText("Definition saved.").waitFor({ timeout: STEP_MS });
    // The same tab keeps the conversation it had: the chat page opens it again.
    await page.goto(`${origin}/chat/${settings.agent}`);
    const box = page.getByPlaceholder(/^Message /);
    await page.waitForTimeout(3000);
    if (!(await page.getByText(/This conversation (has ended|is unavailable)/).count()) && await box.isEnabled().catch(() => false)) {
      await box.fill(settings.oldConversationPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
    }
    // The console's own sentence for a conversation the save revoked: nothing reached the agent.
    await page.getByText("This conversation has ended. Start a new one.").waitFor({ timeout: 60_000 });
    console.log(`the old conversation says: ${(await page.locator("main").innerText().catch(() => "")).split("\n").filter((line) => /conversation/i.test(line)).join(" | ")}`);
    if ((await agentReplies()) > 1) throw new Error("The old conversation was answered after the save");
    await page.getByRole("button", { name: "Start a new conversation" }).click();
    await page.getByPlaceholder(/^Message /).fill(settings.afterEditPrompt, { timeout: 60_000 });
    await page.getByRole("button", { name: "Send message" }).click();
    await page.locator(".lares-message-agent", { hasText: settings.afterUpdateReply }).first().waitFor({ timeout: STEP_MS });
    if (await page.getByText("This conversation is unavailable").count()) throw new Error("The new conversation became unavailable");
  },
  // After `lares update`: the chat page opens a new conversation; one message there must get the
  // model's answer, not a refusal.
  async "chat-after-update"(page) {
    await page.goto(`${origin}/chat/${settings.agent}`);
    await page.getByPlaceholder(/^Message /).fill(settings.afterUpdatePrompt, { timeout: 60_000 });
    await page.getByRole("button", { name: "Send message" }).click();
    await page.locator(".lares-message-agent", { hasText: settings.afterUpdateReply }).first().waitFor({ timeout: STEP_MS });
    if (await page.getByText("This conversation is unavailable").count()) throw new Error("The conversation became unavailable");
  },
  // A chat door, on the agent's edit page as an owner does it: paste the credentials and press
  // Connect. The page saves, has the keeper check the bot, switches the door on, applies it and then
  // shows the one-time step, which is written down for the probe to send.
  "connect-slack": (page) => connectDoor(page, "slack"),
  "connect-telegram": (page) => connectDoor(page, "telegram"),
  // The owner comes back to the page after the claim was sent and applies it.
  "finish-slack": (page) => finishDoor(page, "slack"),
  "finish-telegram": (page) => finishDoor(page, "telegram"),
  // A connected door's "Send a test brief" button, pressed once, then the page's own status line
  // read until it says how it ended.
  "test-brief-slack": (page) => testBrief(page, "slack"),
  "test-brief-telegram": (page) => testBrief(page, "telegram"),
};

const DOOR_LABEL = { slack: "Slack", telegram: "Telegram" };
const DOOR_MS = 240_000;

// Both doors have a "Bot token" field and a "Connect" button, so everything is found inside the door's own fieldset.
async function doorGroup(page, kind) {
  await page.goto(`${origin}/agents/${settings.agent}/edit`);
  const group = page.getByRole("group", { name: DOOR_LABEL[kind], exact: true });
  await group.waitFor({ timeout: 60_000 });
  // The door's state is fetched after the page renders.
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  return group;
}

// Waits for the wanted element, and fails at once with the page's own alert if one appears instead. The
// sentence that saving ends open conversations is a plain note, not an alert, so it never trips this.
async function waitForDoor(page, wanted, what) {
  const alert = page.locator('section[aria-label="Door setup"] [role="alert"]');
  const deadline = Date.now() + DOOR_MS;
  while (Date.now() < deadline) {
    if (await wanted.count()) return;
    if (await alert.count()) throw new Error(`The door page says: ${(await alert.first().innerText().catch(() => "")).slice(0, 500)}`);
    await page.waitForTimeout(1000);
  }
  throw new Error(`The door page did not show ${what} within ${DOOR_MS / 1000} seconds`);
}

// The keeper's own reasons (`pending_reason`) the door's state line shows after "Pending: ".
const APPLY_BUTTON = "Apply connection changes (restarts agent)";
const CLAIM_WAITING = "Pending: Owner claimed door; apply connection changes (restarts agent)";
// An Apply (or a save's firewall step) is running now; pressing anything would start a second one.
const RUNNING = /^Pending: .*in progress/;

// The door's state line (the first paragraph of its fieldset). It reads "Not set up" until the page has
// fetched the doors, so a door that has been touched is read again for a little while.
async function doorState(page, group) {
  let state = "";
  for (let tries = 0; tries < 10; tries++) {
    state = (await group.locator("p").first().innerText().catch(() => "")).trim();
    if (state && state !== "Not set up") break;
    await page.waitForTimeout(1000);
  }
  return state;
}

// Reloads the page until no Apply is running for the door, and returns its state then.
async function stateWhenNothingRuns(page, kind) {
  const deadline = Date.now() + DOOR_MS;
  for (;;) {
    const group = await doorGroup(page, kind);
    const state = await doorState(page, group);
    if (!RUNNING.test(state)) return { group, state };
    if (Date.now() > deadline) throw new Error(`The ${DOOR_LABEL[kind]} door still read "${state}" after ${DOOR_MS / 1000} seconds`);
    await page.waitForTimeout(3000);
  }
}

// The door section's own Apply: the page's Status box has a button with the same name. It applies and reloads.
const pressApply = (page) => page.locator('section[aria-label="Door setup"]').getByRole("button", { name: APPLY_BUTTON }).click({ timeout: 60_000 });

// The page's own signal that its Apply call has returned: while the call runs, the door section shows the
// progress line "Applying (restarts the agent, about a minute)…"; when the call returns the page reloads itself,
// and when it fails the line goes and an alert shows. The door's own buttons come back earlier (as soon as the
// keeper clears "pending", before it starts the agent), so they are not that signal. Nothing here reloads the
// page or presses anything while the Apply it started is still running.
async function pressApplyAndWaitForIt(page) {
  const applying = page.locator('section[aria-label="Door setup"] .lares-door-progress', { hasText: "Applying" }).first();
  await pressApply(page);
  await applying.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  await applying.waitFor({ state: "detached", timeout: DOOR_MS });
}

// A retry of this step (after the runner's network changed under the page) must never start a second
// Connect or Apply while the first one is still running: it reads the door's state first and waits.
async function connectDoor(page, kind) {
  let { group, state } = await stateWhenNothingRuns(page, kind);
  console.log(`the ${DOOR_LABEL[kind]} door reads: ${state}`);
  const show = () => group.getByRole("button", { name: kind === "slack" ? "Show the one-time code" : "Show the tap-to-connect link" });
  if (state.startsWith("Pending:") && await group.getByRole("button", { name: "Disable door" }).count()) {
    // An earlier attempt saved the door switched on but its Apply never reached the keeper (the probe
    // waits for the keeper to finish every action before a retry). Apply it once, as the owner would.
    await pressApplyAndWaitForIt(page);
    await waitForDoor(page, show(), "the button to show the one-time step after Apply");
    ({ group } = await stateWhenNothingRuns(page, kind));
    await show().click();
  } else if (await show().count()) {
    // A retry: the door is already on, applied and unclaimed.
    await show().click();
  } else {
    await group.getByLabel("Bot token").fill(kind === "slack" ? settings.slackBotToken : settings.telegramBotToken);
    if (kind === "slack") await group.getByLabel("Signing secret").fill(settings.slackSigningSecret);
    await group.getByRole("button", { name: /^(Connect|Replace credentials and connect)$/ }).click();
  }
  if (kind === "slack") {
    const code = group.locator(".lares-door-connect code");
    await waitForDoor(page, code, "the one-time code");
    writeFileSync(`${settings.doorCodeDir}/slack`, (await code.first().innerText()).trim(), { mode: 0o600 });
  } else {
    const link = group.locator("a.lares-door-tap");
    await waitForDoor(page, link, "the tap-to-connect link");
    const start = new URL(await link.first().getAttribute("href")).searchParams.get("start") ?? "";
    writeFileSync(`${settings.doorCodeDir}/telegram`, start, { mode: 0o600 });
  }
}

// Apply is pressed only while the door waits for the claim's Apply. If an Apply from an earlier attempt is
// still running, this waits for it; if it is done, the door reads Connected and nothing is pressed.
async function finishDoor(page, kind) {
  const { group, state } = await stateWhenNothingRuns(page, kind);
  console.log(`the ${DOOR_LABEL[kind]} door reads: ${state}`);
  if (state === "Connected") return;
  if (state !== CLAIM_WAITING) throw new Error(`The ${DOOR_LABEL[kind]} door reads "${state}", not "${CLAIM_WAITING}"`);
  await pressApply(page);
  // Applying reloads the page; the door then reads Connected.
  await waitForDoor(page, group.getByText("Connected", { exact: true }), `${DOOR_LABEL[kind]} as Connected`);
}

// The longest the page can still read as on its way: a request is claimed at the latest when it is
// ten minutes old (the product's stale limit), and the test pass then ends within 150 seconds.
const BRIEF_MS = 780_000;

// The button is pressed at most once in the whole run, whatever happens to this step: never when an
// earlier attempt pressed it (the `.pressed` file, written just before the press), when the probe found
// a request row for this door (`.asked`, written by the probe before every attempt), or when the door
// already shows a test-brief status line. Everything seen is written to `<door>.json` for the probe.
async function testBrief(page, kind) {
  const dir = settings.testBriefDir;
  const file = `${dir}/${kind}.json`;
  const earlier = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const seen = { attempts: (earlier.attempts ?? 0) + 1, presses: earlier.presses ?? 0, sentences: earlier.sentences ?? [], final: null, overview: null };
  const save = () => writeFileSync(file, JSON.stringify(seen, null, 2));
  save();
  const group = await doorGroup(page, kind);
  const button = group.getByRole("button", { name: `Send a test brief to ${DOOR_LABEL[kind]}`, exact: true });
  await button.waitFor({ timeout: 60_000 });
  // The status line is fetched after the door rows; give it the same moment.
  await page.waitForTimeout(3000);
  const line = group.locator('.lares-test-brief [role="status"]');
  const refusal = group.locator('.lares-test-brief [role="alert"]');
  const said = async () => ((await refusal.count()) ? await refusal.first().innerText().catch(() => "")
    : (await line.count()) ? await line.first().innerText().catch(() => "") : "").trim();
  seen.statusBeforePress = await said();
  const held = [`${dir}/${kind}.pressed`, `${dir}/${kind}.asked`].filter((path) => existsSync(path));
  console.log(`the ${DOOR_LABEL[kind]} test brief reads: ${seen.statusBeforePress || "(no status line)"}; ${held.length ? `not pressing (${held.join(", ")})` : "pressing"}`);
  if (!held.length && !seen.statusBeforePress) {
    writeFileSync(`${dir}/${kind}.pressed`, new Date().toISOString());
    seen.presses += 1;
    seen.pressedAt = new Date().toISOString();
    save();
    await button.click({ timeout: 60_000 });
  }
  // The page keeps the button disabled while the request is on its way, so a status line with the
  // button usable again is the page's own final word.
  const deadline = Date.now() + BRIEF_MS;
  let last = "";
  for (;;) {
    const now = await said();
    if (now && now !== last) {
      seen.sentences.push({ at: new Date().toISOString(), said: now });
      last = now;
      save();
    }
    if (now && await button.isEnabled().catch(() => false)) {
      seen.final = now;
      break;
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(2000);
  }
  console.log(`the ${DOOR_LABEL[kind]} test brief ended as: ${seen.final ?? `(still "${last}" after ${BRIEF_MS / 1000} seconds)`}`);
  save();
  // What the console's overview says about the agent's work afterwards.
  await page.goto(`${origin}/agents`);
  const cell = page.locator("tr", { has: page.locator(`a[href="/agents/${settings.agent}"]`) }).locator('td[data-label="Workflows"]');
  seen.overview = (await cell.first().innerText({ timeout: 30_000 }).catch(() => "")).trim() || null;
  save();
}

// The door credentials are test values, but are still never printed.
const scrub = (text) => [settings.slackBotToken, settings.slackSigningSecret, settings.telegramBotToken]
  .filter(Boolean).reduce((said, secret) => said.split(secret).join("<redacted>"), text ?? "");

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
page.on("response", async (response) => {
  if (response.status() < 300) return;
  console.log(`${response.status()} ${response.url().split("?")[0]}`);
  if (response.status() >= 400) console.log(`  sent ${scrub(response.request().postData())?.slice(0, 300)}\n  answered ${scrub(await response.text().catch(() => "")).slice(0, 300)}`);
});
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
