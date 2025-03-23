import { Page } from "playwright";
import * as fs from "fs";

export async function attachMutationObserver(page: Page, selector = "body") {
  await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) return;

    const observer = new MutationObserver((mutations) => {
      console.log(`[DEBUG][DOM] Mutation on ${sel}`, mutations);
    });

    observer.observe(target, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    console.log(`[DEBUG][DOM] Observer attached to ${sel}`);
  }, selector);
}

export async function dumpPageHTML(page: Page, label: string) {
  const html = await page.content();
  const path = `/tmp/${label}-${Date.now()}.html`;
  fs.writeFileSync(path, html);
  console.log(`[DEBUG][HTML] Snapshot saved: ${path}`);
}

export function setupNetworkLogging(page: Page, debug: boolean) {
  if (!debug) return;
  page.on("request", (req) => {
    console.log(`[DEBUG][Network][Request] ${req.method()} ${req.url()}`);
  });
  page.on("response", async (res) => {
    console.log(`[DEBUG][Network][Response] ${res.status()} ${res.url()}`);
  });
}
