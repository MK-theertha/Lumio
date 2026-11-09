# 7. Gold Calculation Engine

`packages/calc-engine` is a pure TypeScript library. It depends only on `decimal.js`, performs no I/O and has no access to clocks or configuration stores.
Every input, including policy, is passed in, so the same input always gives the same output, and any invoice can be re-verified years later.

## 1. Units and exact constants

Canonical weight unit: **gram**. All other units convert at the boundary.

| Unit       | Grams      | Note                                                                  |
| ---------- | ---------- | --------------------------------------------------------------------- |
| Kilogram   | 1000       | Exact                                                                 |
| Troy ounce | 31.1034768 | Exact by definition                                                   |
| Tola       | 11.6638038 | Trade conventions vary. 11.664 is also seen; **configurable, see Q5** |

Fineness is a dimensionless fraction (0.9160 means 916 parts per thousand).
Karat is a label. **Fineness is never computed from karat at runtime**: each purity record states it explicitly.

## 2. The rate-basis problem

The brief's formula is correct only if the rate is **per gram of fine gold**. Market boards in the UAE commonly quote separate per-gram prices for 24K, 22K, 21K and 18K,
and a 22K rate is already a price for a gram of 22K metal. Applying it to fine weight discounts purity twice.

_Illustrative figures only._ 10.000 g net at 22K, fineness 0.9160:

| Calculation                                        | Result                                     |
| -------------------------------------------------- | ------------------------------------------ |
| Fine rate AED 400.0000/g × fine weight 9.1600 g    | AED 3,664.00 ✔                             |
| 22K rate AED 366.4000/g × net weight 10.000 g      | AED 3,664.00 ✔                             |
| 22K rate AED 366.4000/g × **fine** weight 9.1600 g | AED 3,356.22 ✘ (understated by AED 307.78) |

Every rate therefore has `basis`, and the engine selects the multiplicand from it:

- `FINE_GRAM` → value = fine weight × rate
- `PURITY_GRAM` → value = chargeable net weight × rate, and the rate's purity must match the line's purity

A mismatch raises an error. The engine never guesses.

## 3. Pipeline

```
gross weight
 − stone weight                       = net weight
 + wastage (policy-dependent)         = chargeable weight
 × fineness                           = fine weight
 × rate (by basis)                    = gold value
 + making charges                     = gross line value
 + stone value and other charges
 − discounts                          = taxable value
 + tax                                = line total
Σ lines ± document adjustments        = invoice total
 − allocated payments                 = outstanding
 line total − cost at issue           = gross profit
```

Each ambiguous step is a **policy enum** with no silent default. Until you answer the [open questions](03-risks-and-open-questions.md), the engine rejects a policy that omits one.

| Policy          | Options                                                                |
| --------------- | ---------------------------------------------------------------------- |
| Wastage         | none; % added to weight; % of gold value; fixed grams                  |
| Making charge   | per gram of net; per gram of gross; per piece; % of gold value; fixed  |
| Discount target | gold value; making only; whole line; document level with apportionment |
| Tax mode        | exclusive; inclusive (back-calculated)                                 |
| Tax rounding    | per line; per document                                                 |

## 4. Precision and rounding (proposed defaults, centrally configured)

Intermediates carry 34 significant digits, matching `Decimal128`. Rounding occurs **only at the named stage**, and only once.

| Quantity           | Scale                                        | Rounding                  | Stage                      |
| ------------------ | -------------------------------------------- | ------------------------- | -------------------------- |
| Weight (g)         | 3 dp (mg)                                    | As entered, reject excess | Input                      |
| Fine weight (g)    | 4 dp                                         | HALF_UP                   | After purity               |
| Fineness           | 4 dp                                         | Exact, reject excess      | Purity master              |
| Rate per g         | 4 dp                                         | Exact, reject excess      | Rate entry                 |
| Money              | Currency minor unit (AED 2; KWD, BHD, OMR 3) | HALF_UP                   | Per component of each line |
| Tax                | Currency minor unit                          | HALF_UP                   | Per policy                 |
| Average cost per g | 6 dp                                         | HALF_UP                   | Valuation                  |

Whether HALF_UP is required, and whether rounding is per line or per document, needs confirmation against FTA requirements and your accountant ([Q6](03-risks-and-open-questions.md)).

## 5. Interface

```ts
priceLine(input: LineInput, policy: PricingPolicy): LineResult
priceDocument(lines: LineResult[], adj: DocumentAdjustments, policy): DocumentResult
convertWeight(value, from, to): Decimal
fineWeight(net, fineness, rounding): Decimal
allocatePayment(amount, openItems, strategy): Allocation[]   // allocations sum exactly to amount
apportion(total, weights, scale): Decimal[]                  // largest-remainder; sums exactly to total
grossProfit(lineTotalExTax, costAtIssue): Decimal
```

Every result includes a `trace`: an ordered list of `{step, formula, inputs, output}`, stored on the invoice line along with `engineVersion`.
The trace answers "how did you arrive at this number?" for an auditor or a customer dispute.

**Guards.** Inputs are decimal strings. Passing a JS `number` is a type error and a runtime error. Negative weights, stone weight above gross,
fineness outside (0, 1], unsupported precision and `NaN` or infinite values are all rejected with typed errors.

## 6. Versioning

A change in behaviour increments `engineVersion`, with a new set of golden vectors. Old versions remain callable so historical verification continues to work.

## 7. Test expectations

Golden vectors signed off by your accountant, property tests (allocations and apportionments always sum exactly; tax inclusive and exclusive round-trip within one minor unit),
boundary tests at each scale, and invalid-input tests for each guard. See [testing](../architecture/06-testing-strategy.md).
