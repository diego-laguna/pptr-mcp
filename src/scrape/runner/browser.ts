import puppeteer, { Browser } from 'puppeteer-core';
import { BrowserLauncher } from './runner.js';

/**
 * Local runs use CHROME_PATH (or the system Chrome); on Lambda the bundled
 * Chromium from @sparticuz/chromium is used.
 */
export class ChromiumLauncher implements BrowserLauncher {
  async launch(): Promise<Browser> {
    const executablePath = process.env.CHROME_PATH;
    if (executablePath) {
      return puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu'],
      });
    }
    const { default: chromium } = await import('@sparticuz/chromium');
    return puppeteer.launch({
      executablePath: await chromium.executablePath(),
      args: chromium.args,
      headless: 'shell',
    });
  }
}
