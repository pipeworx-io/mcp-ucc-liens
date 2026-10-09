interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * UCC Liens — business-debtor UCC (Uniform Commercial Code) financing
 * statements for Colorado, Connecticut and Oregon, sourced from each state's
 * own public open-data portal (Socrata). Vermont's only public search surface
 * is gated behind a reCAPTCHA wall (confirmed live, 2026-10-08) and is not
 * automatable — ucc_search/ucc_new_filings return a loud, explicit error for
 * state: "VT" rather than a silent empty result. See README for probe detail.
 *
 * BUSINESS DEBTORS ONLY. Every one of the three live states publishes an
 * authoritative organization-vs-individual flag in its own data (CT:
 * debtor_nm_bus populated vs debtor_nm_last; CO: organizationname populated
 * vs firstname/lastname; OR: entity_type = 'ORG' vs 'IND') — filtering happens
 * in the upstream SoQL $where clause, before a row is ever fetched, not after.
 * No name-suffix heuristic is used because none of the three live states
 * needs one; if a future state lacked an explicit flag, ENTITY_SUFFIX_RE below
 * is the documented fallback (kept here, tested, unused by any live path).
 *
 * Every response — including a zero-match one — carries fcra_notice. This is
 * not a credit bureau and the data must never be used for an eligibility
 * decision.
 */


const UA = 'pipeworx-mcp-ucc-liens/1.0 (+https://pipeworx.io)';

const FCRA_NOTICE =
  'Not a consumer report. Not for use in credit, employment, insurance or housing eligibility decisions (FCRA).';

// Documented fallback only — see file header. Not called by any live state
// today; kept and exported so the heuristic this pack would use is visible
// and testable rather than implied.
const ENTITY_SUFFIX_RE =
  /\b(LLC|L\.L\.C\.|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC|PC|P\.C\.|TRUST|BANK|N\.A\.|ENTERPRISES|HOLDINGS|GROUP|PARTNERS|ASSOCIATES|SERVICES)\.?\s*$/i;
export function looksLikeBusinessName(name: string): boolean {
  return ENTITY_SUFFIX_RE.test(name.trim());
}

type StateCode = 'CO' | 'CT' | 'OR' | 'VT';
const STATES: StateCode[] = ['CO', 'CT', 'OR', 'VT'];

const VT_WALL_MESSAGE =
  'Vermont UCC search ("Lien Records Search" at bizfilings.vermont.gov/uccsearch) requires passing a ' +
  'Google reCAPTCHA challenge before any search executes ("User validation required to continue") — ' +
  'confirmed live 2026-10-08 via a real browser session (network trace showed google.com/recaptcha/api2 ' +
  'calls gating the search POST). Not automatable from a server-side client. No open dataset publishes ' +
  'Vermont UCC filings as an alternative. This is a recorded gap, not an empty result.';

async function pwFetch(url: string | URL, upstream: string, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, { ...init, headers: { Accept: 'application/json', 'User-Agent': UA, ...(init?.headers ?? {}) } }, upstream);
}

async function socrataGet(base: string, upstream: string, path: string): Promise<any[]> {
  const res = await pwFetch(`${base}${path}`, upstream);
  if (!res.ok) throw await httpError(res, upstream);
  return (await res.json()) as any[];
}

