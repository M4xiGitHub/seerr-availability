# Seerr availability catalogue experiment

Forked from Seerr v3.5.1, commit `564bfb08b54caa374bddaf820abfd226e5e69151`.
The branch is `availability-catalogue`. This is a prototype, not an upstream Seerr feature.

## Try it

- Web app: <http://localhost:5057>
- Diagnostics: <http://localhost:5057/availability-lab.html>
- Apple TV / LAN: <http://192.168.0.21:5057>
- Sign in using your existing Seerr or Jellyfin account. The lab has its own copied user database and session secret.
- In Neptune, explicitly select the test URL as the **active Seerr URL**. Merely saving it does not switch the active connection. Switch back to port 5055 to return to normal.
- Two live-checked series were seeded in the test cache. Searching for `Supernatural` or `South Park` currently demonstrates a positive result. An unchecked title is hidden.
- The background builder now discovers released movie candidates automatically. Open the diagnostics page to see its queue, candidate-source error (if any), current check and the number of movies ready. Movies appear as positive checks finish. Explicit title checks remain available.

## Behaviour and limits

The general Discover trending/popular TV/movie rows now display the checked-title catalogue directly, with correct pagination. They no longer depend on a checked title also appearing on an unrelated TMDB trending page. These replacement rows require the administrator account in this prototype. Other paginated Discover/search results, similar/recommendation lists and collection parts are filtered. Navigation cards remain visible. A title is shown only while its cached check is positive; expired checks are labelled in diagnostics. Existing library availability is not presented as proof of a currently indexed release.

Browsing remains **cache-only** and never searches indexers itself. A separate background builder fetches movie candidates from TMDB, checks them gradually, and renews expired positives. Candidates must have a release date at least 45 days ago and at least 50 TMDB votes; English/German originals are checked first but other original languages are not excluded. This does not prove digital release availability; only a matching indexer result qualifies a movie for display.

The builder fetches at most one candidate page every 15 minutes and only while its pending queue has fewer than ten entries. Candidate-source failures pause it for 15 minutes. Queue and page cursor persist across restarts. Live checks share one persistent budget with manual checks: six title searches per hour, ten minutes apart. They check the regular Prowlarr instance's backoff state before searching with the isolated instance. A 429 opens a circuit breaker for at least one hour or the longer Retry-After interval. Other network/indexer errors retain the failed work for retry and pause checking for at least 15 minutes. Errors stay unknown, never `missing`.

The isolated Prowlarr copy has no applications, download clients or notification integrations. It uses the same external indexer accounts as production, so their quotas are still shared. One title check can contact both indexers and may use more than one upstream API call. The hourly title budget is not a guarantee about external API call totals.

The preview policy accepts 1080p/2160p and prefers German over English. It uses exact normalized title/type/year checks or a matching TMDB identifier. It considers German title/category markers and explicitly labels inferred English. `GERMAN.SUBBED` is not treated as a German audio track. The policy is independent of Sonarr/Radarr's full quality/custom-format scoring and does not inspect actual audio streams, archives or NNTP article completion. TV availability means **at least one suitable release**, not every season/episode. Results are capped by the provider response; a missing result is not exhaustive proof of absence.

This deployment keeps positive checks for 24 hours, negative checks for one hour, and error diagnostics for one minute. Expired positives are hidden and queued for renewal by the builder. The main checked catalogue has accurate pagination. Other filtered genre/search lists retain upstream candidate pagination, so those pages can still be sparse/empty. Positive checks cache metadata, with a four-second metadata deadline and a text-only card fallback. Candidate metadata remains on cards if enrichment times out. The test Seerr container uses explicit DNS and the copied Seerr setting `network.forceIpv4First=true` to avoid IPv6 connection timeouts. Production Seerr settings are unchanged.

## Isolation

- Original Seerr container, image, volumes and settings are unchanged.
- Separate named volumes: `seerr-availability-lab-config`, `seerr-availability-lab-indexers`.
- SQLite was copied using its online backup API, without stopping the original server.
- Lab Seerr scheduled jobs are disabled. All non-GET API operations except authentication are rejected, including requests and service-setting changes. No downloads can be initiated from the lab.
- Prowlarr secrets live in the private test volume, not in this repository or Compose file.
- Diagnostics require the administrator account. Traces omit query strings, passwords, API keys, bodies and cookies. They record endpoint paths and user-agent strings for Neptune debugging.

## Deployment

The snapshot scripts run inside `umbrel-test`. They refuse to overwrite an existing snapshot. Credentials must never be committed. After the snapshots have been copied to the external named volumes:

```powershell
docker compose -f compose.availability.yaml up -d --build
```

Stop the test deployment without affecting production:

```powershell
docker compose -f compose.availability.yaml stop
```

`Dockerfile.availability` derives from the exact pinned production release, reuses its built frontend/dependencies, and transpiles the changed server entry point and the new middleware. This avoids a full Next.js rebuild. `AVAILABILITY_SANDBOX=true` enables the experiment. The default upstream Dockerfile/build is unaffected.

## Verification

- 20 Node unit tests: title/type/year/language/quality matching, password/torrent exclusion, cache expiry, cache-only filtering, blocked sandbox writes, 429 cooldown, checked-catalogue pagination, cached genre filtering, released candidate eligibility, queue/cursor recovery, metadata outage cooldown and respecting production backoff without a search.
- New TypeScript module checked with strict TypeScript 5.4.5 and Express/Node types.
- Live test searches returned actual releases for the two seeded series.
- Authenticated HTTP checks confirmed cached positives survive filtering; unchecked results are removed; browsing generated zero searches; POST `/api/v1/request` returned 403.
- Browser check confirmed the diagnostics page loads and asks for administrator sign-in.
- Movie/TV discovery now applies genre, original language, date/rating/vote-count filters and sorting to cached metadata. Unknown metadata is excluded when needed for a filter; unsupported filters return no candidates instead of calling live discovery. Verified `/discover/movies?genre=28` renders **No results** instead of a 500 when there are no checked Action movies.
- Neptune's official documentation says Discover queries use the configured Seerr server. No public Apple TV client source was found in the developer's GitHub repositories; `need4swede/neptune-plugins` is public. On-device compatibility remains to be verified using the lab's client traces.

Sources:
- <https://docs.neptuneplayer.com/discover>
- <https://docs.neptuneplayer.com/getting-started/setup/seerr>
- <https://github.com/need4swede/neptune-plugins>
