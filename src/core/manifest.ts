/**
 * Tamper-evident run seal. After a run (and after every regrade) the evidence
 * files under the run directory are hashed into `manifest.json`; `verifyRun`
 * recomputes the hashes and re-derives the report from the sealed ledgers so
 * a reader can check that the report they were given follows from the
 * evidence they were given. Everything the report is derived from — ledgers,
 * events, traces, meter ledgers, annotations, judge, rerun and regrade files,
 * the archive context the readings used — is evidence and is sealed; whatever
 * adds such a file re-seals and re-issues the receipt. Only the report itself,
 * the manifest and the receipt are derived.
 *
 * The receipt's signature is checked against a key the verifier trusts (the
 * project's own key, or one passed in), never only against the key embedded in
 * the receipt: a receipt signed by an unknown key is self-consistent, not
 * verified, and reads INCONCLUSIVE until that key is trusted out of band.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { writeJsonAtomic, type RunPaths } from './store.js'

/** The analysis contract, fixed before the readings are made and signed with the receipt. */
export interface AnalysisContract {
  estimand: string
  pairing: string
  estimator: string
  alpha: number
  sesoiPct: number
  minScenarios: number
  bootstrapDraws: number
  seed: number
  gateOrder: string
  costRule: string
  /** The reading the run was registered for (cost / efficiency / quality); absent on receipts issued before this field existed. */
  northStar?: string
  /** Repeats per scenario per arm: the k of pass^k. */
  k?: number
  reliabilityRule?: string
}

export interface RunManifest {
  schema: 'dsh-eval-manifest/1'
  runId: string
  sealedAt: string
  /** Relative path → sha256 of every evidence file. */
  files: Record<string, string>
  count: number
  bytes: number
  /** sha256 over the sorted (path, sha) list: one id for the whole evidence set. */
  evidenceSha: string
  regrades: Array<{ at: string; changed: number; regradable: number; verifiers: Record<string, string> }>
  contract?: AnalysisContract
}

/** A signed, self-contained statement of what this run claims and what evidence backs it. */
export interface RunReceipt {
  schema: 'dsh-eval-receipt/1'
  runId: string
  issuedAt: string
  evidenceSha: string
  contract: AnalysisContract
  claims: Array<{ arm: string; gate: string; costReading: string; grade: string; verdict: string; reliability?: string; northStar?: string }>
  coverage: { trials: number; scenarios: number; repeats: number; arms: number; reconciled: number; metered: number; unrun: number; errors: number }
  environment: { dshVersion?: string; dshRevision?: string; evalInfraVersion?: string; sandbox?: string; composedTreeSha?: Record<string, string> }
  /** sha256 of the canonical JSON of the whole derived report (minus its timestamp): the verifier re-derives and compares every field, not a summary. Absent on receipts issued before it existed. */
  reportSha?: string
  publicKey: string
  /** Ed25519 signature over the canonical JSON of everything above except this field. */
  signature: string
}

export type ReceiptStatus = 'PASS' | 'INVALID' | 'INCONCLUSIVE'

export interface VerifyResult {
  ok: boolean
  /** PASS: signed claims recomputed from intact evidence. INVALID: evidence or signature broken. INCONCLUSIVE: nothing was falsified but the run carries no receipt, or its evidence is incomplete. */
  status?: ReceiptStatus
  statusReason?: string
  sealedAt: string | null
  evidenceSha: string | null
  missing: string[]
  changed: string[]
  /** Evidence files present now that were not sealed (added after the seal). */
  added: string[]
  /** Whether report.json's readings equal a fresh derivation from the sealed ledgers (null when no report). */
  reportReproduces: boolean | null
  reportDiff: string[]
  /** Evidence sha recomputed from the bytes on disk (the manifest's file list, hashed again); what a receipt is checked against. */
  evidenceShaOnDisk?: string
  /** Whether the manifest's own evidence sha follows from its file list (a rewritten manifest that forgot to recompute it fails here). */
  manifestConsistent?: boolean
}

/** Files derived from the evidence: never sealed, always recomputable. Everything else under the run directory is evidence. */
const DERIVED = new Set(['manifest.json', 'report.json', 'report.md', 'receipt.json', 'report.html', 'VERIFY.md'])

export function isDerived(rel: string): boolean {
  return DERIVED.has(rel)
}

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, root, out)
    else out.push(relative(root, p))
  }
}

export function evidenceFiles(runDir: string): string[] {
  const out: string[] = []
  walk(runDir, runDir, out)
  return out.filter(rel => !isDerived(rel) && !rel.startsWith('arms/_meter-')).sort()
}

export function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function evidenceShaOf(files: Record<string, string>): string {
  const h = createHash('sha256')
  for (const rel of Object.keys(files).sort()) h.update(rel + '\0' + files[rel] + '\n')
  return h.digest('hex')
}

export function sealRun(paths: RunPaths, runId: string, regrade?: RunManifest['regrades'][number], contract?: AnalysisContract): RunManifest {
  const previous = readManifest(paths)
  const files: Record<string, string> = {}
  let bytes = 0
  for (const rel of evidenceFiles(paths.dir)) {
    files[rel] = fileSha(join(paths.dir, rel))
    bytes += statSync(join(paths.dir, rel)).size
  }
  const manifest: RunManifest = {
    schema: 'dsh-eval-manifest/1',
    runId,
    sealedAt: new Date().toISOString(),
    files,
    count: Object.keys(files).length,
    bytes,
    evidenceSha: evidenceShaOf(files),
    regrades: [...(previous?.regrades ?? []), ...(regrade ? [regrade] : [])],
    ...(contract ?? previous?.contract ? { contract: contract ?? previous!.contract! } : {}),
  }
  writeJsonAtomic(join(paths.dir, 'manifest.json'), manifest)
  return manifest
}

