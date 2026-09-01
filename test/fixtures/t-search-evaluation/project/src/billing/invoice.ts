// chunk: c023
export function calculateInvoiceTotal(lines: Array<{ quantity: number; unitPrice: number }>) {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
}
