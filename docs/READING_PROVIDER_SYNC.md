# Goodreads and Pagebound outbound synchronization

Modified version: 26 October 2026. This is a modified version of BookOrbit and is not an official BookOrbit release. Source: https://github.com/blgraf/bookorbit/tree/feat/goodreads-pagebound-sync.

BookOrbit can independently connect Goodreads and Pagebound from Settings > Accounts. Each provider has its own permission, encrypted connection, book mappings, exclusions, queue, and error state. Existing StoryGraph and Hardcover integrations are unchanged.

## Configure and connect

Set `READING_PROVIDER_ENCRYPTION_KEY` to a privately generated 32-byte key encoded as 64 hexadecimal characters, for example using `openssl rand -hex 32`. Keep the key in environment settings or a secret file, keep a secure backup, and restart the API. There is no plaintext fallback. Removing or changing the key requires restoring it or reconnecting affected accounts. Do not commit keys or cookies.

Administrators grant `pagebound_sync` and `goodreads_sync` independently under user permissions. Superusers have access. Library access and content filters still apply to manual requests, bulk enumeration, background jobs, and every outgoing write.

Pagebound connects using its web Firebase email/password flow and token exchange. The password is discarded after sign-in; only encrypted renewable credentials are stored. Access token expiration and a single refresh after authentication rejection are supported. Expired refresh credentials require reconnecting.

For Goodreads, sign in in your own browser, open its developer tools Network panel, select a request to `www.goodreads.com`, and copy the **Cookie request-header value**. Paste the single line in BookOrbit. These cookies grant account access. Complete any CAPTCHA or challenge in the browser. BookOrbit never runs browser automation, bypasses challenges, or refreshes browser cookies externally. Replace expired cookies using Replace credentials.

Connection validation is read-only. Connecting never enables sync. Enable each provider explicitly after validating. Enabling affects future reading changes and does not initiate an initial historical sync. **Sync all eligible books** explicitly queues existing books. Book details let users exclude a book, search editions, save an exact edition link, or queue one book. Saving a link does not itself modify provider data. Disconnect clears authentication secrets and cancels pending work. Reconnecting a different account requires disconnecting first and resets the previous account's mapping baselines.

## What synchronizes

| BookOrbit status | Goodreads                                         | Pagebound                                                     |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| Want to read     | To read                                           | Interested                                                    |
| Reading          | Currently reading                                 | Currently reading                                             |
| Read             | Read                                              | Finished                                                      |
| Rereading        | Reading only after a new read is started remotely | Reading only after a new reading instance is started remotely |
| On hold          | Unsupported, preserved                            | Paused                                                        |
| Abandoned        | Unsupported, preserved                            | Did not finish                                                |
| Unread / skimmed | Unsupported, preserved                            | Unsupported, preserved                                        |

Progress comes from current BookOrbit state, regardless of web reader, Kobo, KOReader, or reading-session events. The latest file progress is used rather than a maximum across unrelated reading files. Progress older than the current reading start is withheld. Ratings are user ratings, never community averages. Reading dates come from the user's canonical reading-status projection and are transmitted as calendar dates without inventing today's start/finish date.

Existing links take priority, followed by a validated metadata Goodreads ID, ISBN lookup where available, and an unambiguous exact title/author match. A conflicting known ISBN is rejected. Multiple editions require manual selection. Pagebound stores both the numeric book ID and UUID, since they serve different API purposes. Provider mappings are always user-specific.

## Safety and recovery

The PostgreSQL queue stores book identities, revisions, retry state, and leases, not historical event payloads. Frequent events coalesce for three seconds. One worker processes a job at a time; a database lease serializes each user/provider across replicas. The worker checks the latest local state, current permissions, connection version, exclusions, book link, and lease before every outgoing mutation. New events arriving during a write leave another job pending. Expired leases recover after ten minutes; an old worker cannot finish a replacement worker's job.

Remote state is read before deciding what to send and read again to verify successful writes. Equal values are deduplicated. Remote progress never moves backward. A finished remote read is never replaced by an in-progress local read. A newer remote reading instance is protected. Rereads are deliberately not auto-created from old local events; start them on the provider first. Existing remote dates are preserved, and differing remote ratings require a trusted baseline plus a subsequent local rating change. Null local values do not erase provider ratings or dates.

Temporary failures use exponential backoff, starting at five seconds and capped at five minutes, with at most six attempts. Authentication/challenge failures stop automatic sync and show a reconnect requirement. A timeout is treated as an uncertain write: the next attempt reads remote state and never blindly repeats the old request. Successful snapshots are not advanced after a partial or unconfirmed failure. Uncertainty, provider errors, matching failures, and skipped fields remain visible in settings and book details. Requests are serialized per provider origin with at least 500 ms spacing, 30-second timeouts, restricted HTTPS origins, no cross-origin credential redirects, and bounded response sizes.