export function readManifest(paths: RunPaths): RunManifest | null {
  const file = join(paths.dir, 'manifest.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) as RunManifest } catch { return null }
}

/** Compare sealed hashes with the files on disk; `derive` re-derives the report and returns its readings for comparison. */
export function verifyRun(paths: RunPaths, derive?: () => { fresh: Record<string, unknown>; stored: Record<string, unknown> | null }): VerifyResult {
  const manifest = readManifest(paths)
  if (!manifest) return { ok: false, sealedAt: null, evidenceSha: null, missing: [], changed: [], added: [], reportReproduces: null, reportDiff: ['no manifest: this run was never sealed'] }
  const missing: string[] = []
  const changed: string[] = []
  for (const [rel, sha] of Object.entries(manifest.files)) {
    const p = join(paths.dir, rel)
    if (!existsSync(p)) { missing.push(rel); continue }
    if (fileSha(p) !== sha) changed.push(rel)
  }
  const now = new Set(evidenceFiles(paths.dir))
  const added = [...now].filter(rel => !(rel in manifest.files)).sort()
  // The receipt is checked against what is on disk, hashed again here — not against the manifest's own claims about itself.
  const onDisk: Record<string, string> = {}
  for (const rel of Object.keys(manifest.files)) { const p = join(paths.dir, rel); if (existsSync(p)) onDisk[rel] = fileSha(p) }
  const evidenceShaOnDisk = evidenceShaOf(onDisk)
  const manifestConsistent = evidenceShaOf(manifest.files) === manifest.evidenceSha
  let reportReproduces: boolean | null = null
  const reportDiff: string[] = []
  if (derive) {
    const { fresh, stored } = derive()
    if (stored === null) reportReproduces = null
    else {
      for (const key of Object.keys(fresh)) {
        const a = JSON.stringify(fresh[key])
        const b = JSON.stringify(stored[key])
        if (a !== b) reportDiff.push(`${key}: stored ${b} vs derived ${a}`)
      }
      reportReproduces = reportDiff.length === 0
    }
  }
  return { ok: missing.length === 0 && changed.length === 0 && manifestConsistent && reportReproduces !== false, sealedAt: manifest.sealedAt, evidenceSha: manifest.evidenceSha, missing, changed, added, reportReproduces, reportDiff, evidenceShaOnDisk, manifestConsistent }
}


// ---------------------------------------------------------------------------
// Signed receipts (ClaimReceipt, arXiv 2609.01992: a manifest with an analysis
// contract, a public receipt of the claims, and a verifier that returns
// PASS / INVALID / INCONCLUSIVE — distinguishing a broken claim from a claim
// that was never contracted or is not backed by enough evidence).
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(k => [k, sortKeys((value as Record<string, unknown>)[k])]))
  return value
}

/** The project's signing key, generated once and kept private; the public half travels in every receipt. */
export function signingKey(evalDir: string): { privateKey: string; publicKey: string } {
  const file = join(evalDir, 'receipt-key.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as { privateKey: string; publicKey: string }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pair = {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
  writeFileSync(file, JSON.stringify(pair, null, 2), { mode: 0o600 })
  return pair
}

export function signReceipt(receipt: Omit<RunReceipt, 'signature'>, privateKeyPem: string): RunReceipt {
  const signature = sign(null, Buffer.from(canonicalJson(receipt)), createPrivateKey(privateKeyPem)).toString('base64')
  return { ...receipt, signature }
}

/**
 * Does the signature verify under `publicKeyPem`? Without a key this checks the receipt against the key it carries,
 * which proves the receipt is self-consistent and nothing more; a verifier passes the key it trusts.
 */
export function receiptSignatureValid(receipt: RunReceipt, publicKeyPem: string = receipt.publicKey): boolean {
  const { signature, ...rest } = receipt
  try { return verifySignature(null, Buffer.from(canonicalJson(rest)), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64')) } catch { return false }
}

/** Short fingerprint of a public key (sha256 of its DER SPKI, first 16 hex chars): what an author publishes and a reader compares. */
export function keyFingerprint(publicKeyPem: string): string {
  try { return createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer).digest('hex').slice(0, 16) } catch { return 'invalid-key' }
}

/** Two PEM keys are the same key when their DER encodings match, whatever their whitespace. */
export function sameKey(a: string, b: string): boolean {
  try { return (createPublicKey(a).export({ type: 'spki', format: 'der' }) as Buffer).equals(createPublicKey(b).export({ type: 'spki', format: 'der' }) as Buffer) } catch { return false }
}

/** Digest of a derived report, timestamp removed: identical inputs and code give an identical digest. */
export function reportDigest(report: Record<string, unknown>): string {
  const { generatedAt: _dropped, ...rest } = report
  void _dropped
  return createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

export function readReceipt(paths: RunPaths): RunReceipt | null {
  const file = join(paths.dir, 'receipt.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) as RunReceipt } catch { return null }
}

export function writeReceipt(paths: RunPaths, receipt: RunReceipt): void {
  writeJsonAtomic(join(paths.dir, 'receipt.json'), receipt)
}
