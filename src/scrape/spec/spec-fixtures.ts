export const binding = (css: string) => ({
  locator: { css },
  source: 'text' as const,
});

export function validSpec(): Record<string, any> {
  return {
    formatVersion: 1,
    site: { url: 'https://shop.example/kids' },
    steps: [{ type: 'open_url', url: 'https://shop.example/kids' }],
    pagination: {
      mode: 'next_button',
      locator: { css: 'a.next' },
      maxPages: 5,
    },
    items: { locator: { css: '.product' } },
    system: {
      name: binding('.name'),
      link: { locator: { css: 'a' }, source: { attribute: 'href' } },
      price: binding('.price'),
      thumbnail_url: { locator: { css: 'img' }, source: { attribute: 'src' } },
    },
    properties: {
      launch: {
        ...binding('.date'),
        transforms: [{ type: 'date', format: 'dd/MM/yyyy', locale: 'es-AR' }],
      },
    },
  };
}
