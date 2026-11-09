import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocatePayment,
  apportion,
  CalculationError,
  convertPurity,
  convertRate,
  convertWeight,
  finenessFromKarat,
  grossProfit,
  karatFromFineness,
  outstandingBalance,
  priceDocument,
  priceLine,
  type AllocationStrategy,
  type LineInput,
  type PricingPolicy,
} from './index.js';

// Figures here are illustrative test inputs, not real rates or approved business rules.
const policy: PricingPolicy = {
  version: 'test-1',
  taxRounding: 'LINE',
  rounding: {
    weightScale: 3,
    fineWeightScale: 4,
    finenessScale: 4,
    rateScale: 4,
    moneyScale: 2,
    mode: 'HALF_UP',
  },
};

const baseLine: LineInput = {
  grossWeight: '10.000',
  stoneWeight: '0',
  fineness: '0.9160',
  pieces: 1,
  rate: { basis: 'FINE_GRAM', value: '400.0000' },
  wastage: { mode: 'NONE' },
  making: { mode: 'NONE' },
  stoneValue: '0',
  otherCharges: '0',
  discount: { kind: 'NONE' },
  tax: { mode: 'EXCLUSIVE', ratePercent: '0' },
};

const line = (overrides: Partial<LineInput>) => priceLine({ ...baseLine, ...overrides }, policy);

