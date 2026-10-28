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
- Visit a Discover row or search, then open the diagnostics page. Under **Titles encountered while browsing**, explicitly select a title to check. Refresh the catalogue once it finishes.

## Behaviour and limits

The server filters paginated Discover/search results, similar/recommendation lists and collection parts. Navigation cards are not media titles and remain visible. A title is shown only while its cached check is positive. Existing library availability is not presented as proof of a currently indexed release.

Browsing is **cache-only by default**. It does not search indexers. Live checks require an explicit action in the lab. They are limited to six title searches per hour, ten minutes apart. The budget persists across container restarts. A 429 opens a circuit breaker for at least one hour or the longer Retry-After interval. Indexer failures are `error`/unknown, not `missing`.

The isolated Prowlarr copy has no applications, download clients or notification integrations. It uses the same external indexer accounts as production, so their quotas are still shared. One title check can contact both indexers and may use more than one upstream API call. The hourly title budget is not a guarantee about external API call totals.

The preview policy accepts 1080p/2160p and prefers German over English. It uses exact normalized title/type/year checks or a matching TMDB identifier. It considers German title/category markers and explicitly labels inferred English. `GERMAN.SUBBED` is not treated as a German audio track. The policy is independent of Sonarr/Radarr's full quality/custom-format scoring and does not inspect actual audio streams, archives or NNTP article completion. TV availability means **at least one suitable release**, not every season/episode. Results are capped by the provider response; a missing result is not exhaustive proof of absence.

Positive checks expire after six hours, negative checks after one hour, and network errors after one minute. Expired entries remain hidden until explicitly rechecked. Original upstream pagination counts are preserved to let clients continue browsing; pages can therefore be sparse/empty and totals describe the candidate catalogue, not the filtered subset. This needs a dedicated indexing/pagination design before production use.

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

- 13 Node unit tests: title/type/year/language/quality matching, password/torrent exclusion, cache expiry, cache-only filtering, blocked sandbox writes, 429 cooldown.
- New TypeScript module checked with strict TypeScript 5.4.5 and Express/Node types.
- Live test searches returned actual releases for the two seeded series.
- Authenticated HTTP checks confirmed cached positives survive filtering; unchecked results are removed; browsing generated zero searches; POST `/api/v1/request` returned 403.
- Browser check confirmed the diagnostics page loads and asks for administrator sign-in.
- Neptune's official documentation says Discover queries use the configured Seerr server. No public Apple TV client source was found in the developer's GitHub repositories; `need4swede/neptune-plugins` is public. On-device compatibility remains to be verified using the lab's client traces.

Sources:
- <https://docs.neptuneplayer.com/discover>
- <https://docs.neptuneplayer.com/getting-started/setup/seerr>
- <https://github.com/need4swede/neptune-plugins>
