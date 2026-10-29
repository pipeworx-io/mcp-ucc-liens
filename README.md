# @pipeworx/ucc-liens

Business-debtor UCC (Uniform Commercial Code) financing-statement filings —
secured loans against a company's assets — for Colorado, Connecticut and
Oregon, plus recent-filing lender-activity signals. Each state's own public
Secretary of State open-data portal is the source; Vermont is documented as
unreachable (see Data sources). Individual debtors are excluded at the query,
not filtered afterward, and every response carries an FCRA notice.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ucc_search(debtor_name, state, limit?)` — search filings by business debtor
  name in CO, CT or OR. Returns file number, filing type/status, filing and
  lapse dates, debtor name/address, secured party name/address, and a source
  URL per filing. `state: "VT"` always throws (see Data sources).
- `ucc_new_filings(state, since, secured_party?, limit?)` — recent filings
  since a date, for lender-activity signals (who is lending to whom, and
  when). Same state coverage; optional substring filter on secured-party name.

## Auth

Keyless. All three live sources are public, unauthenticated open-data APIs.

## Data sources

- <https://data.ct.gov/resource/xfev-8smz.json> — Connecticut Secretary of
  the State, "Uniform Commercial Code (UCC) Lien Filings." One row per lien
  transaction (original filing, amendment, continuation, release). Business
  debtors carry `debtor_nm_bus`; individual debtors carry `debtor_nm_last`/
  `debtor_nm_first` instead and never `debtor_nm_bus` — the pack's `$where`
  requires `debtor_nm_bus IS NOT NULL`, so an individual-debtor row is never
  fetched. No collateral description field is published in this dataset.
- <https://data.colorado.gov/resource/wffy-3uut.json> (filings),
  <https://data.colorado.gov/resource/8upq-58vz.json> (debtors),
  <https://data.colorado.gov/resource/ap62-sav4.json> (secured parties) —
  Colorado Secretary of State UCC, as three separate Socrata datasets joined
  in-memory by `fileid` (there is no server-side join). Debtors carry
  `organizationname` when a business, `firstname`/`lastname` when an
  individual — the pack queries the debtors dataset with
  `organizationname IS NOT NULL` first and only ever fetches filings/secured
  parties for the `fileid`s that search returned. A fourth dataset,
  `4am6-w6u4` (collateral), exists but is not queried in v1 to keep response
  size bounded — the schema is simple to add if a caller asks for it.
- <https://data.oregon.gov/resource/snfi-f79b.json> — Oregon Secretary of
  State, "UCC List of Filings Entered Last Month." **This is a rolling
  ~30-day window, not the full historical index** — the dataset name is
  literal; it is replaced monthly, not accumulated. `party_type` is `DB`
  (debtor) or `SP` (secured party); `entity_type` is `ORG` or `IND`. The pack
  requires `party_type = 'DB' AND entity_type = 'ORG'` for search/new-filings,
  then makes a second query for the matching `SP` row(s) by
  `original_file_number` to attach the secured party. A debtor with no filing
  in roughly the last month will not appear even if its lien is still active
  — this is a genuine coverage limit, documented in every Oregon filing's
  `coverage_note` field, not a bug.
  Oregon's full-history search (`secure.sos.state.or.us/ucc/searchHome.action`
  → POST `/ucc/search.action`) is **not used in v1, but it is reachable** —
  edge-probed live from a throwaway Cloudflare Worker on the prod account
  (2026-10-08): GET the search form for a `CSRFToken` + session cookie, then
  POST a debtor search, and it returns a clean "Welcome Public User" results
  page (verified with debtor NIKE, 2 live liens), no bot challenge, 3/3 runs.
  It is skipped anyway because its results LIST has no secured-party column —
  getting one means an extra per-filing detail-page fetch per row, which
  `snfi-f79b` gives for free in a single second query. Separately, **from a
  plain residential/office client (not a Worker) it IS Akamai-bot-walled**:
  three consecutive `curl` probes from the same laptop got clean HTML on the
  very first request and Akamai's obfuscated JS sensor-challenge page
  (`window["bobcmn"] = "..."`) on every repeat. Don't assume "tested from my
  laptop" tells you anything about this host either way — it cuts both
  directions here (Worker: fine; repeated non-Worker client: walled) — always
  re-probe from a Worker before relying on either answer.
- **Vermont has no automatable source.** Its only public UCC search,
  `bizfilings.vermont.gov/uccsearch` ("Lien Records Search," an Angular SPA
  calling `api.bizfilings.vermont.gov/api`), requires completing a Google
  reCAPTCHA before the search request is even sent — confirmed live
  2026-10-08 via a real browser session: submitting the form opened a "User
  validation required to continue" / "I'm not a robot" dialog, and the
  network trace showed `google.com/recaptcha/api2/anchor` and `/bframe` calls
  gating the POST. No Vermont open-data mirror of UCC filings exists (checked
  data.vermont.gov / open data search). `ucc_search`/`ucc_new_filings` with
  `state: "VT"` always throw a descriptive error naming this wall — by design,
  never a silent empty result, and never attempted automatically (bypassing a
  CAPTCHA is out of bounds regardless of feasibility).

Compliance: every tool description and every successful response carries
`fcra_notice`: "Not a consumer report. Not for use in credit, employment,
insurance or housing eligibility decisions (FCRA)." This is a public-filing
lookup, not a credit bureau product.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ucc-liens": {
      "url": "https://gateway.pipeworx.io/ucc-liens/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ucc-liens/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ucc_search \
  -H 'Content-Type: application/json' \
  -d '{"debtor_name":"NPG Holdings","state":"CT"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ucc_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ucc-liens` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ucc-liens/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ucc-liens": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ucc-liens"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ucc Liens data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
