import puppeteer, { Browser } from 'puppeteer-core';
import { BrowserLauncher } from './runner.js';

export interface LaunchOptions {
  /** A fresh profile directory, so nothing carries over between attempts. */
  userDataDir?: string;
}

/**
 * Local runs use CHROME_PATH (or the system Chrome); on Lambda the bundled
 * Chromium from @sparticuz/chromium is used. Without CHROME_PATH on a
 * workstation, set it to a Chrome binary.
 */
export class ChromiumLauncher implements BrowserLauncher {
  async launch(options: LaunchOptions = {}): Promise<Browser> {
    const executablePath = process.env.CHROME_PATH;
    if (executablePath) {
      return puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: options.userDataDir,
        args: ['--no-sandbox', '--disable-gpu'],
      });
    }
    const { default: chromium } = await import('@sparticuz/chromium');
    return puppeteer.launch({
      executablePath: await chromium.executablePath(),
      userDataDir: options.userDataDir,
      args: chromium.args,
      headless: 'shell',
    });
  }
}
