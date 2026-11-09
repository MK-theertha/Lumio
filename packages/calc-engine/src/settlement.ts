import { CalculationError } from './errors.js';
import { assertNonNegative, assertScale, D, dec, round, type Dec } from './decimal.js';
import { assertPolicy } from './pricing.js';
import type {
  AllocationResult,
  AllocationStrategy,
  DecimalString,
  DocumentResult,
  LineResult,
  OpenItem,
  PricingPolicy,
} from './types.js';

/** Totals priced lines. With DOCUMENT tax rounding, tax is rounded once per rate and mode. */
export function priceDocument(
  lines: LineResult[],
  adjustments: { adjustment: DecimalString },
  policy: PricingPolicy,
): DocumentResult {
  assertPolicy(policy);
  const { moneyScale, mode } = policy.rounding;
  const adjustment = dec(adjustments.adjustment, 'adjustment');
  assertScale(adjustment, moneyScale, 'adjustment');

  const sum = (pick: (line: LineResult) => string) =>
    lines.reduce((acc, line) => acc.plus(dec(pick(line), 'line')), new D(0));

  let tax: Dec;
  let taxable: Dec;
  if (policy.taxRounding === 'LINE') {
    tax = sum((l) => l.taxAmount);
    taxable = sum((l) => l.taxableValue);
  } else {
    const groups = new Map<string, LineResult[]>();
    for (const line of lines) {
      const key = `${line.taxMode}|${line.taxRatePercent}`;
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    tax = new D(0);
    taxable = new D(0);
    for (const group of groups.values()) {
      const groupTax = round(
        group.reduce((acc, l) => acc.plus(dec(l.unroundedTax, 'tax')), new D(0)),
        moneyScale,
        mode,
      );
      const base = group.reduce((acc, l) => acc.plus(dec(l.taxBase, 'base')), new D(0));
      tax = tax.plus(groupTax);
      taxable = taxable.plus(group[0]?.taxMode === 'EXCLUSIVE' ? base : base.minus(groupTax));
    }
  }

  return {
    taxableTotal: taxable.toFixed(moneyScale),
    taxTotal: tax.toFixed(moneyScale),
    discountTotal: sum((l) => l.discount).toFixed(moneyScale),
    adjustment: adjustment.toFixed(moneyScale),
    grandTotal: taxable.plus(tax).plus(adjustment).toFixed(moneyScale),
  };
}

/** Splits a total by weights using largest remainder. Shares always sum exactly to the total. */
export function apportion(
  total: DecimalString,
  weights: DecimalString[],
  scale: number,
): DecimalString[] {
  const amount = dec(total, 'total');
  assertNonNegative(amount, 'total');
  assertScale(amount, scale, 'total');
  const parsed = weights.map((w, i) => {
    const weight = dec(w, `weights[${i}]`);
    assertNonNegative(weight, `weights[${i}]`);
    return weight;
  });
  const sumOfWeights = parsed.reduce((acc, w) => acc.plus(w), new D(0));
  if (sumOfWeights.isZero()) {
    throw new CalculationError('INVALID_APPORTIONMENT', 'Weights must not all be zero');
  }

  const unit = new D(10).pow(-scale);
  const exact = parsed.map((w) => amount.times(w).dividedBy(sumOfWeights));
  const shares = exact.map((e) => e.toDecimalPlaces(scale, D.ROUND_DOWN));
  const remaining = amount.minus(shares.reduce((acc, s) => acc.plus(s), new D(0)));
  const leftoverUnits = remaining.dividedToIntegerBy(unit).toNumber();

  const order = exact
    .map((e, index) => ({ index, fraction: e.minus(shares[index] as Dec) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.index - b.index);
  for (let i = 0; i < leftoverUnits; i += 1) {
    const target = order[i % order.length]?.index as number;
    shares[target] = (shares[target] as Dec).plus(unit);
  }
  return shares.map((s) => s.toFixed(scale));
}

/** Allocates a payment to open items. Allocated plus unallocated always equals the payment. */
export function allocatePayment(
  amount: DecimalString,
  items: OpenItem[],
  strategy: AllocationStrategy,
  moneyScale: number,
): AllocationResult {
  const payment = dec(amount, 'amount');
  assertNonNegative(payment, 'amount');
  assertScale(payment, moneyScale, 'amount');
  let left = payment;
  const allocations: AllocationResult['allocations'] = [];

  if (strategy.kind === 'OLDEST_FIRST') {
    const ordered = [...items].sort(
      (a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
    );
    for (const item of ordered) {
      if (left.isZero()) break;
      const outstanding = dec(item.outstanding, 'outstanding');
      const applied = D.min(left, outstanding);
      if (applied.greaterThan(0)) {
        allocations.push({ id: item.id, amount: applied.toFixed(moneyScale) });
        left = left.minus(applied);
      }
    }
  } else {
    const byId = new Map(items.map((item) => [item.id, item]));
    const used = new Set<string>();
    for (const requested of strategy.allocations) {
      const item = byId.get(requested.id);
      if (!item || used.has(requested.id)) {
        throw new CalculationError('INVALID_ALLOCATION', `Invalid open item: ${requested.id}`);
      }
      used.add(requested.id);
      const value = dec(requested.amount, 'allocation');
      assertScale(value, moneyScale, 'allocation');
      if (value.lessThanOrEqualTo(0) || value.greaterThan(dec(item.outstanding, 'outstanding'))) {
        throw new CalculationError(
          'INVALID_ALLOCATION',
          'Allocation exceeds the amount outstanding',
        );
      }
      if (value.greaterThan(left)) {
        throw new CalculationError('INVALID_ALLOCATION', 'Allocations exceed the payment');
      }
      left = left.minus(value);
      allocations.push({ id: requested.id, amount: value.toFixed(moneyScale) });
    }
  }
  return { allocations, unallocated: left.toFixed(moneyScale) };
}

export function outstandingBalance(
  original: DecimalString,
  allocated: DecimalString[],
  moneyScale: number,
): DecimalString {
  const paid = allocated.reduce((acc, a) => acc.plus(dec(a, 'allocated')), new D(0));
  const balance = dec(original, 'original').minus(paid);
  assertNonNegative(balance, 'outstanding balance');
  return balance.toFixed(moneyScale);
}

export function grossProfit(
  revenueExTax: DecimalString,
  costAtIssue: DecimalString,
  moneyScale: number,
): DecimalString {
  return dec(revenueExTax, 'revenueExTax')
    .minus(dec(costAtIssue, 'costAtIssue'))
    .toFixed(moneyScale);
}
