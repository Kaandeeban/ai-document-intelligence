import { z } from 'zod';

/**
 * Canonical invoice model. Monetary values are integer minor units (e.g. cents)
 * to avoid floating-point rounding errors.
 */
const minorUnits = z.number().int();
const confidence = z.number().min(0).max(1);

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 currency code');

export const partySchema = z.object({
  name: z.string().trim().min(1).max(500),
  taxId: z.string().trim().min(1).max(64).optional(),
  address: z.string().trim().min(1).max(1000).optional(),
});

export const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(1000),
  quantity: z.number().positive(),
  unitPriceMinor: minorUnits,
  amountMinor: minorUnits,
});

export const taxLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  ratePercent: z.number().min(0).max(100),
  amountMinor: minorUnits,
});

export const invoiceSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100),
  issueDate: z.iso.date(),
  dueDate: z.iso.date().optional(),
  currency: currencyCodeSchema,
  supplier: partySchema,
  customer: partySchema,
  lineItems: z.array(lineItemSchema).max(1000),
  subtotalMinor: minorUnits,
  taxes: z.array(taxLineSchema).max(50),
  totalMinor: minorUnits,
  /** Per-field extraction confidence keyed by field path, e.g. "supplier.name". */
  fieldConfidence: z.record(z.string(), confidence).default({}),
});

export type Party = z.infer<typeof partySchema>;
export type LineItem = z.infer<typeof lineItemSchema>;
export type TaxLine = z.infer<typeof taxLineSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;

export type InvoiceIssueCode =
  | 'LINE_AMOUNT_MISMATCH'
  | 'SUBTOTAL_MISMATCH'
  | 'TOTAL_MISMATCH'
  | 'DUE_DATE_BEFORE_ISSUE_DATE'
  | 'LOW_CONFIDENCE_FIELD';

export interface InvoiceValidationIssue {
  readonly code: InvoiceIssueCode;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

export interface InvoiceValidationOptions {
  /** Fields extracted below this confidence are reported as warnings. */
  readonly minFieldConfidence?: number;
}

const sum = (values: readonly number[]): number => values.reduce((acc, v) => acc + v, 0);

/**
 * Business-rule validation for a structurally valid invoice. Returns issues
 * instead of throwing so they can be reported alongside the extracted data.
 */
export function validateInvoice(
  invoice: Invoice,
  options: InvoiceValidationOptions = {},
): InvoiceValidationIssue[] {
  const minConfidence = options.minFieldConfidence ?? 0.8;
  const issues: InvoiceValidationIssue[] = [];

  invoice.lineItems.forEach((item, index) => {
    if (Math.round(item.quantity * item.unitPriceMinor) !== item.amountMinor) {
      issues.push({
        code: 'LINE_AMOUNT_MISMATCH',
        severity: 'warning',
        path: `lineItems.${index}.amountMinor`,
        message: 'Line amount does not equal quantity multiplied by unit price',
      });
    }
  });

  if (invoice.lineItems.length > 0) {
    const lineTotal = sum(invoice.lineItems.map((item) => item.amountMinor));
    if (lineTotal !== invoice.subtotalMinor) {
      issues.push({
        code: 'SUBTOTAL_MISMATCH',
        severity: 'error',
        path: 'subtotalMinor',
        message: `Line items sum to ${lineTotal} but subtotal is ${invoice.subtotalMinor}`,
      });
    }
  }

  const expectedTotal = invoice.subtotalMinor + sum(invoice.taxes.map((tax) => tax.amountMinor));
  if (expectedTotal !== invoice.totalMinor) {
    issues.push({
      code: 'TOTAL_MISMATCH',
      severity: 'error',
      path: 'totalMinor',
      message: `Subtotal plus taxes is ${expectedTotal} but total is ${invoice.totalMinor}`,
    });
  }

  if (invoice.dueDate !== undefined && invoice.dueDate < invoice.issueDate) {
    issues.push({
      code: 'DUE_DATE_BEFORE_ISSUE_DATE',
      severity: 'error',
      path: 'dueDate',
      message: 'Due date is earlier than issue date',
    });
  }

  for (const [path, value] of Object.entries(invoice.fieldConfidence)) {
    if (value < minConfidence) {
      issues.push({
        code: 'LOW_CONFIDENCE_FIELD',
        severity: 'warning',
        path,
        message: `Extraction confidence ${value} is below threshold ${minConfidence}`,
      });
    }
  }

  return issues;
}
