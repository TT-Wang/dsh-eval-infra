/** The call that would lift a blocker, when there is one. */
function remedyFor(code, baseline, runId) {
    if (code.startsWith('floor.'))
        return code === 'floor.no_step_band' ? { tool: 'run.start', args: { baseline, aa: true, repeats: 3 } } : { tool: 'run.start', args: { baseline, aa: true, repeats: 3 } };
    if (code === 'scenarios.below_minimum' || code === 'reading.interval_covers_zero' || code === 'reading.inside_noise_band')
        return { tool: 'run.start', args: { baseline, repeats: 5 } };
    if (code === 'gate.suspect')
        return { tool: 'run.rerun', args: { runId, repeats: 5 } };
    if (code === 'gate.incomplete')
        return { tool: 'run.start', args: { resume: runId } };
    if (code === 'judge.not_run')
        return { tool: 'judge.run', args: { runId } };
    if (code === 'cost.unpriced')
        return { tool: 'config.prices' };
    return undefined;
}
function candidateClaims(report, c) {
    const licensed = [];
    const withheld = [];
    const comparable = c.scenarios.filter(p => p.costDiffPct !== null).length;
    // The gate speaks first, whichever way it went: "nothing broke" is a claim, and so is "this broke".
    if (c.gate === 'unsafe')
        licensed.push({ code: 'gate.unsafe', scenarios: c.unsafe, evidence: c.scenarios.find(p => p.class === 'unsafe')?.violations.evidence ?? null });
    else if (c.gate === 'regressions')
        licensed.push({ code: 'gate.regression', scenarios: c.regressions, ...(c.regressionChance !== null ? { chance: c.regressionChance } : {}) });
    else if (c.gate === 'suspect')
        licensed.push({ code: 'gate.suspected', scenarios: c.suspected, ...(c.regressionChance !== null ? { chance: c.regressionChance } : {}) });
    else if (c.gate === 'incomplete')
        licensed.push({ code: 'gate.incomplete', scenarios: c.incomplete });
    else
        licensed.push({ code: 'gate.nothing_broke', scenarios: c.scenarios.filter(p => p.class !== 'unrun').length });
    if (c.bothUnsafe.length > 0)
        licensed.push({ code: 'gate.both_unsafe', scenarios: c.bothUnsafe });
    if (c.improvements.length > 0)
        licensed.push({ code: 'gate.improvement', scenarios: c.improvements });
    // The contract's gate order is "gates first: any safety-gate violation, then any regression, blocks every
    // reading". So a closed gate withholds both readings below, whatever they computed to — the numbers stay
    // on the record, but nothing about them may be said until the gate is answered.
    const gateBlocker = c.gate === 'pass' ? undefined
        : { code: `gate.${c.gate}`, scenarios: c.gate === 'unsafe' ? c.unsafe : c.gate === 'regressions' ? c.regressions : c.gate === 'suspect' ? c.suspected : c.incomplete };
    const gateRemedy = gateBlocker === undefined ? undefined : remedyFor(gateBlocker.code, report.baseline, report.runId);
    // Reliability: the headline, read before whatever the run was registered for.
    const rel = c.reliability;
    if (gateBlocker !== undefined) {
        withheld.push({
            claim: 'reliability.direction',
            reason: gateBlocker,
            observed: { reading: rel.reading, k: rel.k, scenarios: rel.scenarios, baseline: rel.baseline, candidate: rel.candidate },
            ...(gateRemedy ? { next: gateRemedy } : {}),
        });
    }
    else if (rel.reading === 'more-reliable' || rel.reading === 'less-reliable' || rel.reading === 'same') {
        licensed.push({ code: `reliability.${rel.reading.replace('-', '_')}`, k: rel.k, scenarios: rel.scenarios, baseline: rel.baseline, candidate: rel.candidate, midP: rel.midP });
    }
    else {
        withheld.push({
            claim: 'reliability.direction',
            reason: rel.scenarios < 5 ? { code: 'scenarios.below_minimum', have: rel.scenarios, need: 5 } : { code: 'reliability.undecided', b: rel.b, c: rel.c, midP: rel.midP },
            observed: { k: rel.k, scenarios: rel.scenarios, baseline: rel.baseline, candidate: rel.candidate },
            next: { tool: 'run.start', args: { baseline: report.baseline, repeats: Math.max(5, rel.k + 2) } },
        });
    }
    // The north star the run was registered for.
    const ns = c.northStar;
    const observed = { metric: ns.metric, ...(ns.ci ? { mean: ns.ci.mean, interval: [ns.ci.lo, ns.ci.hi], unit: ns.unit } : {}), comparableScenarios: comparable };
    if (gateBlocker !== undefined) {
        withheld.push({
            claim: 'northStar.direction',
            reason: gateBlocker,
            observed: { ...observed, reading: ns.reading },
            ...(gateRemedy ? { next: gateRemedy } : {}),
        });
    }
    else if (ns.reading === 'better' || ns.reading === 'worse' || ns.reading === 'same') {
        licensed.push({ code: `northStar.${ns.reading}`, ...observed });
    }
    else {
        const [first, ...rest] = c.blockers.length > 0 ? c.blockers : [{ code: 'reading.undecided' }];
        withheld.push({
            claim: 'northStar.direction',
            reason: first,
            ...(rest.length > 0 ? { also: rest } : {}),
            observed,
            ...(() => { const next = remedyFor(first.code, report.baseline, report.runId); return next ? { next } : {}; })(),
        });
    }
    return {
        arm: c.arm,
        gate: c.gate,
        grade: c.grade,
        licensed,
        withheld,
        design: {
            comparableScenarios: comparable,
            repeats: report.repeats,
            mdePct: c.mdePct,
            resolution: c.resolution,
            alpha: c.alpha,
            floor: c.floor,
        },
    };
}
export function claimsOf(report) {
    return {
        schema: 'dsh-eval-claims/1',
        runId: report.runId,
        baseline: report.baseline,
        trials: report.runs,
        usd: report.usd,
        candidates: report.candidates.map(c => candidateClaims(report, c)),
    };
}
