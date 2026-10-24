import { applyTransforms } from './transforms.js';

describe('transforms', () => {
  it('trims and captures with a regex', () => {
    expect(
      applyTransforms('  Talle: 4  ', [
        { type: 'trim' },
        { type: 'regex', pattern: 'Talle: (\\d+)' },
      ]),
    ).toEqual({ ok: true, value: '4' });
  });

  it('fails a regex that does not match', () => {
    expect(
      applyTransforms('abc', [{ type: 'regex', pattern: '\\d+' }]),
    ).toMatchObject({ ok: false });
  });

  it.each([
    ['12.990,50', 'es-AR', 12990.5],
    ['$ 12.990,00', 'es-AR', 12990],
    ['$12,990.50', 'en-US', 12990.5],
    ['1.234.567,8', 'es-AR', 1234567.8],
  ])('parses number %s in %s', (raw, locale, expected) => {
    expect(applyTransforms(raw, [{ type: 'number', locale }])).toEqual({
      ok: true,
      value: expected,
    });
  });

  it('does not read a number out of surrounding words', () => {
    expect(
      applyTransforms('Remera 1', [{ type: 'number', locale: 'es-AR' }]),
    ).toMatchObject({ ok: false });
    expect(
      applyTransforms('ARS 12.990,00', [{ type: 'number', locale: 'es-AR' }]),
    ).toEqual({ ok: true, value: 12990 });
    expect(
      applyTransforms('-1.500,25', [{ type: 'number', locale: 'es-AR' }]),
    ).toEqual({ ok: true, value: -1500.25 });
  });

  it('fails a number that is not one', () => {
    expect(
      applyTransforms('agotado', [{ type: 'number', locale: 'es-AR' }]),
    ).toMatchObject({ ok: false });
  });

  it.each([
    ['15/10/2026', 'dd/MM/yyyy', 'es-AR', '2026-10-15'],
    ['5/3/26', 'd/M/yy', 'es-AR', '2026-03-05'],
    ['10/15/2026', 'MM/dd/yyyy', 'en-US', '2026-10-15'],
    ['15 de octubre de 2026', "dd 'de' MMMM 'de' yyyy", 'es-AR', '2026-10-15'],
    ['Oct 15, 2026', 'MMM dd, yyyy', 'en-US', '2026-10-15'],
  ])('parses date %s', (raw, format, locale, expected) => {
    expect(applyTransforms(raw, [{ type: 'date', format, locale }])).toEqual({
      ok: true,
      value: expected,
    });
  });

  it.each(['proximamente', '31/02/2026', '15-10-2026'])(
    'fails date %s',
    (raw) => {
      expect(
        applyTransforms(raw, [
          { type: 'date', format: 'dd/MM/yyyy', locale: 'es-AR' },
        ]),
      ).toMatchObject({ ok: false });
    },
  );

  it('maps text to enum and boolean', () => {
    expect(
      applyTransforms('Nena', [
        { type: 'enum_map', map: { nena: 'girls', nene: 'boys' } },
      ]),
    ).toEqual({ ok: true, value: 'girls' });
    expect(
      applyTransforms('Otro', [{ type: 'enum_map', map: { nena: 'girls' } }]),
    ).toMatchObject({ ok: false });
    const map = {
      type: 'boolean_map',
      true: ['en stock'],
      false: ['agotado'],
    } as const;
    expect(applyTransforms('Agotado', [map])).toEqual({
      ok: true,
      value: false,
    });
    expect(applyTransforms('quizas', [map])).toMatchObject({ ok: false });
  });

  it('splits into a list', () => {
    expect(
      applyTransforms('a, b ,,c', [{ type: 'split', separator: ',' }]),
    ).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  });

  it('fails when a text transform follows a typed one and when raw is missing', () => {
    expect(
      applyTransforms('1', [
        { type: 'number', locale: 'en-US' },
        { type: 'trim' },
      ]),
    ).toMatchObject({ ok: false });
    expect(applyTransforms(null, [])).toMatchObject({ ok: false });
  });

  it('returns the raw text when there is no chain', () => {
    expect(applyTransforms('x', undefined)).toEqual({ ok: true, value: 'x' });
  });
});