function soqlEscape(s: string): string {
  // SoQL string literals use '' to escape a literal single quote.
  return s.replace(/'/g, "''");
}

function likeClause(field: string, term: string): string {
  return `upper(${field}) like upper('%${soqlEscape(term)}%')`;
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v;
}

function reqState(args: Record<string, unknown>): StateCode {
  const v = reqStr(args, 'state', '"CO"').trim().toUpperCase();
  if (!STATES.includes(v as StateCode)) {
    throw new Error(`Unknown state "${v}". Supported: ${STATES.join(', ')} (Colorado, Connecticut, Oregon, Vermont).`);
  }
  return v as StateCode;
}

function clampLimit(args: Record<string, unknown>, def = 20, max = 100): number {
  const n = Number(args.limit);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

// ── Connecticut: data.ct.gov, resource xfev-8smz (Socrata) ─────────────────
// Secretary of the State, Business Services Division — one row per lien
// transaction (original filing, amendment, continuation, release...).
// debtor_nm_bus is populated only for organization debtors; individual
// debtors carry debtor_nm_last/first instead and are excluded by $where.

const CT_BASE = 'https://data.ct.gov';
const CT_RESOURCE = 'xfev-8smz';
const CT_UPSTREAM = 'Connecticut Secretary of the State (data.ct.gov UCC Lien Filings)';
const CT_RECORD_URL = (lienFilingNumber: string) =>
  `https://service.ct.gov/business/s/onlineenquiry?language=en_US&lienNumber=${encodeURIComponent(lienFilingNumber)}`;

function ctRowToFiling(r: any) {
  return {
    state: 'CT',
    file_number: r.id_ucc_flng_nbr ?? r.id_lien_flng_nbr,
    transaction_lien_number: r.id_lien_flng_nbr,
    filing_type: r.cd_flng_type ?? null,
    status: r.lien_status ?? null,
    filing_date: r.dt_accept ?? null,
    lapse_date: r.dt_lapse === '9999-12-31T00:00:00.000' ? null : (r.dt_lapse ?? null),
    debtor: r.debtor_nm_bus ?? null,
    debtor_address: [r.debtor_ad_str1, r.debtor_ad_city, r.debtor_ad_state, r.debtor_ad_zip].filter(Boolean).join(', ') || null,
    secured_party: r.sec_party_nm_bus ?? null, // individual secured parties withheld, not business-identified
    secured_party_address: r.sec_party_nm_bus
      ? [r.sec_party_ad_str1, r.sec_party_ad_city, r.sec_party_ad_state, r.sec_party_ad_zip].filter(Boolean).join(', ') || null
      : null,
    collateral: null, // not published in this dataset
    source_url: CT_RECORD_URL(r.id_lien_flng_nbr ?? ''),
    source: 'data.ct.gov (Uniform Commercial Code (UCC) Lien Filings, resource xfev-8smz)',
  };
}

async function ctSearch(debtorName: string, limit: number) {
  const where = `debtor_nm_bus IS NOT NULL AND ${likeClause('debtor_nm_bus', debtorName)}`;
  const p = new URLSearchParams({ $where: where, $order: 'dt_accept DESC', $limit: String(limit) });
  const rows = await socrataGet(CT_BASE, CT_UPSTREAM, `/resource/${CT_RESOURCE}.json?${p}`);
  return rows.map(ctRowToFiling);
}

async function ctNewFilings(since: string, securedParty: string | undefined, limit: number) {
  let where = `debtor_nm_bus IS NOT NULL AND dt_accept >= '${soqlEscape(since)}'`;
  if (securedParty) where += ` AND ${likeClause('sec_party_nm_bus', securedParty)}`;
  const p = new URLSearchParams({ $where: where, $order: 'dt_accept DESC', $limit: String(limit) });
  const rows = await socrataGet(CT_BASE, CT_UPSTREAM, `/resource/${CT_RESOURCE}.json?${p}`);
  return rows.map(ctRowToFiling);
}

// ── Colorado: data.colorado.gov, four joined Socrata datasets ──────────────
// filings (wffy-3uut) + debtors (8upq-58vz) + secured parties (ap62-sav4),
// joined in-memory by fileid. organizationname populated only for
// organization debtors; individual debtors carry firstname/lastname instead
// and are excluded by $where.

const CO_BASE = 'https://data.colorado.gov';
const CO_UPSTREAM = 'Colorado Secretary of State (data.colorado.gov UCC)';
const CO_FILINGS = 'wffy-3uut';
const CO_DEBTORS = '8upq-58vz';
const CO_SECURED = 'ap62-sav4';
const CO_RECORD_URL = (fileid: string) => `https://www.coloradosos.gov/ucc/pages/search/expandedFileView.xhtml?docId=${encodeURIComponent(fileid)}`;

async function coFetchByFileIds(resource: string, fileIds: string[]): Promise<any[]> {
  if (fileIds.length === 0) return [];
  const idList = fileIds.map((id) => `'${soqlEscape(id)}'`).join(',');
  const p = new URLSearchParams({ $where: `fileid in (${idList})`, $limit: String(fileIds.length * 4) });
  return socrataGet(CO_BASE, CO_UPSTREAM, `/resource/${resource}.json?${p}`);
}

function coAssemble(fileIds: string[], filingRows: any[], debtorRows: any[], securedRows: any[]) {
  const filingsByFileId = new Map<string, any[]>();
  for (const f of filingRows) {
    const arr = filingsByFileId.get(f.fileid) ?? [];
    arr.push(f);
    filingsByFileId.set(f.fileid, arr);
  }
  const debtorByFileId = new Map<string, any>();
  for (const d of debtorRows) if (!debtorByFileId.has(d.fileid)) debtorByFileId.set(d.fileid, d);
  const securedByFileId = new Map<string, any>();
  for (const s of securedRows) if (!securedByFileId.has(s.fileid) && s.organizationname) securedByFileId.set(s.fileid, s);

  return fileIds.map((fileid) => {
    const txns = (filingsByFileId.get(fileid) ?? []).sort((a, b) => String(b.filingdate ?? '').localeCompare(String(a.filingdate ?? '')));
    const latest = txns[0] ?? {};
    const debtor = debtorByFileId.get(fileid);
    const secured = securedByFileId.get(fileid);
    return {
      state: 'CO',
      file_number: fileid,
      filing_type: latest.documenttype ?? latest.filingtype ?? null,
      status: latest.terminationflag ? 'Terminated' : 'Active',
      filing_date: latest.filingdate ?? null,
      lapse_date: latest.lapsedate ?? null,
      amendment_count: txns.filter((t) => String(t.transactiontype ?? '').toLowerCase().includes('amendment')).length,
      debtor: debtor?.organizationname ?? null,
      debtor_address: debtor ? [debtor.address1, debtor.city, debtor.state, debtor.zipcode].filter(Boolean).join(', ') || null : null,
      secured_party: secured?.organizationname ?? null,
      secured_party_address: secured ? [secured.address1, secured.city, secured.state, secured.zipcode].filter(Boolean).join(', ') || null : null,
      collateral: null, // fetched separately only when requested, to bound response size
      source_url: CO_RECORD_URL(fileid),
      source: 'data.colorado.gov (UCC Filing/Debtor/Secured-Party Information in Colorado)',
    };
  });
}

async function coSearch(debtorName: string, limit: number) {
  const where = `organizationname IS NOT NULL AND ${likeClause('organizationname', debtorName)} AND recordstatus = 'active'`;
  const p = new URLSearchParams({ $where: where, $limit: String(limit) });
  const debtorRows = await socrataGet(CO_BASE, CO_UPSTREAM, `/resource/${CO_DEBTORS}.json?${p}`);
  const fileIds = [...new Set(debtorRows.map((d: any) => d.fileid))].slice(0, limit);
  const [filingRows, securedRows] = await Promise.all([
    coFetchByFileIds(CO_FILINGS, fileIds),
    coFetchByFileIds(CO_SECURED, fileIds),
  ]);
  return coAssemble(fileIds, filingRows, debtorRows, securedRows);
}

async function coNewFilings(since: string, securedParty: string | undefined, limit: number) {
  const p = new URLSearchParams({ $where: `filingdate >= '${soqlEscape(since)}'`, $order: 'filingdate DESC', $limit: String(limit * 3) });
  const filingRows = await socrataGet(CO_BASE, CO_UPSTREAM, `/resource/${CO_FILINGS}.json?${p}`);
  const candidateIds = [...new Set(filingRows.map((f: any) => f.fileid))];
  if (candidateIds.length === 0) return [];
  const debtorRows = await coFetchByFileIds(CO_DEBTORS, candidateIds);
  const bizDebtorRows = debtorRows.filter((d: any) => d.organizationname);
  let fileIds = [...new Set(bizDebtorRows.map((d: any) => d.fileid))];
  const securedRows = await coFetchByFileIds(CO_SECURED, fileIds);
  if (securedParty) {
    const needle = securedParty.toUpperCase();
    const matchFileIds = new Set(securedRows.filter((s: any) => String(s.organizationname ?? '').toUpperCase().includes(needle)).map((s: any) => s.fileid));
    fileIds = fileIds.filter((id) => matchFileIds.has(id));
  }
  fileIds = fileIds.slice(0, limit);
  return coAssemble(fileIds, filingRows, bizDebtorRows, securedRows);
}

// ── Oregon: data.oregon.gov, resource snfi-f79b (Socrata) ──────────────────
// "UCC List of Filings Entered Last Month" — a ROLLING window (the dataset is
// replaced monthly), not the full historical index. party_type: 'DB'
// (debtor) | 'SP' (secured party). entity_type: 'ORG' | 'IND' — individual
// debtors excluded by $where.
//
// Oregon's own full-history search portal (secure.sos.state.or.us/ucc) is
// NOT used here, but not because it is unreachable — it is edge-probed live
// and reachable from a Cloudflare Worker (GET searchHome.action for a
// CSRFToken + session cookie, then POST search.action; confirmed working,
// non-bot-walled, 2026-10-08). It is deliberately not used for two reasons:
// (1) its results LIST has no secured-party column — getting one requires an
// extra per-filing detail-page fetch, which this dataset gives for free in
// one query; (2) from a plain residential/office client (not a Worker) it IS
// Akamai-bot-walled — three consecutive curl probes from the same laptop got
// clean HTML on the first request and an obfuscated JS sensor-challenge page
// (`window["bobcmn"] = "..."`) on every repeat, so it is not a source a
// future maintainer should assume is safe to hit from outside a Worker
// without re-verifying.

const OR_BASE = 'https://data.oregon.gov';
const OR_UPSTREAM = 'Oregon Secretary of State (data.oregon.gov UCC List of Filings Entered Last Month)';
const OR_RESOURCE = 'snfi-f79b';
const OR_COVERAGE_NOTE =
  'Oregon coverage is a rolling ~30-day window (data.oregon.gov "UCC List of Filings Entered Last Month", ' +
  'refreshed monthly) — the full historical SOS search portal is Akamai bot-walled and not automatable ' +
  '(confirmed 2026-10-08). A debtor with no filing in the last month will not appear here even if active.';

function orRecordUrl(row: any): string | null {
  return row?.image_link?.url ?? null;
}

async function orSecuredPartiesFor(fileNumbers: string[]): Promise<Map<string, any>> {
  if (fileNumbers.length === 0) return new Map();
  const idList = fileNumbers.map((id) => `'${soqlEscape(id)}'`).join(',');
  const p = new URLSearchParams({ $where: `party_type = 'SP' AND entity_type = 'ORG' AND original_file_number in (${idList})`, $limit: String(fileNumbers.length * 3) });
  const rows = await socrataGet(OR_BASE, OR_UPSTREAM, `/resource/${OR_RESOURCE}.json?${p}`);
  const m = new Map<string, any>();
  for (const r of rows) if (!m.has(r.original_file_number)) m.set(r.original_file_number, r);
  return m;
}

function orRowToFiling(r: any, secured: any) {
  return {
    state: 'OR',
    file_number: r.original_file_number ?? r.file_number,
    transaction_file_number: r.file_number,
    filing_type: r.file_type ?? null,
    lien_type: r.lien_type ?? null,
    status: null, // not carried by this dataset; infer from lapse_date if needed
    filing_date: r.filing_date ?? null,
    lapse_date: r.lapse_date ?? null,
    debtor: r.entity ?? null,
    debtor_address: [r.mail_addr_1, r.city_descr, r.st_cd_txt, r.zip_code_txt].filter(Boolean).join(', ') || null,
    secured_party: secured?.entity ?? null,
    secured_party_address: secured ? [secured.mail_addr_1, secured.city_descr, secured.st_cd_txt, secured.zip_code_txt].filter(Boolean).join(', ') || null : null,
    collateral: null, // not published in this dataset
    source_url: orRecordUrl(r),
    source: 'data.oregon.gov (UCC List of Filings Entered Last Month, resource snfi-f79b)',
    coverage_note: OR_COVERAGE_NOTE,
  };
}

async function orSearch(debtorName: string, limit: number) {
  const where = `party_type = 'DB' AND entity_type = 'ORG' AND ${likeClause('entity', debtorName)}`;
  const p = new URLSearchParams({ $where: where, $order: 'filing_date DESC', $limit: String(limit) });
  const rows = await socrataGet(OR_BASE, OR_UPSTREAM, `/resource/${OR_RESOURCE}.json?${p}`);
  const secured = await orSecuredPartiesFor(rows.map((r: any) => r.original_file_number));
  return rows.map((r: any) => orRowToFiling(r, secured.get(r.original_file_number)));
}

async function orNewFilings(since: string, securedParty: string | undefined, limit: number) {
  let where = `party_type = 'DB' AND entity_type = 'ORG' AND filing_date >= '${soqlEscape(since)}'`;
  const p = new URLSearchParams({ $where: where, $order: 'filing_date DESC', $limit: String(limit * 2) });
  let rows = await socrataGet(OR_BASE, OR_UPSTREAM, `/resource/${OR_RESOURCE}.json?${p}`);
  const secured = await orSecuredPartiesFor(rows.map((r: any) => r.original_file_number));
  if (securedParty) {
    const needle = securedParty.toUpperCase();
    rows = rows.filter((r: any) => String(secured.get(r.original_file_number)?.entity ?? '').toUpperCase().includes(needle));
  }
  return rows.slice(0, limit).map((r: any) => orRowToFiling(r, secured.get(r.original_file_number)));
}

// ── Tool surface ─────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'ucc_search',
    description:
      `Search UCC (Uniform Commercial Code) financing-statement filings by debtor business name, for Colorado, ` +
      `Connecticut or Oregon (each state's own public Secretary of State open-data portal). Business debtors ` +
      `only — individual debtors are excluded at the source query, never fetched. Oregon's result set covers a ` +
      `rolling ~30-day window; Vermont has no automatable source (its one public search is reCAPTCHA-gated) and ` +
      `returns a loud error, not an empty list. ${FCRA_NOTICE}`,
    inputSchema: {
      type: 'object',
      properties: {
        debtor_name: { type: 'string', description: 'Business debtor name (or fragment) to search for, e.g. "Green Mountain Coffee".' },
        state: { type: 'string', description: 'Two-letter state code: CO, CT, OR, or VT (VT always errors — see tool description).' },
        limit: { type: 'number', description: 'Max filings to return (default 20, max 100).' },
      },
      required: ['debtor_name', 'state'],
    },
  },
  {
    name: 'ucc_new_filings',
    description:
      `List recent UCC financing-statement filings for a state since a given date — a lender-activity signal ` +
      `(who is extending secured credit to which businesses, and when). Business debtors only. Optionally filter ` +
      `by secured-party (lender) name. Same state coverage and limits as ucc_search. ${FCRA_NOTICE}`,
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Two-letter state code: CO, CT, OR, or VT (VT always errors — see tool description).' },
        since: { type: 'string', description: 'ISO date (YYYY-MM-DD) — return filings on or after this date.' },
        secured_party: { type: 'string', description: 'Optional: filter to filings naming this secured party (lender), substring match.' },
        limit: { type: 'number', description: 'Max filings to return (default 20, max 100).' },
      },
      required: ['state', 'since'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ucc_search': {
      const debtorName = reqStr(args, 'debtor_name', '"Green Mountain Coffee"');
      const state = reqState(args);
      const limit = clampLimit(args);
      if (state === 'VT') throw new Error(VT_WALL_MESSAGE);
      const filings =
        state === 'CT' ? await ctSearch(debtorName, limit) :
        state === 'CO' ? await coSearch(debtorName, limit) :
        await orSearch(debtorName, limit);
      return { state, debtor_name_query: debtorName, count: filings.length, filings, fcra_notice: FCRA_NOTICE };
    }
    case 'ucc_new_filings': {
      const state = reqState(args);
      const since = reqStr(args, 'since', '"2026-09-01"');
      const securedParty = typeof args.secured_party === 'string' && args.secured_party.trim() ? args.secured_party.trim() : undefined;
      const limit = clampLimit(args);
      if (state === 'VT') throw new Error(VT_WALL_MESSAGE);
      const filings =
        state === 'CT' ? await ctNewFilings(since, securedParty, limit) :
        state === 'CO' ? await coNewFilings(since, securedParty, limit) :
        await orNewFilings(since, securedParty, limit);
      return { state, since, secured_party_filter: securedParty ?? null, count: filings.length, filings, fcra_notice: FCRA_NOTICE };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
