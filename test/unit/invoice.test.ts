import { describe, expect, it } from 'vitest';
import { invoiceSchema, validateInvoice, type Invoice } from '../../src/domain/invoice.js';

// Synthetic data only.
const validInput = {
  invoiceNumber: 'INV-0001',
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  currency: 'GBP',
  supplier: { name: 'Example Supplies Ltd', taxId: 'GB000000000' },
  customer: { name: 'Sample Customer plc' },
  lineItems: [
    { description: 'Widget', quantity: 2, unitPriceMinor: 1500, amountMinor: 3000 },
    { description: 'Service', quantity: 1, unitPriceMinor: 2000, amountMinor: 2000 },
  ],
  subtotalMinor: 5000,
  taxes: [{ description: 'VAT', ratePercent: 20, amountMinor: 1000 }],
  totalMinor: 6000,
};

const parse = (
  overrides: Partial<Record<keyof typeof validInput | 'fieldConfidence', unknown>> = {},
): Invoice => invoiceSchema.parse({ ...validInput, ...overrides });

describe('invoiceSchema', () => {
  it('parses a valid invoice and defaults fieldConfidence', () => {
    expect(parse().fieldConfidence).toEqual({});
  });

  it.each([
    ['lowercase currency', { currency: 'gbp' }],
    ['invalid date', { issueDate: '2026-02-30' }],
    ['fractional money', { totalMinor: 60.5 }],
    ['empty invoice number', { invoiceNumber: '  ' }],
    ['confidence above 1', { fieldConfidence: { total: 1.2 } }],
  ])('rejects %s', (_label, overrides) => {
    expect(invoiceSchema.safeParse({ ...validInput, ...overrides }).success).toBe(false);
  });
});

describe('validateInvoice', () => {
  it('reports no issues for a consistent invoice', () => {
    expect(validateInvoice(parse())).toEqual([]);
  });

  it('detects subtotal and total mismatches', () => {
    const codes = validateInvoice(parse({ subtotalMinor: 4999 })).map((i) => i.code);
    expect(codes).toEqual(['SUBTOTAL_MISMATCH', 'TOTAL_MISMATCH']);
  });

  it('detects line amount mismatch as a warning', () => {
    const issues = validateInvoice(
      parse({
        lineItems: [
          { description: 'Widget', quantity: 3, unitPriceMinor: 1500, amountMinor: 5000 },
        ],
      }),
    );
    expect(issues[0]).toMatchObject({ code: 'LINE_AMOUNT_MISMATCH', severity: 'warning' });
  });

  it('detects due date before issue date', () => {
    expect(validateInvoice(parse({ dueDate: '2026-02-01' })).map((i) => i.code)).toEqual([
      'DUE_DATE_BEFORE_ISSUE_DATE',
    ]);
  });

  it('flags low-confidence fields using the configured threshold', () => {
    const invoice = parse({ fieldConfidence: { 'supplier.name': 0.6, totalMinor: 0.95 } });
    expect(validateInvoice(invoice).map((i) => i.path)).toEqual(['supplier.name']);
    expect(validateInvoice(invoice, { minFieldConfidence: 0.5 })).toEqual([]);
  });
});
