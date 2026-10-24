import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

export type Routes = Record<string, string | ((url: URL) => string)>;

export interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

/** Serves static HTML for the runner tests; routes may be computed from the URL. */
export async function startFixtureServer(
  routes: Routes,
): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes[url.pathname];
    if (route === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(typeof route === 'function' ? route(url) : route);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function productCard(n: number, extra = ''): string {
  return `<div class="product">
    <a href="/p/${n}"><span class="name">Remera ${n}</span></a>
    <img src="/img/${n}.jpg">
    <span class="price">$ ${n}.990,00</span>
    <span class="date">1${n % 10}/10/2026</span>
    ${extra}
  </div>`;
}
