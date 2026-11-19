import { ChromiumLauncher } from '../runner/browser.js';

/** Loads a trivial page to prove Chromium starts inside the image; used for deploy smoke tests. */
export async function handler() {
  const browser = await new ChromiumLauncher().launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<title>ok</title><h1>hello</h1>');
    return { title: await page.title(), version: await browser.version() };
  } finally {
    await browser.close();
  }
}
