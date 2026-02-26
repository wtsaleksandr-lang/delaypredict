# DelayPredict

Ocean freight delay risk & expected-value calculator for delay insurance.

## Purpose

A fully client-side, browser-based tool that estimates delay probability, expected payout, and ROI for ocean freight delay insurance policies — across 6, 8, and 10-day trigger options.

**Does not sell insurance. Does not place policies. Estimation only.**

## Architecture

- **Frontend only** — all calculations in the browser, no backend data needed
- React + TypeScript + Vite
- Shadcn UI components, Tailwind CSS, dark theme by default
- `wouter` for routing

## Key Files

- `client/src/lib/calculations.ts` — entire math engine (risk score, probabilities, EV, ROI, rate table)
- `client/src/pages/home.tsx` — full UI (inputs, results, trigger comparison, rate table)
- `client/src/App.tsx` — app root, dark mode forced on mount

## Math Model

1. **Transit days**: computed from ETD → ETA (defaults to 21d)
2. **Risk Score (0–100)**: weighted sum of transit length (20pts), transshipments (20pts), port congestion (20pts), carrier reliability (15pts), season risk (10pts), route risk (10pts), buffer tightness (5pts)
3. **Base delay probability**: 5% + (score/100) × 55%
4. **Expected delay days**: (score/100) × 12 days
5. **Per trigger (6/8/10 day)**:
   - Rate from hard-coded table (Low/Med/High tier)
   - Insured limit = budget / rate, clamped [$1k, $250k]
   - Premium = insured_limit × rate
   - Trigger probability = base_prob × multiplier (6d:1.00, 8d:0.78, 10d:0.62), capped at 85%
   - Payout % = min(100%, 50% + 5% × max(0, expected_delay_days − trigger_days))
   - Expected payout = trigger_prob × limit × payout_pct
   - EV = expected_payout − premium
   - ROI = EV / premium
6. **Best trigger**: highest EV
7. **Recommendation**: INSURE (EV>0 && ROI≥1), OPTIONAL (EV>0 && ROI<1), SKIP (EV≤0)

## Insurance Rate Table (hard-coded)

| Trigger | Low    | Medium | High   |
|---------|--------|--------|--------|
| 10-day  | 1.08%  | 1.22%  | 1.37%  |
| 8-day   | 1.40%  | 1.57%  | 1.77%  |
| 6-day   | 2.39%  | 2.68%  | 3.02%  |

## User Inputs

- Origin / destination port (text)
- ETD / ETA (date)
- Transshipments count (number, default 1)
- Budget slider $20–$300 step $5
- Risk tier (Low / Medium / High, default High)
- Advanced (collapsible): port congestion ×3, season risk, route risk, carrier reliability, buffer tightness

## Dependencies

No additional packages installed beyond the base template.
