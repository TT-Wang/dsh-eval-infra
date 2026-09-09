/**
 * Paired report over the ledgers of one run. Rules, in order:
 *   1. Correctness first: a scenario the baseline passes and the candidate
 *      fails is a regression, and a candidate with regressions fails the gate
 *      regardless of cost.
 *   2. Cost is compared only on repeat-pairs where BOTH arms passed, so a run
 *      that stopped early by failing never looks cheap.
 *   3. Aggregates carry a bootstrap interval over scenarios; an interval that
 *      covers zero reads "no difference".
 */
import { icc, mcnemar, mean, median, normalQuantile, passPow, resolution, sequenceSimilarity, signTest, smallSampleCI, wilson, tCritical, stddev } from './stats.js';
function behaviourMean(rows) {
    const n = Math.max(1, rows.length);
    const sum = rows.reduce((a, r) => ({ toolErrors: a.toolErrors + (r.behaviour?.toolErrors ?? 0), repeatedCalls: a.repeatedCalls + (r.behaviour?.repeatedCalls ?? 0), noActionSteps: a.noActionSteps + (r.behaviour?.noActionSteps ?? 0), observationChars: a.observationChars + (r.behaviour?.observationChars ?? 0), compactions: a.compactions + (r.behaviour?.compactions ?? 0) }), { toolErrors: 0, repeatedCalls: 0, noActionSteps: 0, observationChars: 0, compactions: 0 });
    return { toolErrors: sum.toolErrors / n, repeatedCalls: sum.repeatedCalls / n, noActionSteps: sum.noActionSteps / n, observationChars: sum.observationChars / n, compactions: sum.compactions / n };
}
function failureReasons(rows) {
    const counts = new Map();
    for (const r of rows) {
        if (r.verdict?.ok === true && r.error === undefined)
            continue;
        const reason = (r.error !== undefined ? `runtime: ${r.error}` : r.verdict?.detail ?? 'no verdict').replace(/\s+/g, ' ').slice(0, 140);
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n }));
}
/** One word from the gate, the correctness improvements and the north-star reading; the same rule wherever a grade is made. */
export function gradeOf(gate, improvements, ns) {
    if (gate === 'regressions' || gate === 'unsafe')
        return 'regression';
    if (gate === 'incomplete' || gate === 'suspect')
        return 'inconclusive';
    if (improvements > 0 && (ns === 'better' || ns === 'same' || ns === 'none'))
        return 'improvement';
    if (improvements > 0 && ns === 'worse')
        return 'tradeoff';
    if (ns === 'better')
        return 'improvement';
    if (ns === 'worse')
        return 'regression';
    if (ns === 'same')
        return 'tie';
    return 'inconclusive';
}
/**
 * The quality reading, made once the blinded judge has run: the candidate's wins
 * against its losses over the decided pairs, read with the same rules as the
 * other north stars (five decided pairs, mid-p at alpha, equivalence by posterior).
 */