function expectCode(run: () => unknown, code: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CalculationError);
    expect((error as CalculationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected CalculationError ${code}`);
}

describe('rate basis', () => {
  it('prices a fine-gram rate on fine weight', () => {
    expect(line({}).goldValue).toBe('3664.00');
  });

  it('prices a purity rate on net weight, without discounting purity twice', () => {
    const result = line({
      rate: { basis: 'PURITY_GRAM', value: '366.4000', fineness: '0.9160' },
    });
    expect(result.goldValue).toBe('3664.00');
  });

  it('rejects a purity rate for a different purity', () => {
    expectCode(
      () => line({ rate: { basis: 'PURITY_GRAM', value: '366.4', fineness: '0.8750' } }),
      'RATE_PURITY_MISMATCH',
    );
  });
});

describe('weights', () => {
  it('deducts stones before computing fine weight', () => {
    const result = line({ grossWeight: '12.500', stoneWeight: '2.500' });
    expect(result.netWeight).toBe('10.000');
    expect(result.fineWeight).toBe('9.1600');
  });

  it('rounds fine weight at its own scale', () => {
    expect(line({ grossWeight: '1.555', fineness: '0.9167' }).fineWeight).toBe('1.4255');
  });

  it('allows an item made only of stones', () => {
    const result = line({ grossWeight: '1.000', stoneWeight: '1.000' });
    expect(result.netWeight).toBe('0.000');
    expect(result.goldValue).toBe('0.00');
  });
});

describe('wastage', () => {
  it('bills weight-based wastage while keeping physical fine weight unchanged', () => {
    const result = line({ wastage: { mode: 'PERCENT_OF_WEIGHT', percent: '10' } });
    expect(result.chargeableWeight).toBe('11.000');
    expect(result.chargeableFineWeight).toBe('10.0760');
    expect(result.fineWeight).toBe('9.1600');
    expect(result.goldValue).toBe('4030.40');
  });

  it('supports fixed-gram wastage', () => {
    expect(line({ wastage: { mode: 'FIXED_GRAMS', grams: '0.500' } }).chargeableWeight).toBe(
      '10.500',
    );
  });

  it('supports value-based wastage as a separate component', () => {
    const result = line({ wastage: { mode: 'PERCENT_OF_GOLD_VALUE', percent: '5' } });
    expect(result.goldValue).toBe('3664.00');
    expect(result.wastageValue).toBe('183.20');
    expect(result.grossLineValue).toBe('3847.20');
  });
});

describe('making charges', () => {
  it.each([
    ['PER_GRAM_NET', { mode: 'PER_GRAM_NET', rate: '20' }, '160.00'],
    ['PER_GRAM_GROSS', { mode: 'PER_GRAM_GROSS', rate: '20' }, '200.00'],
    ['PER_PIECE', { mode: 'PER_PIECE', rate: '50' }, '100.00'],
    ['PERCENT', { mode: 'PERCENT_OF_GOLD_VALUE', percent: '10' }, '293.12'],
    ['FIXED', { mode: 'FIXED', amount: '75.50' }, '75.50'],
  ] as const)('computes %s', (_name, making, expected) => {
    const result = line({ grossWeight: '10.000', stoneWeight: '2.000', pieces: 2, making });
    expect(result.makingCharge).toBe(expected);
  });
});

describe('discounts', () => {
  const making = { mode: 'FIXED', amount: '100.00' } as const;

  it('applies a percentage to the making charge only', () => {
    const result = line({
      making,
      discount: { kind: 'PERCENT', target: 'MAKING', percent: '50' },
    });
    expect(result.discount).toBe('50.00');
    expect(result.taxableValue).toBe('3714.00');
  });

  it('applies a fixed amount to the line', () => {
    const result = line({ discount: { kind: 'AMOUNT', target: 'LINE', amount: '64.00' } });
    expect(result.taxableValue).toBe('3600.00');
  });

  it('rejects a discount above its target', () => {
    expectCode(
      () => line({ making, discount: { kind: 'AMOUNT', target: 'MAKING', amount: '100.01' } }),
      'DISCOUNT_EXCEEDS_TARGET',
    );
  });
});

describe('tax', () => {
  it('adds exclusive tax', () => {
    const result = line({ tax: { mode: 'EXCLUSIVE', ratePercent: '5' } });
    expect(result.taxAmount).toBe('183.20');
    expect(result.lineTotal).toBe('3847.20');
  });

  it('extracts inclusive tax from the price', () => {
    const result = line({
      rate: { basis: 'FINE_GRAM', value: '10.0000' },
      grossWeight: '1.000',
      fineness: '1',
      otherCharges: '95.00',
      tax: { mode: 'INCLUSIVE', ratePercent: '5' },
    });
    expect(result.grossLineValue).toBe('105.00');
    expect(result.taxAmount).toBe('5.00');
    expect(result.taxableValue).toBe('100.00');
    expect(result.lineTotal).toBe('105.00');
  });

  it('handles zero-rated lines', () => {
    expect(line({}).taxAmount).toBe('0.00');
  });
});

describe('avoids binary floating-point error', () => {
  it('keeps exact values where floats drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    const result = line({
      grossWeight: '1.000',
      fineness: '1',
      rate: { basis: 'FINE_GRAM', value: '0.1000' },
      otherCharges: '0.20',
    });
    expect(result.grossLineValue).toBe('0.30');
  });

  it('rounds .5 up rather than down on values floats misrepresent', () => {
    // As a float 1.005 is 1.00499999..., which would round to 1.00.
    const result = line({
      grossWeight: '1.005',
      fineness: '1',
      rate: { basis: 'FINE_GRAM', value: '1.0000' },
    });
    expect(result.goldValue).toBe('1.01');
  });
});

describe('guards', () => {
  it.each([
    ['a JS number', { grossWeight: 10 as unknown as string }, 'INVALID_DECIMAL'],
    ['NaN text', { grossWeight: 'NaN' }, 'INVALID_DECIMAL'],
    ['Infinity', { grossWeight: 'Infinity' }, 'INVALID_DECIMAL'],
    ['exponent notation', { grossWeight: '1e3' }, 'INVALID_DECIMAL'],
    ['negative weight', { grossWeight: '-1.000' }, 'NEGATIVE_VALUE'],
    ['zero gross', { grossWeight: '0' }, 'INVALID_WEIGHT'],
    ['excess weight precision', { grossWeight: '1.0001' }, 'EXCESS_PRECISION'],
    ['stones above gross', { stoneWeight: '10.001' }, 'STONE_EXCEEDS_GROSS'],
    ['zero fineness', { fineness: '0' }, 'INVALID_FINENESS'],
    ['fineness above 1', { fineness: '1.0001' }, 'INVALID_FINENESS'],
    ['excess fineness precision', { fineness: '0.91666' }, 'EXCESS_PRECISION'],
    ['zero pieces', { pieces: 0 }, 'INVALID_PIECES'],
    ['fractional pieces', { pieces: 1.5 }, 'INVALID_PIECES'],
    ['zero rate', { rate: { basis: 'FINE_GRAM', value: '0' } }, 'INVALID_RATE'],
    [
      'excess rate precision',
      { rate: { basis: 'FINE_GRAM', value: '1.00001' } },
      'EXCESS_PRECISION',
    ],
    ['excess tax rate', { tax: { mode: 'EXCLUSIVE', ratePercent: '101' } }, 'INVALID_PERCENT'],
  ] as [string, Partial<LineInput>, string][])('rejects %s', (_name, overrides, code) => {
    expectCode(() => line(overrides), code);
  });

  it('refuses a policy with missing rules rather than assuming defaults', () => {
    expectCode(
      () => priceLine(baseLine, { ...policy, taxRounding: undefined } as unknown as PricingPolicy),
      'INVALID_POLICY',
    );
    expectCode(() => priceLine(baseLine, undefined as unknown as PricingPolicy), 'INVALID_POLICY');
  });
});

describe('determinism and traceability', () => {
  it('returns identical results for identical inputs', () => {
    expect(line({})).toEqual(line({}));
  });

  it('records each step and the versions used', () => {
    const result = line({});
    expect(result.trace.map((s) => s.step)).toContain('fineWeight');
    expect(result.trace.find((s) => s.step === 'goldValue')?.output).toBe('3664');
    expect(result.policyVersion).toBe('test-1');
    expect(result.engineVersion).toBe('1.0.0');
  });
});

describe('unit and purity conversion', () => {
  it('converts troy ounces exactly', () => {
    expect(convertWeight('1', 'TOZ', 'G')).toBe('31.1034768');
    expect(convertWeight('31.1034768', 'G', 'TOZ')).toBe('1');
  });

  it('converts kilogram rates to gram rates', () => {
    expect(convertRate('400000', 'KG', 'G')).toBe('400');
  });

  it('requires a configured tola and never assumes one', () => {
    expectCode(() => convertWeight('1', 'TOLA', 'G'), 'UNSUPPORTED_UNIT');
    expect(convertWeight('1', 'TOLA', 'G', { tolaGrams: '11.664' })).toBe('11.664');
  });

  it('converts karat and fineness', () => {
    expect(finenessFromKarat('22', 4, 'HALF_UP')).toBe('0.9167');
    expect(finenessFromKarat('18', 4, 'HALF_UP')).toBe('0.7500');
    expect(karatFromFineness('0.8750', 2, 'HALF_UP')).toBe('21.00');
    expectCode(() => finenessFromKarat('25', 4, 'HALF_UP'), 'INVALID_FINENESS');
  });

  it('converts weight between purities, preserving pure gold', () => {
    expect(convertPurity('10.000', '0.9990', '0.9160', 3, 'HALF_UP')).toBe('10.906');
  });
});

describe('documents', () => {
  const taxed = (value: string) =>
    priceLine(
      {
        ...baseLine,
        grossWeight: '1.000',
        fineness: '1',
        rate: { basis: 'FINE_GRAM', value: '1.0000' },
        otherCharges: value,
        tax: { mode: 'EXCLUSIVE', ratePercent: '5' },
      },
      policy,
    );

  it('sums line-rounded tax', () => {
    // Each line: 1 + 0.10 = 1.10, tax 0.055 rounds to 0.06.
    const result = priceDocument([taxed('0.10'), taxed('0.10')], { adjustment: '0' }, policy);
    expect(result.taxTotal).toBe('0.12');
    expect(result.grandTotal).toBe('2.32');
  });

  it('rounds once per document when configured', () => {
    const result = priceDocument(
      [taxed('0.10'), taxed('0.10')],
      { adjustment: '0' },
      { ...policy, taxRounding: 'DOCUMENT' },
    );
    expect(result.taxTotal).toBe('0.11');
    expect(result.grandTotal).toBe('2.31');
  });

  it('applies a signed adjustment such as cash rounding', () => {
    const result = priceDocument([taxed('0.10')], { adjustment: '-0.01' }, policy);
    expect(result.grandTotal).toBe('1.15');
  });
});

describe('apportionment', () => {
  it('splits a remainder deterministically', () => {
    expect(apportion('100.00', ['1', '1', '1'], 2)).toEqual(['33.34', '33.33', '33.33']);
  });

  it('honours weights and gives zero-weight lines nothing', () => {
    expect(apportion('10.00', ['3', '0', '1'], 2)).toEqual(['7.50', '0.00', '2.50']);
  });

  it('rejects all-zero weights', () => {
    expectCode(() => apportion('1.00', ['0', '0'], 2), 'INVALID_APPORTIONMENT');
  });

  it('always sums exactly to the total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 40 }),
        (minor, weights) => {
          const total = new Decimal(minor).dividedBy(100).toFixed(2);
          const shares = apportion(total, weights.map(String), 2);
          const sum = shares.reduce((acc, s) => acc.plus(s), new Decimal(0));
          expect(sum.toFixed(2)).toBe(total);
        },
      ),
    );
  });
});

describe('payment allocation', () => {
  const items = [
    { id: 'b', outstanding: '100.00', dueDate: '2026-02-01' },
    { id: 'a', outstanding: '50.00', dueDate: '2026-01-01' },
  ];

  it('settles oldest first and reports a partial payment', () => {
    expect(allocatePayment('70.00', items, { kind: 'OLDEST_FIRST' }, 2)).toEqual({
      allocations: [
        { id: 'a', amount: '50.00' },
        { id: 'b', amount: '20.00' },
      ],
      unallocated: '0.00',
    });
  });

  it('keeps an overpayment as unallocated', () => {
    expect(allocatePayment('200.00', items, { kind: 'OLDEST_FIRST' }, 2).unallocated).toBe('50.00');
  });

  it('honours manual allocation', () => {
    const strategy: AllocationStrategy = {
      kind: 'MANUAL',
      allocations: [{ id: 'b', amount: '30.00' }],
    };
    expect(allocatePayment('40.00', items, strategy, 2)).toEqual({
      allocations: [{ id: 'b', amount: '30.00' }],
      unallocated: '10.00',
    });
  });

  it.each([
    ['more than outstanding', '60.00', [{ id: 'a', amount: '50.01' }]],
    ['more than the payment', '10.00', [{ id: 'a', amount: '20.00' }]],
    ['an unknown item', '10.00', [{ id: 'z', amount: '1.00' }]],
    ['a zero amount', '10.00', [{ id: 'a', amount: '0' }]],
    [
      'a duplicated item',
      '60.00',
      [
        { id: 'a', amount: '1.00' },
        { id: 'a', amount: '1.00' },
      ],
    ],
  ])('rejects manual allocation of %s', (_name, amount, allocations) => {
    expectCode(
      () => allocatePayment(amount, items, { kind: 'MANUAL', allocations }, 2),
      'INVALID_ALLOCATION',
    );
  });

  it('never creates or loses money', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 30 }),
        (paymentMinor, outstandingMinor) => {
          const money = (n: number) => new Decimal(n).dividedBy(100).toFixed(2);
          const open = outstandingMinor.map((n, i) => ({
            id: String(i).padStart(3, '0'),
            outstanding: money(n),
            dueDate: '2026-01-01',
          }));
          const result = allocatePayment(money(paymentMinor), open, { kind: 'OLDEST_FIRST' }, 2);
          const allocated = result.allocations.reduce((a, x) => a.plus(x.amount), new Decimal(0));
          expect(allocated.plus(result.unallocated).toFixed(2)).toBe(money(paymentMinor));
          for (const allocation of result.allocations) {
            const item = open.find((o) => o.id === allocation.id)!;
            expect(new Decimal(allocation.amount).lte(item.outstanding)).toBe(true);
          }
        },
      ),
    );
  });
});

describe('balances and profit', () => {
  it('computes outstanding after several payments', () => {
    expect(outstandingBalance('100.00', ['30.00', '20.50'], 2)).toBe('49.50');
  });

  it('rejects overpaid balances', () => {
    expectCode(() => outstandingBalance('10.00', ['10.01'], 2), 'NEGATIVE_VALUE');
  });

  it('computes profit, including a loss', () => {
    expect(grossProfit('3664.00', '3500.25', 2)).toBe('163.75');
    expect(grossProfit('100.00', '120.00', 2)).toBe('-20.00');
  });
});

describe('invariants across random lines', () => {
  it('line total always equals taxable value plus tax', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 9_000_000 }),
        fc.boolean(),
        (grams, fine, rate, inclusive) => {
          const result = priceLine(
            {
              ...baseLine,
              grossWeight: new Decimal(grams).dividedBy(1000).toFixed(3),
              fineness: new Decimal(fine).dividedBy(10000).toFixed(4),
              rate: { basis: 'FINE_GRAM', value: new Decimal(rate).dividedBy(10000).toFixed(4) },
              tax: { mode: inclusive ? 'INCLUSIVE' : 'EXCLUSIVE', ratePercent: '5' },
            },
            policy,
          );
          expect(new Decimal(result.taxableValue).plus(result.taxAmount).toFixed(2)).toBe(
            result.lineTotal,
          );
        },
      ),
    );
  });

  it('inclusive and exclusive tax round-trip within one minor unit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 100_000_000 }), (minor) => {
        const net = new Decimal(minor).dividedBy(100);
        const exclusive = line({
          grossWeight: '1.000',
          fineness: '1',
          rate: { basis: 'FINE_GRAM', value: '0.0001' },
          otherCharges: net.toFixed(2),
          tax: { mode: 'EXCLUSIVE', ratePercent: '5' },
        });
        const inclusive = line({
          grossWeight: '1.000',
          fineness: '1',
          rate: { basis: 'FINE_GRAM', value: '0.0001' },
          otherCharges: new Decimal(exclusive.lineTotal).toFixed(2),
          tax: { mode: 'INCLUSIVE', ratePercent: '5' },
        });
        const drift = new Decimal(inclusive.taxableValue).minus(exclusive.taxableValue).abs();
        expect(drift.lte('0.01')).toBe(true);
      }),
    );
  });
});
