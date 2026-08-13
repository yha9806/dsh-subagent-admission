#!/usr/bin/env tsx
/**
 * Exact live compatibility baseline refresh.
 *
 * Reads, without any token:
 *  - the official repository HEAD via `git ls-remote`;
 *  - the official source package version from the exact fetched commit;
 *  - npm dist-tags from the canonical registry;
 *  - Discussion #131 from two direct GitHub surfaces: the official REST
 *    discussion and paginated comment endpoints (numeric id, state, total
 *    comments, updated_at, per-comment author_association) and the canonical
 *    public HTML page, which contributes only the main discussion upvote
 *    count via the exact button id `discussion-upvote-button-Discussion-<id>`
 *    and the exact `aria-label="Upvote: N"` shape.
 *
 * Any missing, duplicate, malformed, paginated, or cross-source-inconsistent
 * shape fails closed instead of guessing from nearby rendered text.
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const OFFICIAL_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness.git'
const OFFICIAL_OWNER_REPO = 'deepseek-ai/deepseek-harness'
const SOURCE_PACKAGE_PATH = 'packages/subagent/subagent/package.json'
const DISCUSSION_NUMBER = 131
const DISCUSSION_HTML_URL = `https://github.com/${OFFICIAL_OWNER_REPO}/discussions/${DISCUSSION_NUMBER}`
const DISCUSSION_API_URL = `https://api.github.com/repos/${OFFICIAL_OWNER_REPO}/discussions/${DISCUSSION_NUMBER}`
const DISCUSSION_COMMENTS_URL = `${DISCUSSION_API_URL}/comments`
const NPM_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-subagent'] as const
const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const
const MAX_COMMENT_PAGES = 100

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = resolve(SCRIPT_DIR, '../compatibility/baseline.json')

interface StrictTarget {
  sourceCommit: string
  sourcePackageVersion: string
  protocolVersion: number
  patchSha256: string
  verificationCommand: string
}

interface CompatibilityBaselineV1 {
  schemaVersion: 1
  status: 'aligned' | 'source-npm-diverged'
  observedAt: string
  source: {
    repository: string
    commit: string
    packagePath: string
    packageVersion: string
  }
  npm: Record<string, { latest: string; next: string }>
  discussion131: {
    url: string
    apiUrl: string
    commentsUrl: string
    id: number
    state: 'open' | 'closed'
    votes: number
    commentCount: number
    maintainerCommentCount: number
    updatedAt: string
    observedAt: string
  }
  strictTargets: StrictTarget[]
  strictTargetsCurrent: boolean
}

function fail(message: string): never {
  throw new Error(`baseline refresh: ${message}`)
}

async function fetchText(url: string, accept: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Accept: accept,
        'User-Agent': 'dsh-subagent-admission-baseline',
      },
    })
  } catch (error) {
    fail(`request to ${url} failed: ${(error as Error).message}`)
  }
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`)
  return response.text()
}

async function fetchJson(url: string): Promise<unknown> {
  const text = await fetchText(url, 'application/vnd.github+json')
  try {
    return JSON.parse(text) as unknown
  } catch {
    fail(`${url} did not return JSON`)
  }
}

function asObject(value: unknown, source: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${source} is not a JSON object`)
  }
  return value as Record<string, any>
}

async function fetchOfficialHeadCommit(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['ls-remote', OFFICIAL_REPOSITORY, 'HEAD'], {
    encoding: 'utf8',
  })
  const match = stdout.match(/^([0-9a-f]{40})\tHEAD(?:\s|$)/m)
  if (match === null) fail('git ls-remote HEAD line is missing or malformed')
  return match[1]!
}

async function fetchSourcePackageVersion(commit: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${OFFICIAL_OWNER_REPO}/${commit}/${SOURCE_PACKAGE_PATH}`
  const text = await fetchText(url, 'application/vnd.github.raw+json')
  let manifest: Record<string, any>
  try {
    manifest = asObject(JSON.parse(text) as unknown, `${SOURCE_PACKAGE_PATH}@${commit}`)
  } catch {
    fail(`${SOURCE_PACKAGE_PATH}@${commit} did not return JSON`)
  }
  const version = manifest.version
  if (typeof version !== 'string' || version.length === 0) {
    fail(`${SOURCE_PACKAGE_PATH}@${commit} has no string version field`)
  }
  return version
}

function registryUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace('/', '%2F')}`
}

async function fetchNpmDistTags(): Promise<Record<string, { latest: string; next: string }>> {
  const result: Record<string, { latest: string; next: string }> = {}
  for (const packageName of NPM_PACKAGES) {
    const doc = asObject(await fetchJson(registryUrl(packageName)), `registry ${packageName}`)
    const tags = doc['dist-tags']
    const latest = tags?.latest
    const next = tags?.next
    if (typeof latest !== 'string' || latest.length === 0 || typeof next !== 'string' || next.length === 0) {
      fail(`npm dist-tags for ${packageName} are missing latest/next strings`)
    }
    result[packageName] = { latest, next }
  }
  return result
}

interface DiscussionRecord {
  id: number
  state: 'open' | 'closed'
  comments: number
  updatedAt: string
}

async function fetchDiscussionRecord(): Promise<DiscussionRecord> {
  const doc = asObject(await fetchJson(DISCUSSION_API_URL), 'REST discussion')
  const id = doc.id
  const number = doc.number
  const state = doc.state
  const comments = doc.comments
  const updatedAt = doc.updated_at
  if (!Number.isSafeInteger(id) || id <= 0) fail('REST discussion id is missing or malformed')
  if (number !== DISCUSSION_NUMBER) fail(`REST discussion number ${String(number)} !== ${DISCUSSION_NUMBER}`)
  if (state !== 'open' && state !== 'closed') fail('REST discussion state is missing or malformed')
  if (!Number.isSafeInteger(comments) || comments < 0) fail('REST discussion comments is missing or malformed')
  if (typeof updatedAt !== 'string' || updatedAt.length === 0) fail('REST discussion updated_at is missing or malformed')
  return { id, state, comments, updatedAt }
}

function nextPageUrl(response: Response): string | null {
  const link = response.headers.get('link')
  if (link === null) return null
  const entries = [...link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g)]
  if (entries.length === 0) fail('comment pagination Link header is malformed')
  for (const entry of entries) {
    const rel = entry[2]
    if (rel !== 'next' && rel !== 'prev' && rel !== 'first' && rel !== 'last') {
      fail(`unrecognized comment pagination rel "${rel}"`)
    }
  }
  return entries.find(entry => entry[2] === 'next')?.[1] ?? null
}

async function fetchCommentAssociations(expectedCount: number): Promise<string[]> {
  const associations: string[] = []
  let url: string | null = `${DISCUSSION_COMMENTS_URL}?per_page=100&page=1`
  for (let page = 0; url !== null; page += 1) {
    if (page >= MAX_COMMENT_PAGES) fail(`comment pagination exceeded ${MAX_COMMENT_PAGES} pages`)
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'dsh-subagent-admission-baseline',
        },
      })
    } catch (error) {
      fail(`request to ${url} failed: ${(error as Error).message}`)
    }
    if (!response.ok) fail(`${url} returned HTTP ${response.status}`)
    let rows: unknown
    try {
      rows = JSON.parse(await response.text()) as unknown
    } catch {
      fail(`${url} did not return JSON`)
    }
    if (!Array.isArray(rows)) fail(`${url} is not a JSON array`)
    for (const row of rows) {
      const association = (row as Record<string, any> | null)?.author_association
      if (typeof association !== 'string' || association.length === 0) {
        fail(`${url} contains a comment without an author_association string`)
      }
      associations.push(association)
    }
    url = nextPageUrl(response)
  }
  if (associations.length !== expectedCount) {
    fail(`fetched comment rows ${associations.length} !== REST discussion comments ${expectedCount}`)
  }
  return associations
}

async function fetchDiscussionVotes(discussionId: number): Promise<number> {
  const html = await fetchText(DISCUSSION_HTML_URL, 'text/html')
  const expectedId = `discussion-upvote-button-Discussion-${discussionId}`
  const matches = [...html.matchAll(/<button\b[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => tag.includes(`id="${expectedId}"`))
  if (matches.length !== 1) {
    fail(`expected exactly one main upvote button "${expectedId}", found ${matches.length}`)
  }
  const label = matches[0]!.match(/\baria-label="Upvote: (\d+)"/)
  if (label === null) fail(`main upvote button has no exact aria-label="Upvote: N"`)
  const votes = Number(label[1])
  if (!Number.isSafeInteger(votes) || votes < 0) fail('main upvote count is malformed')
  return votes
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

async function readExistingBaseline(): Promise<CompatibilityBaselineV1 | undefined> {
  try {
    const text = await readFile(BASELINE_PATH, 'utf8')
    const parsed = JSON.parse(text) as CompatibilityBaselineV1
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.strictTargets)) {
      fail('existing baseline is not a schemaVersion 1 document with strictTargets')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function stripWallClock(value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, any>
  delete copy.observedAt
  delete copy.discussion131.observedAt
  return copy
}

async function buildBaseline(): Promise<CompatibilityBaselineV1> {
  const [commit, npm] = await Promise.all([fetchOfficialHeadCommit(), fetchNpmDistTags()])
  const [sourcePackageVersion, record] = await Promise.all([
    fetchSourcePackageVersion(commit),
    fetchDiscussionRecord(),
  ])
  const [associations, votes] = await Promise.all([
    fetchCommentAssociations(record.comments),
    fetchDiscussionVotes(record.id),
  ])
  const maintainerCommentCount = associations
    .filter(association => (MAINTAINER_ASSOCIATIONS as readonly string[]).includes(association))
    .length
  const existing = await readExistingBaseline()
  const strictTargets = existing === undefined ? [] : existing.strictTargets
  return {
    schemaVersion: 1,
    status: npm['@deepseek-ai/dsh-subagent'].next === sourcePackageVersion ? 'aligned' : 'source-npm-diverged',
    observedAt: new Date().toISOString(),
    source: {
      repository: OFFICIAL_REPOSITORY,
      commit,
      packagePath: SOURCE_PACKAGE_PATH,
      packageVersion: sourcePackageVersion,
    },
    npm,
    discussion131: {
      url: DISCUSSION_HTML_URL,
      apiUrl: DISCUSSION_API_URL,
      commentsUrl: DISCUSSION_COMMENTS_URL,
      id: record.id,
      state: record.state,
      votes,
      commentCount: record.comments,
      maintainerCommentCount,
      updatedAt: record.updatedAt,
      observedAt: new Date().toISOString(),
    },
    strictTargets,
    strictTargetsCurrent: strictTargets.every(target => target.sourceCommit === commit),
  }
}

function usage(): never {
  console.error('usage: refresh-baseline.mts (--write | --check)')
  process.exit(2)
}

const mode = process.argv[2]
if (mode !== '--write' && mode !== '--check') usage()

try {
  const candidate = await buildBaseline()
  if (mode === '--write') {
    await writeFile(BASELINE_PATH, stableStringify(candidate))
    console.log(`baseline written: ${BASELINE_PATH}`)
    console.log(`source ${candidate.source.packageVersion} @ ${candidate.source.commit}; status ${candidate.status}`)
  } else {
    const existing = await readExistingBaseline()
    if (existing === undefined) fail('no committed baseline to check; run --write first')
    if (stableStringify(stripWallClock(candidate)) !== stableStringify(stripWallClock(existing))) {
      console.error('baseline drift detected: live identities differ from compatibility/baseline.json')
      process.exitCode = 1
    } else {
      console.log('baseline matches live source/npm/discussion identities')
    }
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