export function qualityReading(c, wins, losses, ties, minScenarios = 5) {
    const decided = wins + losses;
    const stat = mcnemar(wins, losses);
    const counts = `${wins} won / ${losses} lost / ${ties} tied`;
    let reading;
    let text;
    if (decided + ties === 0) {
        reading = 'none';
        text = 'The judge compared no pairs.';
    }
    else if (decided < minScenarios) {
        reading = 'inconclusive';
        text = `Only ${decided} decided pair${decided === 1 ? '' : 's'} (${counts}); fewer than ${minScenarios} cannot support a preference.`;
    }
    else if (stat.midP < c.alpha) {
        reading = wins > losses ? 'better' : 'worse';
        text = `The judge prefers the ${wins > losses ? 'candidate' : 'baseline'} (${counts}, mid-p ${stat.midP.toFixed(3)}, P(candidate) ${(stat.pWin * 100).toFixed(0)}%).`;
    }
    else if (stat.inRope >= 0.95) {
        reading = 'same';
        text = `No preference: the judge splits evenly (${counts}).`;
    }
    else {
        reading = 'inconclusive';
        text = `Preference inconclusive (${counts}, mid-p ${stat.midP.toFixed(2)}); more pairs needed.`;
    }
    return { metric: 'quality', reading, ci: null, unit: 'wins', text };
}
/** Noise floor of an A/A run: the same statistics the candidate report uses, applied to two copies of one arm. */
export function noiseFloorOf(plan, ledgers, alpha = readingAlpha({ candidates: [{ name: 'one' }] })) {
    const twin = plan.candidates.find(c => c.name === `${plan.baseline.name}-aa`);
    if (twin === undefined)
        return null;
    const all = plan.scenarios.map(s => pairScenario(s, armScenarioStats(plan.baseline.name, s, ledgers), armScenarioStats(twin.name, s, ledgers), plan.repeats));
    const pairs = all.filter(p => p.costDiffPct !== null);
    if (pairs.length === 0)
        return null;
    const ci = smallSampleCI(pairs.map(p => p.costDiffPct), 2000, 42, alpha);
    const withSteps = all.filter(p => p.stepsDiffPct !== null);
    const stepsCI = withSteps.length ? smallSampleCI(withSteps.map(p => p.stepsDiffPct), 2000, 42, alpha) : null;
    return {
        runId: plan.id,
        kind: plan.perturb ? 'perturbation' : 'rerun',
        scenarios: pairs.length,
        meanAbsPct: mean(pairs.map(p => Math.abs(p.costDiffPct))),
        lo: ci.lo,
        hi: ci.hi,
        ...(stepsCI ? { steps: { lo: stepsCI.lo, hi: stepsCI.hi, scenarios: withSteps.length } } : {}),
    };
}
/** The alpha every planned claim is read at: two claims per candidate (north-star direction, reliability direction) share 5%; sequential mode runs three sequences. */
export function readingAlpha(plan) {
    if (plan.sequential)
        return 0.05 / 3;
    return 0.05 / (2 * Math.max(1, plan.candidates.length));
}
/** Does the interval [lo, hi] reach into the band [bandLo, bandHi]? Two intervals of the same estimator; overlap means the difference is not distinguishable from the baseline's own noise. */
export function withinNoise(ci, band) {
    return !(ci.lo > band.hi || ci.hi < band.lo);
}
function armSummary(arm, pairs, side, ledgers, repeats) {
    const stats = pairs.map(p => p[side]);
    const rows = ledgers.filter(l => l.arm === arm);
    const solved = rows.filter(r => r.verdict?.ok === true && r.error === undefined);
    const tokens = rows.reduce((a, r) => a + r.totals.hit + r.totals.miss + r.totals.output, 0);
    const usd = rows.reduce((a, r) => a + r.totals.usd, 0);
    const hit = rows.reduce((a, r) => a + r.totals.hit, 0);
    const miss = rows.reduce((a, r) => a + r.totals.miss, 0);
    // pass^k and pass-any-k are read over the scenarios with every repeat, the same denominator as the reliability headline.
    const withRuns = stats.filter(s => s.n >= Math.max(1, repeats));
    return {
        arm,
        runs: rows.length,
        passes: solved.length,
        passAllK: withRuns.length ? withRuns.filter(s => s.passes === s.n).length / withRuns.length : 0,
        passAnyK: withRuns.length ? withRuns.filter(s => s.passes > 0).length / withRuns.length : 0,
        usd,
        tokensPerSolved: solved.length ? tokens / solved.length : null,
        usdPerSolved: solved.length ? usd / solved.length : null,
        cacheHitShare: hit + miss > 0 ? hit / (hit + miss) : 0,
    };
}
function armScenarioStats(arm, scenario, ledgers) {
    // A trial the infrastructure could not grade is not evidence about the arm: it is left out here, so the
    // scenario reads incomplete for that pair instead of counting against whichever arm's container broke.
    const rows = ledgers.filter(l => l.arm === arm && l.scenario === scenario && l.errorKind !== 'infrastructure').sort((a, b) => a.rep - b.rep);
    const passed = rows.filter(r => r.verdict?.ok === true && r.error === undefined);
    const usd = rows.map(r => r.totals.usd);
    const byRep = {};
    for (const r of rows)
        byRep[r.rep] = { ok: r.verdict?.ok === true && r.error === undefined, usd: r.totals.usd, error: r.error !== undefined, steps: r.totals.steps, usdPeak: r.totals.usdPeak, usdOffpeak: r.totals.usdOffpeak, ...(r.overridden ? { overridden: true } : {}) };
    return {
        arm,
        scenario,
        n: rows.length,
        passes: passed.length,
        errors: rows.filter(r => r.error !== undefined).length,
        unsafe: rows.filter(r => (r.violations?.length ?? 0) > 0).length,
        passRate: rows.length === 0 ? 0 : passed.length / rows.length,
        passCI: wilson(passed.length, rows.length),
        usd,
        usdMean: mean(usd),
        usdMedian: median(usd),
        usdPeakMean: mean(rows.map(r => r.totals.usdPeak)),
        usdOffpeakMean: mean(rows.map(r => r.totals.usdOffpeak)),
        stepsMean: mean(rows.map(r => r.totals.steps)),
        hitMean: mean(rows.map(r => r.totals.hit)),
        missMean: mean(rows.map(r => r.totals.miss)),
        outputMean: mean(rows.map(r => r.totals.output)),
        reasoningMean: mean(rows.map(r => r.totals.reasoning)),
        wallMsMean: mean(rows.map(r => r.wallMs)),
        peakPromptMax: rows.reduce((m, r) => Math.max(m, r.totals.peakPrompt), 0),
        byRep,
    };
}
function classify(b, c, repeats) {
    if (b.n === 0 && c.n === 0)
        return 'unrun';
    if (b.n < repeats || c.n < repeats)
        return 'incomplete';
    // The safety gate: a candidate that did something it was not asked to, on any repeat, where the baseline never did.
    // When both arms do, the candidate is not worse for it; the report says so in its notes instead.
    if (c.unsafe > 0 && b.unsafe === 0)
        return 'unsafe';
    // A regression is called only when it is consistent: the baseline passed every repeat and the candidate failed every one.
    // With k repeats no per-scenario test can separate flakiness from breakage (3/3 vs 0/3 is p = 0.05 one-sided), so the
    // gate is a screening rule: suspicion blocks the readings, only consistency is called; a rerun settles the rest.
    const bAll = b.passes === b.n;
    const cAll = c.passes === c.n;
    if (bAll && c.passes === 0)
        return 'regression';
    if (cAll && b.passes === 0)
        return 'improvement';
    if (b.passRate >= 0.5 && c.passRate <= 0.5 && c.passRate < b.passRate)
        return 'suspected';
    if (b.passRate < 0.5 && c.passRate < 0.5)
        return 'both-fail';
    return 'same';
}
function pairScenario(scenario, b, c, repeats, ledgers = [], holdout = false) {
    const cls = classify(b, c, repeats);
    const rowsB = ledgers.filter(l => l.arm === b.arm && l.scenario === scenario);
    const rowsC = ledgers.filter(l => l.arm === c.arm && l.scenario === scenario);
    const flakyB = b.n >= 2 && b.passes > 0 && b.passes < b.n;
    const flakyC = c.n >= 2 && c.passes > 0 && c.passes < c.n;
    const seqOf = (l) => l.steps.flatMap(st => st.calls.map(cl => cl.name));
    const within = (rows) => {
        const seqs = rows.map(seqOf);
        if (seqs.length < 2)
            return null;
        let total = 0;
        let pairsN = 0;
        for (let i = 0; i < seqs.length; i += 1)
            for (let j = i + 1; j < seqs.length; j += 1) {
                total += sequenceSimilarity(seqs[i], seqs[j]);
                pairsN += 1;
            }
        return pairsN ? total / pairsN : null;
    };
    const betweenVals = [];
    for (const rb of rowsB) {
        const rc = rowsC.find(x => x.rep === rb.rep);
        if (rc)
            betweenVals.push(sequenceSimilarity(seqOf(rb), seqOf(rc)));
    }
    let divergence = null;
    for (const rb of rowsB) {
        const rc = rowsC.find(x => x.rep === rb.rep);
        if (!rc)
            continue;
        const okB = rb.verdict?.ok === true && rb.error === undefined;
        const okC = rc.verdict?.ok === true && rc.error === undefined;
        if (okB === okC)
            continue;
        const sb = seqOf(rb);
        const sc = seqOf(rc);
        let i = 0;
        while (i < sb.length && i < sc.length && sb[i] === sc[i])
            i += 1;
        divergence = { rep: rb.rep, call: i + 1, baseline: sb[i] ?? '(stops)', candidate: sc[i] ?? '(stops)', failing: okB ? c.arm : b.arm };
        break;
    }
    const diffs = [];
    const pct = [];
    const peak = [];
    const off = [];
    const steps = [];
    const stepsPct = [];
    for (const rep of Object.keys(b.byRep).map(Number)) {
        const x = b.byRep[rep];
        const y = c.byRep[rep];
        if (x === undefined || y === undefined || !x.ok || !y.ok)
            continue;
        // Every cost estimand (Δ$, Δ%, fixed-band Δ$) is read over the same pairs: both passed and the baseline had a priced cost.
        if (x.usd > 0) {
            diffs.push(y.usd - x.usd);
            pct.push((y.usd - x.usd) / x.usd * 100);
            peak.push(y.usdPeak - x.usdPeak);
            off.push(y.usdOffpeak - x.usdOffpeak);
        }
        steps.push(y.steps - x.steps);
        if (x.steps > 0)
            stepsPct.push((y.steps - x.steps) / x.steps * 100);
    }
    const passedBaseline = Object.values(b.byRep).filter(r => r.ok).map(r => r.usd);
    const spread = passedBaseline.length >= 2 && mean(passedBaseline) > 0 ? (Math.max(...passedBaseline) - Math.min(...passedBaseline)) / mean(passedBaseline) * 100 : null;
    return {
        scenario,
        baseline: b,
        candidate: c,
        class: cls,
        flaky: flakyB || flakyC,
        failures: { baseline: failureReasons(rowsB), candidate: failureReasons(rowsC) },
        tss: { baseline: within(rowsB), candidate: within(rowsC), between: betweenVals.length ? mean(betweenVals) : null },
        divergence,
        behaviour: { baseline: behaviourMean(rowsB), candidate: behaviourMean(rowsC) },
        costPairs: diffs.length,
        costDiffPctPairs: pct,
        holdout,
        violations: { baseline: b.unsafe, candidate: c.unsafe, evidence: rowsC.flatMap(r => r.violations ?? []).concat(rowsB.flatMap(r => r.violations ?? []))[0]?.evidence ?? null },
        costDiffUsd: diffs.length ? mean(diffs) : null,
        costDiffPct: pct.length ? mean(pct) : null,
        costDiffPeakUsd: peak.length ? mean(peak) : null,
        costDiffOffpeakUsd: off.length ? mean(off) : null,
        stepsDiff: steps.length ? mean(steps) : null,
        stepsDiffPct: stepsPct.length ? mean(stepsPct) : null,
        baselineSpreadPct: spread,
    };
}
export function buildReport(plan, ledgers, options = {}) {
    const sesoi = options.sesoiPct ?? 10;
    const minScenarios = options.minScenarios ?? 5;
    const scenarios = [...new Set([...plan.scenarios, ...ledgers.map(l => l.scenario)])];
    const notes = [];
    // Joint bound across the planned claims: two claims per candidate (cost direction, pass-rate direction) for m candidates,
    // so every interval is read at 0.05 / (2m) and the family-wise error over all planned claims stays at 5%.
    const alpha = readingAlpha(plan);
    const drifted = options.drift?.verdict === 'drift';
    const holdoutSet = options.holdout ?? new Set();
    const candidates = plan.candidates.map((cand) => {
        const pairs = scenarios.map(s => pairScenario(s, armScenarioStats(plan.baseline.name, s, ledgers), armScenarioStats(cand.name, s, ledgers), plan.repeats, ledgers, holdoutSet.has(s)));
        const comparable = pairs.filter(p => p.costDiffUsd !== null);
        // A perturbed run is gated by the perturbation floor when one exists; a plain run by the rerun floor.
        const floorKind = plan.perturb ? 'perturbation' : 'rerun';
        const floorOnFile = options.noiseFloors?.[`${plan.baseline.name}|${floorKind}`] ?? options.noiseFloors?.[plan.baseline.name] ?? null;
        const floorStatus = floorOnFile === null ? 'missing' : drifted ? 'stale' : floorOnFile.scenarios < minScenarios ? 'thin' : 'ok';
        const noiseFloor = floorStatus === 'ok' ? floorOnFile : null;
        const floorText = floorStatus === 'missing' ? 'no A/A floor has been measured on this baseline'
            : floorStatus === 'thin' ? `the A/A floor on file (${floorOnFile.runId}) covers only ${floorOnFile.scenarios} scenario${floorOnFile.scenarios === 1 ? '' : 's'}, fewer than the ${minScenarios} a direction needs`
                : floorStatus === 'stale' ? `the A/A floor on file (${floorOnFile.runId}) predates a detected drift of the baseline's behaviour`
                    : '';
        const unpricedTrials = ledgers.filter(l => (l.arm === plan.baseline.name || l.arm === cand.name) && l.unpriced === true);
        let wins = 0;
        let losses = 0;
        for (const p of pairs) {
            for (const rep of Object.keys(p.baseline.byRep).map(Number)) {
                const x = p.baseline.byRep[rep];
                const y = p.candidate.byRep[rep];
                if (x === undefined || y === undefined)
                    continue;
                if (y.ok && !x.ok)
                    wins += 1;
                if (x.ok && !y.ok)
                    losses += 1;
            }
        }
        const unsafe = pairs.filter(p => p.class === 'unsafe').map(p => p.scenario);
        const bothUnsafe = pairs.filter(p => p.class !== 'unsafe' && p.violations.baseline > 0 && p.violations.candidate > 0).map(p => p.scenario);
        const regressions = pairs.filter(p => p.class === 'regression').map(p => p.scenario);
        const suspected = pairs.filter(p => p.class === 'suspected').map(p => p.scenario);
        // Screening calibration: under "no true difference on this scenario" both arms share the pooled pass rate p̂, and a
        // consistent regression (baseline all pass, candidate all fail) arises with probability p̂^n_b (1−p̂)^n_c; over the
        // scenarios with complete repeats, the chance of at least one such false alarm is what the gate's word is worth.
        const completePairs = pairs.filter(p => p.class !== 'incomplete' && p.class !== 'unrun');
        let regressionChance = null;
        if (completePairs.length > 0) {
            let none = 1;
            for (const p of completePairs) {
                const pooled = (p.baseline.passes + p.candidate.passes) / Math.max(1, p.baseline.n + p.candidate.n);
                none *= 1 - pooled ** p.baseline.n * (1 - pooled) ** p.candidate.n;
            }
            regressionChance = 1 - none;
        }
        const improvements = pairs.filter(p => p.class === 'improvement').map(p => p.scenario);
        const bothFail = pairs.filter(p => p.class === 'both-fail').map(p => p.scenario);
        const incomplete = pairs.filter(p => p.class === 'incomplete').map(p => p.scenario);
        const costCI = smallSampleCI(comparable.map(p => p.costDiffUsd), 2000, 42, alpha);
        // Cluster interval: scenarios are the unit and carry all their repeat pairs (per-scenario means); t-interval below 10 scenarios, percentile bootstrap from 10 (Indeed 2026 measured nominal coverage for the cluster design).
        let costPctCI = smallSampleCI(comparable.map(p => p.costDiffPct), 2000, 42, alpha);
        const seq = options.sequences?.[cand.name];
        if (seq?.cost) {
            // Under optional stopping only the time-uniform sequence keeps its coverage; the bootstrap interval would be too narrow.
            costPctCI = { mean: seq.cost.mean, lo: seq.cost.lo, hi: seq.cost.hi, n: seq.scenarios, significant: seq.cost.lo > 0 || seq.cost.hi < 0 };
        }
        const iccStat = icc(comparable.map(p => p.costDiffPctPairs));
        // CUPED (Deng et al. 2013): d̃_i = d_i − θ (x_i − x̄) with a pre-experiment covariate; variance falls by ρ².
        let cuped = null;
        // A covariate measured before a detected drift of the baseline is not the same quantity; CUPED is then not applied.
        if (options.priorBaselineUsd && !drifted) {
            const xs = [];
            const ds = [];
            for (const p of comparable) {
                const x = options.priorBaselineUsd[p.scenario];
                if (x !== undefined && p.costDiffPct !== null) {
                    xs.push(x);
                    ds.push(p.costDiffPct);
                }
            }
            if (xs.length >= 4) {
                const mx = mean(xs);
                const md = mean(ds);
                const cov = xs.reduce((a, x, i) => a + (x - mx) * (ds[i] - md), 0) / (xs.length - 1);
                const vx = xs.reduce((a, x) => a + (x - mx) ** 2, 0) / (xs.length - 1);
                const vd = ds.reduce((a, d) => a + (d - md) ** 2, 0) / (ds.length - 1);
                if (vx > 0 && vd > 0) {
                    const theta = cov / vx;
                    const adjusted = ds.map((d, i) => d - theta * (xs[i] - mx));
                    const rho2 = Math.min(1, cov * cov / (vx * vd));
                    cuped = { theta, varianceRemoved: rho2, ci: smallSampleCI(adjusted, 2000, 42, alpha), n: xs.length };
                }
            }
        }
        const pairedStat = mcnemar(wins, losses);
        const resolutionStat = resolution(comparable.map(p => p.costDiffPct), alpha);
        const costPeakCI = smallSampleCI(comparable.map(p => p.costDiffPeakUsd ?? 0), 2000, 42, alpha);
        const costOffpeakCI = smallSampleCI(comparable.map(p => p.costDiffOffpeakUsd ?? 0), 2000, 42, alpha);
        const ran = pairs.filter(p => p.class !== 'unrun');
        const gate = unsafe.length > 0 ? 'unsafe' : regressions.length > 0 ? 'regressions' : suspected.length > 0 ? 'suspect' : ran.length === 0 || incomplete.length === ran.length ? 'incomplete' : 'pass';
        const complete = pairs.filter(p => p.class !== 'incomplete' && p.class !== 'unrun');
        let passDiffCI = smallSampleCI(complete.map(p => (p.candidate.passRate - p.baseline.passRate) * 100), 2000, 42, alpha);
        if (seq?.pass) {
            // Optionally-stopped data: the anytime-valid pass-difference sequence (x = (Δpass + 1) / 2, so Δpp = (2x − 1) × 100) replaces the fixed-sample interval.
            const lo = (2 * seq.pass.lo - 1) * 100;
            const hi = (2 * seq.pass.hi - 1) * 100;
            passDiffCI = { mean: passDiffCI.mean, lo, hi, n: seq.scenarios, significant: lo > 0 || hi < 0 };
        }
        const dev = complete.filter(p => !p.holdout);
        const held = complete.filter(p => p.holdout);
        const holdoutGap = held.length > 0 ? { dev: mean(dev.map(p => (p.candidate.passRate - p.baseline.passRate) * 100)), holdout: mean(held.map(p => (p.candidate.passRate - p.baseline.passRate) * 100)), devScenarios: dev.length, holdoutScenarios: held.length } : null;
        const flaky = pairs.filter(p => p.flaky).map(p => p.scenario);
        const pctDiffs = comparable.map(p => p.costDiffPct);
        const mdePct = pctDiffs.length >= 3 ? (tCritical(pctDiffs.length - 1, alpha) + normalQuantile(0.8)) * stddev(pctDiffs) / Math.sqrt(pctDiffs.length) : null;
        const passBaseline = pairs.reduce((a, p) => a + p.baseline.passes, 0);
        const passCandidate = pairs.reduce((a, p) => a + p.candidate.passes, 0);
        const runsBaseline = pairs.reduce((a, p) => a + p.baseline.n, 0);
        const runsCandidate = pairs.reduce((a, p) => a + p.candidate.n, 0);
        let verdict;
        let costReading = 'none';
        const ciText = `${fmtPct(costPctCI.mean)}, 95% CI ${fmtPct(costPctCI.lo)} to ${fmtPct(costPctCI.hi)}, ${comparable.length} scenario${comparable.length === 1 ? '' : 's'}`;
        const gains = improvements.length ? ` Improves correctness on ${improvements.join(', ')}.` : '';
        let insideNoise = false;
        let floorBlocked = false;
        if (unpricedTrials.length > 0)
            costReading = 'none';
        else if (comparable.length > 0) {
            if (comparable.length < minScenarios)
                costReading = 'inconclusive';
            else if (costPctCI.significant) {
                costReading = costPctCI.mean < 0 ? 'cheaper' : 'more-expensive';
                // A direction is judged against what "no change" looks like on this baseline: the A/A run's own interval at the
                // same alpha and estimator. No usable floor, no direction; an interval that reaches into the band is not a call.
                if (noiseFloor === null) {
                    costReading = 'inconclusive';
                    floorBlocked = true;
                }
                else if (withinNoise(costPctCI, noiseFloor)) {
                    costReading = 'inconclusive';
                    insideNoise = true;
                }
            }
            else if (costPctCI.lo > -sesoi && costPctCI.hi < sesoi)
                costReading = 'equivalent';
            else
                costReading = 'inconclusive';
        }
        // Usage provenance: a directional or equivalence cost call needs the runtime's usage figures to match the independent wire meter on every comparable trial.
        const pairLedgers = ledgers.filter(l => (l.arm === plan.baseline.name || l.arm === cand.name) && comparable.some(c => c.scenario === l.scenario));
        const unreconciled = pairLedgers.filter(l => (l.usageProvenance?.source === 'meter' || l.usageProvenance?.source === 'replay') && l.usageProvenance.reconciled === false);
        let provenanceBlocked = false;
        // Provenance and served-model failures outrank the floor: figures that cannot be trusted are withheld whether or not a floor exists.
        const wouldRead = () => costReading === 'cheaper' || costReading === 'more-expensive' || costReading === 'equivalent' || floorBlocked || insideNoise;
        if (unreconciled.length > 0 && wouldRead()) {
            costReading = 'inconclusive';
            provenanceBlocked = true;
            floorBlocked = false;
            insideNoise = false;
        }
        // Served-model check: every metered response must report the model the arm requested, and both arms the same one.
        const servedMismatch = [];
        const servedByArm = new Map();
        for (const l of pairLedgers) {
            const served = l.usageProvenance?.meter?.servedModels ?? [];
            if (served.length === 0)
                continue;
            servedByArm.set(l.arm, new Set([...(servedByArm.get(l.arm) ?? []), ...served]));
            if (served.length !== 1 || served[0] !== l.model)
                servedMismatch.push(`${l.scenario}/${l.arm}#${l.rep}: requested ${l.model}, served ${served.join('+')}`);
        }
        if (servedByArm.size === 2) {
            const [x, y] = [...servedByArm.values()];
            if ([...x].sort().join() !== [...y].sort().join())
                servedMismatch.push('the two arms were served different models');
        }
        // Only one arm left served-model records on the comparable trials: the other arm's route was never checked, so the arms cannot be said to have shared a served model.
        if (servedByArm.size === 1) {
            const unchecked = [plan.baseline.name, cand.name].find(a => !servedByArm.has(a) && pairLedgers.some(l => l.arm === a));
            if (unchecked !== undefined)
                servedMismatch.push(`no served-model record on ${unchecked}'s comparable trials; the arms were not verified to share a served model`);
        }
        if (options.probe?.verdict === 'differs')
            servedMismatch.unshift(`the route's answer distribution differs from the enrolled reference for ${options.probe.model} (probe distance ${options.probe.distance.toFixed(3)}, p = ${options.probe.p.toFixed(3)})`);
        let servedBlocked = false;
        if (servedMismatch.length > 0 && (wouldRead() || provenanceBlocked)) {
            costReading = 'inconclusive';
            servedBlocked = true;
            floorBlocked = false;
            insideNoise = false;
        }
        // Reliability: pass^k per arm over the scenarios with complete repeats on both sides, and the paired
        // comparison of "reliable here" — the same McNemar / Beta machinery as the per-trial pairing, one unit per scenario.
        const k = plan.repeats;
        const withK = pairs.filter(p => p.baseline.n >= k && p.candidate.n >= k);
        const reliableB = (p) => p.baseline.passes === p.baseline.n;
        const reliableC = (p) => p.candidate.passes === p.candidate.n;
        let relB = 0;
        let relC = 0;
        for (const p of withK) {
            if (reliableC(p) && !reliableB(p))
                relB += 1;
            if (reliableB(p) && !reliableC(p))
                relC += 1;
        }
        const relStat = mcnemar(relB, relC);
        const decay = (side) => Array.from({ length: k }, (_, i) => withK.length ? mean(withK.map(p => passPow(p[side].passes, p[side].n, i + 1))) : 0);
        const reliability = {
            k,
            scenarios: withK.length,
            baseline: withK.length ? withK.filter(reliableB).length / withK.length : 0,
            candidate: withK.length ? withK.filter(reliableC).length / withK.length : 0,
            b: relB,
            c: relC,
            midP: relStat.midP,
            pWin: relStat.pWin,
            inRope: relStat.inRope,
            decay: { baseline: decay('baseline'), candidate: decay('candidate') },
            reading: seq !== undefined
                // Optionally-stopped data: only the reliability confidence sequence (x = (Δreliable + 1) / 2) is read; 0.5 is "no difference".
                ? (seq.reliability === null || seq.reliability === undefined || withK.length < minScenarios ? 'inconclusive'
                    : seq.reliability.lo > 0.5 ? 'more-reliable' : seq.reliability.hi < 0.5 ? 'less-reliable'
                        : seq.reliability.lo > 0.45 && seq.reliability.hi < 0.55 ? 'same' : 'inconclusive')
                : withK.length < minScenarios ? 'inconclusive'
                    : relB + relC === 0 ? 'same'
                        : relStat.midP < alpha ? (relB > relC ? 'more-reliable' : 'less-reliable')
                            : relStat.inRope >= 0.95 ? 'same'
                                : 'inconclusive',
        };
        // The north star: the reading the run was registered for. Cost reuses the reading above; efficiency
        // applies the same rules to steps on the pairs where both arms passed; quality needs the judge.
        const metric = plan.northStar ?? 'cost';
        let northStar;
        if (metric === 'cost') {
            northStar = { metric, reading: costReading === 'cheaper' ? 'better' : costReading === 'more-expensive' ? 'worse' : costReading === 'equivalent' ? 'same' : costReading, ci: costPctCI, unit: '%', text: '' };
        }
        else if (metric === 'efficiency') {
            const withSteps = comparable.filter(p => p.stepsDiffPct !== null);
            const stepsCI = smallSampleCI(withSteps.map(p => p.stepsDiffPct), 2000, 42, alpha);
            const stepsText = `${fmtPct(stepsCI.mean)} steps, 95% CI ${fmtPct(stepsCI.lo)} to ${fmtPct(stepsCI.hi)}, ${withSteps.length} scenario${withSteps.length === 1 ? '' : 's'}`;
            let reading;
            let text;
            if (withSteps.length === 0) {
                reading = 'none';
                text = 'No scenario where both arms passed; nothing to compare on steps.';
            }
            else if (withSteps.length < minScenarios) {
                reading = 'inconclusive';
                text = withSteps.length < 2 ? `Single comparable scenario: ${fmtPct(stepsCI.mean)} on steps, no interval possible; add scenarios or repeats before reading this as an effect.` : `Only ${withSteps.length} comparable scenarios (${stepsText}); fewer than ${minScenarios} scenarios cannot support a direction.`;
            }
            else if (stepsCI.significant) {
                if (noiseFloor === null) {
                    reading = 'inconclusive';
                    text = `Step interval (${stepsText}) excludes zero, but ${floorText}; a direction is not read until one is: dsh-eval run --baseline ${plan.baseline.name} --aa.`;
                }
                else if (noiseFloor.steps === undefined) {
                    reading = 'inconclusive';
                    text = `Step interval (${stepsText}) excludes zero, but the A/A run ${noiseFloor.runId} has no step band (no pair with both arms passing); re-measure the floor before reading a direction on steps.`;
                }
                else if (withinNoise(stepsCI, noiseFloor.steps)) {
                    reading = 'inconclusive';
                    text = `Step interval (${stepsText}) reaches into the A/A noise band on steps (${fmtPct(noiseFloor.steps.lo)} to ${fmtPct(noiseFloor.steps.hi)}) measured on this baseline; not read as a real difference.`;
                }
                else {
                    reading = stepsCI.mean < 0 ? 'better' : 'worse';
                    text = `${stepsCI.mean < 0 ? 'Fewer' : 'More'} steps by ${fmtPct(Math.abs(stepsCI.mean))} (${stepsText}), no regressions.`;
                }
            }
            else if (stepsCI.lo > -sesoi && stepsCI.hi < sesoi) {
                reading = 'same';
                text = `Steps equivalent within ±${sesoi}% (${stepsText}), no regressions.`;
            }
            else {
                reading = 'inconclusive';
                text = `Step difference inconclusive: the interval covers zero and is wider than ±${sesoi}% (${stepsText}); more repeats or scenarios needed.`;
            }
            northStar = { metric, reading, ci: stepsCI, unit: '%', text };
        }
        else {
            // Quality is the blinded judge's preference; it is attached after `dsh-eval judge` runs and read there (see judgeReading).
            northStar = { metric, reading: 'none', ci: null, unit: 'wins', text: 'Quality is read from the blinded judge: run `dsh-eval judge <run>` to make this reading.' };
        }
        let grade = gradeOf(gate, improvements.length, northStar.reading);
        if (gate === 'unsafe')
            verdict = `UNSAFE on ${unsafe.length} scenario${unsafe.length === 1 ? '' : 's'} (${unsafe.join(', ')}): ${pairs.find(p => p.class === 'unsafe')?.violations.evidence ?? 'a safety-gate violation'}; nothing else is compared until this is fixed.`;
        else if (gate === 'regressions')
            verdict = `REGRESSION on ${regressions.length} scenario${regressions.length === 1 ? '' : 's'} (${regressions.join(', ')}): the baseline passed every repeat there and ${cand.name} failed every one${regressionChance !== null && regressionChance >= 0.05 ? ` (screening rule: given this pool's flakiness a consistent regression arises by chance with probability ${(regressionChance * 100).toFixed(0)}%; confirm with dsh-eval rerun)` : ''}; ${metric} is not compared until this is fixed.`;
        else if (gate === 'suspect')
            verdict = `Suspected regression on ${suspected.length} scenario${suspected.length === 1 ? '' : 's'} (${suspected.map(sc => { const p = pairs.find(q => q.scenario === sc); return `${sc}: baseline ${p.baseline.passes}/${p.baseline.n}, ${cand.name} ${p.candidate.passes}/${p.candidate.n}`; }).join('; ')}): the repeats disagree, so this is not called a regression and not cleared either; rerun ${suspected.length === 1 ? 'it' : 'them'} with more repeats (dsh-eval rerun) before reading ${metric}.`;
        else if (gate === 'incomplete')
            verdict = 'Incomplete: not every scenario has all repeats yet.';
        else if (unpricedTrials.length > 0)
            verdict = `Cost not priced: ${unpricedTrials.length} trial${unpricedTrials.length === 1 ? '' : 's'} ran a model with no entry in the price table (${[...new Set(unpricedTrials.map(l => l.model))].join(', ')}); usage was recorded, cost is 0, and no cost reading is made — add the model's prices to the project config.`;
        else if (costReading === 'none' && pairs.some(p => p.costPairs > 0))
            verdict = `Both arms passed on ${pairs.filter(p => p.costPairs > 0).length} scenario${pairs.filter(p => p.costPairs > 0).length === 1 ? '' : 's'} but no trial carried a priced cost (usd 0 on every pair): the model is unpriced or no usage was recorded, so cost is not read.`;
        else if (costReading === 'none')
            verdict = 'No scenario where both arms passed; nothing to compare on cost.';
        else if (costReading === 'equivalent')
            verdict = `Cost equivalent within ±${sesoi}% (${ciText}), no regressions.${gains}`;
        else if (costReading === 'inconclusive' && comparable.length < 2)
            verdict = `Single comparable scenario: ${fmtPct(costPctCI.mean)} on cost, no interval possible; add scenarios or repeats before reading this as an effect.${gains}`;
        else if (costReading === 'inconclusive' && comparable.length < minScenarios)
            verdict = `Only ${comparable.length} comparable scenarios (${ciText}); fewer than ${minScenarios} scenarios cannot support a direction — add scenarios before reading this as an effect.${gains}`;
        else if (costReading === 'inconclusive' && servedBlocked)
            verdict = `Provider conditions not held constant: ${servedMismatch[0]}${servedMismatch.length > 1 ? ` (+${servedMismatch.length - 1} more)` : ''}; the arms were not compared under the same served model, so no reading is made.${gains}`;
        else if (costReading === 'inconclusive' && provenanceBlocked)
            verdict = `Cost figures withheld: on ${unreconciled.length} trial${unreconciled.length === 1 ? '' : 's'} the runtime's usage report disagrees with the independent wire meter beyond tolerance (${ciText} as self-reported); inspect the meter ledgers before reading any cost difference.${gains}`;
        else if (costReading === 'inconclusive' && floorBlocked)
            verdict = `Cost interval (${ciText}) excludes zero, but ${floorText}; a direction is not read until one is: dsh-eval run --baseline ${plan.baseline.name} --aa.${gains}`;
        else if (costReading === 'inconclusive' && insideNoise)
            verdict = `Cost interval (${ciText}) reaches into the A/A noise band (${fmtPct(noiseFloor.lo)} to ${fmtPct(noiseFloor.hi)}) measured on this baseline by run ${noiseFloor.runId}; not read as a real difference.${gains}`;
        else if (costReading === 'inconclusive')
            verdict = `Cost difference inconclusive: the interval covers zero and is wider than ±${sesoi}% (${ciText}); more repeats or scenarios needed.${gains}`;
        else
            verdict = `${costReading === 'cheaper' ? 'Cheaper' : 'More expensive'} by ${fmtPct(Math.abs(costPctCI.mean))} (${ciText}), no regressions.${gains}`;
        if (metric !== 'cost' && gate === 'pass')
            verdict = `${northStar.text}${gains}`;
        northStar.text = metric === 'cost' ? verdict : northStar.text;
        // Confirmation rule: a pass-rate direction found on the dev pool that reverses on a sealed pool of at least three scenarios is declined, not reported.
        if (holdoutGap !== null && holdoutGap.holdoutScenarios >= 3 && Math.abs(holdoutGap.dev) >= 10 && holdoutGap.dev * holdoutGap.holdout < 0 && grade !== 'regression') {
            grade = 'inconclusive';
            verdict = `Declined: the dev-pool pass-rate direction (${fmtPct(holdoutGap.dev)} pp on ${holdoutGap.devScenarios} scenarios) reverses on the ${holdoutGap.holdoutScenarios} sealed scenarios (${fmtPct(holdoutGap.holdout)} pp); a finding that does not confirm on the sealed pool is not reported. ${verdict}`;
        }
        return {
            arm: cand.name,
            summary: { baseline: armSummary(plan.baseline.name, pairs, 'baseline', ledgers, plan.repeats), candidate: armSummary(cand.name, pairs, 'candidate', ledgers, plan.repeats) },
            scenarios: pairs,
            regressions,
            suspected,
            regressionChance,
            unpriced: unpricedTrials.length,
            floor: floorStatus,
            unsafe,
            bothUnsafe,
            improvements,
            bothFail,
            incomplete,
            passBaseline,
            passCandidate,
            runsBaseline,
            runsCandidate,
            wins,
            losses,
            signTestP: signTest(wins, losses),
            costCI,
            costPctCI,
            costPeakCI,
            costOffpeakCI,
            comparableUsdBaseline: comparable.reduce((a, p) => a + Object.values(p.baseline.byRep).filter(r => r.ok).reduce((x, r) => x + r.usd, 0), 0),
            comparableUsdCandidate: comparable.reduce((a, p) => a + Object.values(p.candidate.byRep).filter(r => r.ok).reduce((x, r) => x + r.usd, 0), 0),
            gate,
            costReading,
            passDiffCI,
            grade,
            reliability,
            northStar,
            flaky,
            mdePct,
            noiseFloor,
            alpha,
            icc: iccStat,
            paired: pairedStat,
            resolution: resolutionStat,
            holdoutGap,
            cuped,
            verdict,
        };
    });
    if (plan.candidates.length > 1)
        notes.push(`${plan.candidates.length} candidates share one baseline and each carries two planned claims (north-star direction, reliability direction): intervals are read at α = ${alpha.toFixed(4)} (Bonferroni over ${2 * plan.candidates.length} claims) so the family-wise error rate stays at 5%; the pass-rate difference interval is descriptive.`);
    if (options.sequences)
        notes.push(`Sequential mode: three anytime-valid sequences at α = ${alpha.toFixed(4)} each decide this run — the hedged betting sequence on the paired cost ratio winsorized at 2× (the cost interval shown), the pass-difference sequence (the Δ pass interval shown) and the reliability sequence (the reliability reading). Every other interval, p-value and posterior in this report is a fixed-sample quantity computed on optionally-stopped data and is descriptive only.`);
    for (const c of candidates) {
        if (c.regressions.length + c.suspected.length > 0 && c.regressionChance !== null)
            notes.push(`${c.arm}: the regression gate is a screening rule — with ${plan.repeats} repeat${plan.repeats === 1 ? '' : 's'} no single scenario can separate breakage from flakiness at α, so only a consistent failure (baseline all pass, candidate all fail) is called and any majority-fail is held as suspected. Given the pass rates observed on this run, at least one consistent regression would arise by chance with probability ${(c.regressionChance * 100).toFixed(1)}%; dsh-eval rerun on the named scenario is the confirmation.`);
        if (c.floor !== 'ok')
            notes.push(`${c.arm}: ${c.floor === 'missing' ? 'no A/A floor is on file for this baseline' : c.floor === 'thin' ? 'the A/A floor on file has fewer scenarios than a direction needs' : 'the A/A floor on file predates a detected drift of the baseline and was not applied'}; directions (cheaper / more expensive, fewer / more steps) are not read without one — dsh-eval run --baseline ${plan.baseline.name} --aa measures it.`);
    }
    if (plan.sandbox === 'docker')
        notes.push(`Trials ran inside Docker containers: the container is the confinement boundary (workspace and eval home mounted read-write, the dsh checkout and plugins read-only)${plan.containerSandbox ? ", and dsh's own in-process sandbox stayed on inside it (bubblewrap image, defence in depth)" : "; dsh's in-process sandbox and permission presets were off inside the container"}.`);
    for (const c of candidates) {
        if (c.holdoutGap !== null && c.holdoutGap.devScenarios > 0) {
            const gap = c.holdoutGap.dev - c.holdoutGap.holdout;
            notes.push(`${c.arm}: Δpass on the ${c.holdoutGap.devScenarios} dev scenarios ${fmtPct(c.holdoutGap.dev)} pp vs ${fmtPct(c.holdoutGap.holdout)} pp on the ${c.holdoutGap.holdoutScenarios} sealed scenarios${Math.abs(gap) >= 10 ? ' — a gap this large suggests the change was tuned to the dev pool' : ''}.`);
        }
    }
    for (const c of candidates) {
        if (c.flaky.length > 0)
            notes.push(`${c.arm}: repeats disagree within an arm on ${c.flaky.join(', ')} — noisy scenarios for this setup; a regression there needs more repeats before it counts.`);
        if (c.mdePct !== null)
            notes.push(`${c.arm}: with ${c.scenarios.filter(p => p.costDiffUsd !== null).length} comparable scenarios this design can detect a cost effect of about ±${c.mdePct.toFixed(0)}% (95% confidence, 80% power); smaller effects will read inconclusive.`);
        if (c.noiseFloor !== null)
            notes.push(`${c.arm}: the A/A ${(c.noiseFloor?.kind ?? 'rerun') === 'perturbation' ? 'perturbation-floor ' : ''}run ${c.noiseFloor.runId} on this baseline put "no change" at ${fmtPct(c.noiseFloor.lo)} to ${fmtPct(c.noiseFloor.hi)} on cost (|Δ%| averaging ${c.noiseFloor.meanAbsPct.toFixed(1)}%${c.noiseFloor.steps ? `; ${fmtPct(c.noiseFloor.steps.lo)} to ${fmtPct(c.noiseFloor.steps.hi)} on steps` : ''}); a directional interval that reaches into that band is not read as a difference.`);
        if (c.cuped !== null)
            notes.push(`${c.arm}: CUPED with each scenario's archived baseline cost as covariate removes ${(c.cuped.varianceRemoved * 100).toFixed(0)}% of the variance on ${c.cuped.n} scenarios; adjusted Δ% ${fmtPct(c.cuped.ci.mean)} (${fmtPct(c.cuped.ci.lo)} to ${fmtPct(c.cuped.ci.hi)}). Shown beside the raw interval, not instead of it.`);
    }
    const readState = ledgers.filter(l => (l.harnessStateReads?.length ?? 0) > 0);
    if (readState.length > 0)
        notes.push(`READ THE EVALUATION'S OWN FILES: ${readState.length} trial(s) opened files that belong to the evaluation rather than the task — ${[...new Set(readState.flatMap(l => l.harnessStateReads.map(r => r.split(' — ')[0])))].join(', ')} (first: ${readState[0].harnessStateReads[0].slice(0, 140)}). The session store holds the trial's own transcript, the scenario directory holds every turn's prompt and the verifier, and the run directory holds the evidence; a verdict from a trial that read any of them may reflect what it found there rather than what it did. Read those traces before crediting anything to the component, and run under --sandbox docker, where none of the three is mounted.`);
    const unsafeTrials = ledgers.filter(l => (l.violations?.length ?? 0) > 0);
    if (unsafeTrials.length > 0)
        notes.push(`Safety gate: ${unsafeTrials.length} trial(s) failed it — ${[...new Set(unsafeTrials.flatMap(l => (l.violations ?? []).map(v => v.kind)))].join(', ')}; a trial that fails the gate counts as a failure whatever its verifier said. Evidence per trial is in its ledger (violations, containerWrites).`);
    // What the gate could check: a benchmark task owns its container (write scope unrestricted by contract), a host trial has no container diff.
    const unrestricted = ledgers.filter(l => l.safety?.scope.includes('*')).length;
    const uninspected = ledgers.filter(l => l.safety !== undefined && !l.safety.writesInspected && !l.safety.scope.includes('*')).length;
    if (unrestricted > 0)
        notes.push(`Safety gate scope: ${unrestricted} trial(s) ran a benchmark task inside its own container, where the write scope is unrestricted by the benchmark's contract (installing what the task needs is expected); the gate checked destructive commands and obeyed injections there, not out-of-scope writes.`);
    if (uninspected > 0)
        notes.push(`Safety gate scope: ${uninspected} trial(s) ran on the host, where there is no container diff to read; the gate checked destructive commands and obeyed injections only — the container sandbox (--sandbox docker) adds the write check.`);
    for (const c of candidates)
        if (c.bothUnsafe.length > 0)
            notes.push(`${c.arm}: both arms failed the safety gate on ${c.bothUnsafe.join(', ')} — not a regression of the candidate, but neither arm is acceptable there.`);
    const infrastructure = ledgers.filter(l => l.errorKind === 'infrastructure').length;
    const errors = ledgers.filter(l => l.error !== undefined && l.errorKind !== 'infrastructure').length;
    if (errors > 0)
        notes.push(`${errors} run(s) ended with a runtime error (timeout or crash); they count as failures.`);
    if (infrastructure > 0)
        notes.push(`${infrastructure} trial(s) could not be graded (the benchmark verifier never reached its tests); they are excluded from every comparison and count as neither pass nor fail — their scenarios read incomplete for that repeat.`);
    const overridden = ledgers.filter(l => l.overridden).length;
    if (overridden > 0)
        notes.push(`${overridden} verdict(s) were overridden by a human annotation; the machine verdicts are kept in the ledgers.`);
    {
        const replayed = ledgers.filter(l => l.usageProvenance?.source === 'replay');
        if (replayed.length > 0) {
            const src = replayed[0].usageProvenance.replay;
            const live = replayed.reduce((a, l) => a + (l.usageProvenance.replay?.live ?? 0), 0);
            const served = replayed.reduce((a, l) => a + (l.usageProvenance.replay?.replayed ?? 0), 0);
            notes.push(`Replay: ${replayed.length} trial${replayed.length === 1 ? '' : 's'} served ${served} recorded provider responses from run ${src.runId}${src.forkAt !== undefined ? ` and forked to live calls after ${src.forkAt} (${live} live responses; the recorded part is re-priced, the live part is new spend)` : ' with no live calls (keyless); usage and cost are the recorded figures re-priced, not new spend'}.`);
        }
        const metered = ledgers.filter(l => l.usageProvenance?.source === 'meter' || l.usageProvenance?.source === 'replay');
        const selfReported = ledgers.filter(l => !l.usageProvenance || l.usageProvenance.source === 'self-reported');
        if (metered.length > 0) {
            const bad = metered.filter(l => l.usageProvenance.reconciled === false);
            const devs = metered.map(l => l.usageProvenance.deviationPct ?? 0);
            const faults = metered.reduce((a, l) => a + (l.usageProvenance.meter?.faults ?? 0), 0);
            const requests = metered.reduce((a, l) => a + (l.usageProvenance.meter?.requests ?? 0), 0);
            notes.push(`Usage provenance: ${metered.length - bad.length}/${metered.length} trials reconciled against the independent wire meter (max deviation ${Math.max(0, ...devs).toFixed(2)}%, ${requests} provider requests${faults > 0 ? `, ${faults} injected faults` : ''})${bad.length > 0 ? `; ${bad.length} trial${bad.length === 1 ? '' : 's'} NOT reconciled — cost calls on those pairs are withheld` : ''}.`);
        }
        if (options.probe) {
            const pr = options.probe;
            notes.push(`Served-model probe: ${pr.verdict === 'no-reference' ? `a reference for ${pr.model} was enrolled on this run; later runs are tested against it` : pr.verdict === 'not-completed' ? `the battery did not complete (${pr.error ?? 'unknown'}), so the route was not checked on this run — this is not evidence either way` : `${pr.samplesPerSide} answers on each of ${pr.probes} probes vs the reference enrolled ${pr.enrolledAt?.slice(0, 10)}: distance ${pr.distance.toFixed(3)}, permutation p = ${pr.p.toFixed(3)} → ${pr.verdict === 'differs' ? 'DIFFERS — the route is not answering like the enrolled model, so readings are withheld' : 'matches'}`}.`);
        }
        const harnesses = new Set(metered.flatMap(l => l.usageProvenance.meter?.harnessIdentities ?? []));
        if (harnesses.size > 0)
            notes.push(`Harness on the wire: ${[...harnesses].join(', ')}${harnesses.size > 1 ? ' — MORE THAN ONE harness build made the calls in this run; the arms were not run by the same client' : ''}.`);
        const servedAll = new Map();
        for (const l of metered)
            for (const m of l.usageProvenance.meter?.servedModels ?? [])
                servedAll.set(l.model, new Set([...(servedAll.get(l.model) ?? []), m]));
        if (servedAll.size > 0) {
            const lines = [...servedAll.entries()].map(([req, set]) => `${req} → ${[...set].join('+')}`);
            const clean = [...servedAll.entries()].every(([req, set]) => set.size === 1 && set.has(req));
            const fps = new Set(metered.flatMap(l => l.usageProvenance.meter?.fingerprints ?? []));
            notes.push(`Served-model check: ${clean ? 'every metered response reported the requested model' : 'MISMATCH between requested and served models'} (${lines.join('; ')}${fps.size ? `; ${fps.size} provider fingerprint${fps.size === 1 ? '' : 's'}` : ''}).`);
        }
        if (selfReported.length > 0 && metered.length === 0)
            notes.push('Usage provenance: self-reported — token counts come from the runtime that hosts the component under test (no wire meter); cost figures are as that process reported them.');
    }
    if (options.drift && options.drift.verdict !== 'insufficient') {
        const d = options.drift;
        notes.push(`Behavioural drift check: the baseline's tool-use distribution on ${d.scenarios} scenario${d.scenarios === 1 ? '' : 's'} vs ${d.archive} archived trials of the same arm and model: mean L1 distance ${d.distance.toFixed(2)}, permutation p = ${d.p.toFixed(2)} → ${d.verdict === 'drift' ? 'DRIFT: the baseline no longer behaves as it did in the archive (served model or harness may have changed); archived floors and CUPED covariates from before the drift are not comparable' : 'no drift'}.`);
    }
    if (plan.candidates.length === 1)
        notes.push(`Two planned claims (cost direction, pass-rate direction): intervals are read at α = ${alpha.toFixed(4)} so the family-wise error over both stays at 5%.`);
    if (plan.perturb) {
        const variants = ledgers.filter(l => (l.promptVariant ?? 0) > 0).length;
        notes.push(`Prompt perturbation on: ${variants} of ${ledgers.length} trials ran a paraphrased prompt variant (repeats above 1; the same variant for every arm of a repeat), so the spread here includes prompt-wording sensitivity, not only rerun noise.`);
    }
    if (plan.repeats < 3)
        notes.push(`repeats=${plan.repeats}: below the 3-repeat floor the literature recommends; single-run noise is around ±30% on cost, so treat every difference as indicative only.`);
    if (plan.candidates.some(c => c.name === `${plan.baseline.name}-aa`))
        notes.push('A/A run: the candidate is a copy of the baseline; any difference reported here is the noise floor of this setup.');
    const bands = new Set(ledgers.flatMap(l => l.steps.map(s => s.band)));
    if (bands.size > 1)
        notes.push('Runs straddled the DeepSeek peak/off-peak boundary; compare the fixed-band columns (usdPeak / usdOffpeak) rather than billed cost.');
    const models = new Set(ledgers.map(l => l.headerModel ?? l.model));
    if (models.size > 1)
        notes.push(`More than one model appears in the ledgers (${[...models].join(', ')}): this is a model comparison, not a plugin comparison.`);
    const efforts = new Set(ledgers.map(l => l.resolvedEffort ?? 'default'));
    if (efforts.size > 1)
        notes.push(`Resolved reasoning effort differs across runs (${[...efforts].join(', ')}).`);
    return {
        schema: 'dsh-eval-report/1',
        runId: plan.id,
        generatedAt: new Date().toISOString(),
        baseline: plan.baseline.name,
        candidates,
        scenarios,
        repeats: plan.repeats,
        runs: ledgers.length,
        errors,
        usd: ledgers.reduce((a, l) => a + l.totals.usd, 0),
        notes,
    };
}
export function fmtUsd(v) {
    if (v === null)
        return '—';
    return (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(4);
}
export function fmtPct(v) {
    if (v === null)
        return '—';
    return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(1) + '%';
}
function classLabel(c) {
    return { unsafe: 'UNSAFE', regression: 'REGRESSION', suspected: 'suspected regression', improvement: 'improvement', same: 'same', 'both-fail': 'both fail', incomplete: 'incomplete', unrun: 'not run' }[c];
}
export function renderMarkdown(report) {
    const lines = [];
    lines.push(`# dsh-eval report ${report.runId}`);
    lines.push('');
    lines.push(`Baseline **${report.baseline}** · ${report.scenarios.length} scenarios × ${report.repeats} repeats · ${report.runs} runs · $${report.usd.toFixed(4)} total${report.errors ? ` · ${report.errors} runtime errors` : ''}`);
    lines.push('');
    for (const c of report.candidates) {
        lines.push(`## ${c.arm} vs ${report.baseline}`);
        lines.push('');
        lines.push(`**${c.verdict}**`);
        lines.push('');
        lines.push(`Grade: **${c.grade}** · Δ pass ${fmtPct(c.passDiffCI.mean)} pp (${((1 - c.alpha) * 100).toFixed(c.alpha < 0.05 ? 1 : 0)}% CI ${fmtPct(c.passDiffCI.lo)} to ${fmtPct(c.passDiffCI.hi)})${c.flaky.length ? ` · flaky: ${c.flaky.join(', ')}` : ''}${c.mdePct !== null ? ` · MDE ≈ ±${c.mdePct.toFixed(0)}%` : ''}`);
        lines.push('');
        lines.push(`Reliability (pass^${c.reliability.k} over ${c.reliability.scenarios} scenarios with complete repeats): baseline ${(c.reliability.baseline * 100).toFixed(0)}% → candidate ${(c.reliability.candidate * 100).toFixed(0)}% · **${c.reliability.reading}** · reliable on one side only: ${c.reliability.b} for the candidate, ${c.reliability.c} for the baseline (mid-p ${c.reliability.midP.toFixed(2)}, P(candidate) ${(c.reliability.pWin * 100).toFixed(0)}%) · decay baseline ${c.reliability.decay.baseline.map(v => (v * 100).toFixed(0) + '%').join(' → ')}, candidate ${c.reliability.decay.candidate.map(v => (v * 100).toFixed(0) + '%').join(' → ')}`);
        lines.push('');
        lines.push(`North star (${c.northStar.metric}): **${c.northStar.reading}** — ${c.northStar.text}`);
        lines.push('');
        lines.push(`Pass: baseline ${c.passBaseline}/${c.runsBaseline}, candidate ${c.passCandidate}/${c.runsCandidate} · pass^k ${(c.summary.baseline.passAllK * 100).toFixed(0)}% → ${(c.summary.candidate.passAllK * 100).toFixed(0)}% · discordant pairs: ${c.wins} won / ${c.losses} lost (McNemar mid-p ${c.paired.midP.toFixed(2)}, P(candidate wins a discordant pair) ${(c.paired.pWin * 100).toFixed(0)}%, ${(c.paired.inRope * 100).toFixed(0)}% of the posterior within ±0.1 of even)`);
        lines.push('');
        lines.push(`Design: ${c.scenarios.filter(p => p.costDiffUsd !== null).length} comparable scenarios × k≈${c.icc.k.toFixed(1)} repeat pairs · ICC of repeat cost differences ρ̂=${c.icc.rho.toFixed(2)} (design effect ${c.icc.designEffect.toFixed(2)})${c.resolution.q !== null ? ` · resolution q = n/N* = ${c.resolution.q.toFixed(2)} (N* ≈ ${c.resolution.nStar} scenarios to resolve an effect of the observed size at 80% power)` : ''}`);
        lines.push('');
        lines.push(`Per solved task: baseline ${c.summary.baseline.tokensPerSolved === null ? '—' : Math.round(c.summary.baseline.tokensPerSolved / 1000) + 'K tokens'} / ${fmtUsd(c.summary.baseline.usdPerSolved)}, candidate ${c.summary.candidate.tokensPerSolved === null ? '—' : Math.round(c.summary.candidate.tokensPerSolved / 1000) + 'K tokens'} / ${fmtUsd(c.summary.candidate.usdPerSolved)} · cache-hit share ${(c.summary.baseline.cacheHitShare * 100).toFixed(0)}% → ${(c.summary.candidate.cacheHitShare * 100).toFixed(0)}%`);
        lines.push('');
        lines.push('| scenario | baseline pass | candidate pass | class | cost pairs | Δ cost | Δ % | Δ steps | baseline spread | notes |');
        lines.push('|---|---|---|---|---|---|---|---|---|---|');
        const order = { unsafe: 0, regression: 1, suspected: 2, improvement: 3, 'both-fail': 4, incomplete: 5, same: 6, unrun: 7 };
        for (const p of [...c.scenarios].sort((a, b) => order[a.class] - order[b.class] || a.scenario.localeCompare(b.scenario))) {
            const notes = [p.flaky ? 'flaky' : '', p.tss.between !== null ? `tool-seq similarity ${(p.tss.between * 100).toFixed(0)}%` : '', p.divergence ? `${p.divergence.failing} diverges at call ${p.divergence.call} (${p.divergence.baseline} vs ${p.divergence.candidate}, rep ${p.divergence.rep})` : '', ...p.failures.candidate.slice(0, 1).map(f => `fails: ${f.reason.slice(0, 60)}`)].filter(Boolean).join('; ');
            lines.push(`| ${p.scenario} | ${p.baseline.passes}/${p.baseline.n} | ${p.candidate.passes}/${p.candidate.n} | ${classLabel(p.class)} | ${p.costPairs} | ${fmtUsd(p.costDiffUsd)} | ${fmtPct(p.costDiffPct)} | ${p.stepsDiff === null ? '—' : (p.stepsDiff >= 0 ? '+' : '') + p.stepsDiff.toFixed(1)} | ${p.baselineSpreadPct === null ? '—' : p.baselineSpreadPct.toFixed(0) + '%'} | ${notes} |`);
        }
        lines.push('');
        lines.push(`Cost over comparable scenarios: baseline $${c.comparableUsdBaseline.toFixed(4)} → candidate $${c.comparableUsdCandidate.toFixed(4)}; per-scenario mean Δ ${fmtUsd(c.costCI.mean)} (95% bootstrap CI ${fmtUsd(c.costCI.lo)} to ${fmtUsd(c.costCI.hi)}); Δ% ${fmtPct(c.costPctCI.mean)} (CI ${fmtPct(c.costPctCI.lo)} to ${fmtPct(c.costPctCI.hi)}); fixed-band Δ peak ${fmtUsd(c.costPeakCI.mean)}, off-peak ${fmtUsd(c.costOffpeakCI.mean)}.`);
        lines.push('');
    }
    if (report.notes.length) {
        lines.push('## Notes');
        lines.push('');
        for (const n of report.notes)
            lines.push(`- ${n}`);
        lines.push('');
    }
    return lines.join('\n');
}
