import {IPLIST_URL} from './constants.ts'

/**
 * Parse an `IPLIST.TXT`-format server list into bare IPv4 addresses.
 *
 * This is the same plain-text format the game's own `IPLIST.TXT` uses and that
 * the community master list at {@link IPLIST_URL} serves: one address per line,
 * `#`-prefixed lines are comments, and blank lines are ignored. Surrounding
 * whitespace is trimmed and CRLF line endings are handled.
 *
 * The list is best-effort and community-maintained, so entries are returned
 * as-is (deduplicated, order preserved) without verifying each is a reachable
 * or well-formed address - callers that need liveness should query them (see
 * `queryServer`).
 *
 * @param text - The raw list contents.
 * @returns The addresses in file order, with duplicates removed.
 */
export function parseIpList(text: string): string[] {
  const seen = new Set<string>()
  const addresses: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    if (!seen.has(line)) {
      seen.add(line)
      addresses.push(line)
    }
  }
  return addresses
}

/** Options for {@link fetchIpList}. */
export interface FetchIpListOptions {
  /** Abort signal to cancel the request. */
  signal?: AbortSignal
}

/**
 * Fetch and parse the community master server list.
 *
 * Downloads the plain-text list (default {@link IPLIST_URL}) over HTTPS and runs
 * it through {@link parseIpList}. Note this list is community-run and
 * best-effort: only servers patched to announce to ceservers.net, or games
 * running 1.50+, appear in it.
 *
 * @param url - List URL to fetch; defaults to {@link IPLIST_URL}.
 * @param options - Optional {@link FetchIpListOptions}.
 * @returns The parsed addresses.
 */
export async function fetchIpList(
  url: string = IPLIST_URL,
  options: FetchIpListOptions = {},
): Promise<string[]> {
  const response = await fetch(url, {signal: options.signal})
  if (!response.ok) {
    throw new Error(`Failed to fetch server list from ${url}: HTTP ${response.status}`)
  }
  return parseIpList(await response.text())
}