Provider APIs do not expose a documented compare-and-swap operation. Independent edits made in the brief interval between a verified remote read and its write cannot be made atomic with BookOrbit. Prefer a single writer while synchronization is enabled. Pause the integration before deliberately resetting progress or changing editions.

Allow outbound HTTPS to `www.goodreads.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `prod-pagebound-api.onrender.com`, and `hztadco4ku1vqi6lp.a1.typesense.net` when using a restricted egress policy. Account credentials are only sent to their respective authentication/API origins.

## Provider limitations

### Pagebound

- Ratings are **not automatically sent**. The reference web flow publishes `/reviews` and includes review text and additional rating fields. This implementation refuses to create or replace a review merely to set stars. Set ratings on Pagebound manually until a verified, non-publishing rating-only API is available.
- The reference search API searches title and author, not ISBN. ISBN returned by a candidate can validate an edition; it is not a guaranteed lookup path.
- Progress is attached to the existing current reading instance. Multiple active instances, a changed instance during synchronization, or a missing instance stop the update. Page counts come from the remote edition and are never taken from an unrelated local edition. Percentage is preferred, and derived pages are rounded down to avoid overstating progress.
- Progress requests use `no_broadcast: true`. No forum posts, notes, or reviews are sent. Existing shelves, ownership, mute state, dates, and audio fields are preserved.
- Public Firebase and Typesense client keys are web configuration, not account secrets. The unofficial hosts and payloads may change.

### Goodreads

- Goodreads has no generally available official write API. Its unofficial web endpoints can change or be blocked by WAF/CAPTCHA. Failure stops the operation rather than bypassing access controls.
- Some logged-in book pages do not expose a reliable remote percentage. Progress is then **withheld**, with an explicit warning, even if local progress increased. Successful mocked tests do not establish that a particular live account exposes this field.
- Supported progress updates use percentages with an empty status body. Goodreads may publish its own activity-feed entry; BookOrbit never submits journal text. Equal progress is not posted twice.
- Safe rating updates use the native rating endpoint and preserve a different existing rating unless a trusted baseline and subsequent local change allow updating it.
- Reading dates use the current review-editor server action only when its action ID, exact book identity, unique active read, and complete existing review/notes/preferences can be read. Only missing dates are filled. Historical sessions and existing review text are preserved, and publication flags are false. If the editor changes, dates are withheld with an error. Existing completed history is never replaced to manufacture a reread.
- Cookies require manual reconnection when expired. No separate refresher or automation service is included.

## Validation

Automated tests use synthetic sanitized responses derived from the protocol shapes in ShelfSync, not live account recordings. They do not contact real provider accounts. Run:

```bash
pnpm --filter server test src/modules/reading-provider src/modules/pagebound src/modules/goodreads
pnpm --filter client test:unit --run src/features/reading-provider src/features/settings/lib/__tests__/integration-tabs.spec.ts
pnpm run e2e:run -- reading-provider
pnpm typecheck
pnpm lint:check
```

Manual verification with disposable books/accounts:

1. Configure encryption, grant one provider permission, connect and validate. Confirm no remote reading data changes before explicit enablement and no initial bulk sync starts.
2. Link an exact edition. Advance progress from web, Kobo, and KOReader. Verify supported status/date/rating changes, withheld-field warnings, and independent behavior when both providers are enabled.
3. Advance remote progress beyond local progress and mark a remote book finished. Verify stale local events preserve both. Begin a deliberate reread remotely and locally; verify it targets the current instance without changing history.
4. Exclude a book, disable a provider, or disconnect while a job waits. Confirm no subsequent writes and no secrets in API responses/logs. Replace expired cookies/tokens and explicitly re-enable.
5. Interrupt a provider response, restart the API, and confirm recovery reads remote state before retrying. Check that partial writes do not create duplicate progress entries or reading instances.
6. Confirm Pagebound reviews/notes/forum posts remain untouched, Goodreads review text/history is preserved, and challenge responses show reconnect guidance.

No live-account success is claimed without completing these checks with the relevant accounts.

## Protocol attribution

Provider communication adapts the MIT-licensed ShelfSync implementation by Billiam and contributors, at https://github.com/Lyfts/ShelfSync, inspected at commit `b6980a7c7bd037b310583fd64c6ef6d571456169`. Its license is preserved in `docs/licenses/ShelfSync-MIT.txt`. BookOrbit's AGPL and Additional Terms remain intact.
