import { Page } from "playwright";
import * as fs from "fs";

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

// Utility function to get XPath of a node
export function getXPath(node: Node, bodyNode: Node): string {
  let path = "";
  while (node !== bodyNode) {
    let index = 1;
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.nodeName === node.nodeName) index++;
      sibling = sibling.previousSibling;
    }
    path = `/${node.nodeName.toLowerCase()}[${index}]` + path;
    node = node.parentNode!;
  }
  return path;
}
