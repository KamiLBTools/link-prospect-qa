import { chromium, type Browser } from "playwright";

/**
 * A page's HTML after its scripts have run, for homepages that send an empty
 * shell and draw everything client-side. Same honest user agent as the plain
 * fetch: rendering is not evasion, it only runs the JavaScript the site serves.
 *
 * One headless browser per process, started on first use. Null when the page
 * cannot be rendered, never a throw: one bad page must not end a run.
 */

let browser: Promise<Browser> | null = null;

export async function renderHtml(url: string, userAgent: string, timeoutMs: number): Promise<string | null> {
  try {
    browser ??= chromium.launch();
    const context = await (await browser).newContext({ userAgent });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
      return await page.content();
    } finally {
      await context.close();
    }
  } catch {
    return null;
  }
}

/** Lets a script exit: an open browser keeps the process alive. */
export async function closeRenderer(): Promise<void> {
  if (browser) await (await browser).close().catch(() => {});
  browser = null;
}
