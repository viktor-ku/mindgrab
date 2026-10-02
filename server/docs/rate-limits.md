# HTTP request quotas

Each server router constructs its own `tower_governor` configuration. Router
clones share the same buckets; independent servers and test routers do not.
These are token buckets: the burst is immediate capacity, and the refill
interval adds **one** request, up to that capacity.

| Requests | Confirmed key | Burst | Refill interval |
| --- | --- | ---: | ---: |
| Login start + WorkOS callback (shared) | TCP peer IP | 10 | 6 seconds |
| Binary submissions, before authentication | TCP peer IP | 600 | 20 milliseconds |
| Binary submissions, after authentication | WorkOS-backed user ID | 120 | 100 milliseconds |
| WebSocket upgrades, before authentication | TCP peer IP | 120 | 200 milliseconds |
| WebSocket upgrades, after authentication | WorkOS-backed user ID | 20 | 3 seconds |

The login bucket allows five complete start/callback flows in an initial burst.
Account upload capacity permits 120 immediate binary batches and 10 per second
thereafter, giving offline replay and multiple projects room to recover.
Account upgrade capacity permits 20 immediate reconnects and one every three
seconds thereafter. Peer guards are broader to accommodate shared networks
while limiting invalid sessions before database/provider validation.

## Request ordering and responses

CORS and private response headers wrap every limiter. Login origin validation
runs before its limiter; the callback's limiter runs before session middleware
and provider exchange. Project origin validation runs first, followed by the
peer limiter, authentication and account fencing, then the account limiter.
The upload limiter precedes metadata validation, body reading and ingestion;
the upgrade limiter precedes project reconstruction and socket permits.
Rejected requests do not reach login-attempt creation/consumption, update
storage, durable receipts or socket upgrade. An account rejection can still
perform the authentication validation needed to establish its trusted key.

An exhausted bucket returns HTTP 429 with this JSON body:

```json
{"error":{"code":"rate_limited","message":"Too many requests. Retry after the indicated delay."}}
```

`Retry-After` is a positive integer number of seconds, rounded up. CORS exposes
it along with `Server-Timing`. Rejections retain `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. Missing trusted peer/user extensions fail closed
with a JSON 500; cookies, forwarding headers and account hints never substitute
for these keys.

Cloud uploads already treat 429 as retryable and use exponential backoff from
one to thirty seconds. A rejected batch keeps its exact UUID, bytes and local
generation until a matching durable receipt arrives. Socket upgrade failures
surface as transient connection failures in browsers (which cannot read the
handshake's HTTP headers); the existing reconnect backoff recovers. Neither
path treats a rejection or socket synchronization as a durability receipt.

## Deployment and storage

These quotas are **in process and per server**, not a cluster-wide limit.
With N independent instances, a client routed across them can obtain up to N
times the capacity/refill rate. Restarting a process resets its buckets. Deploy
an external shared limiter if a deployment requires a cluster-wide quota.

The server uses `into_make_service_with_connect_info<SocketAddr>` and trusts
only the TCP peer. There is currently no configured trusted-proxy boundary.
Behind a reverse proxy all clients share that proxy's peer buckets. Do not
switch to forwarded-header extraction without explicitly restricting and
validating the trusted proxy boundary; spoofed `Forwarded`, `X-Forwarded-For`
and `X-Real-IP` are ignored today.

Every sixty seconds, cleanup removes fully replenished keyed entries and
shrinks the stores. Thus idle identities are not retained indefinitely; active
entries remain until their quota replenishes. The cleanup task lives for the
production server runtime; isolated test routers do not spawn cleanup tasks. Account keys can only be
created for validated users, and peer keys only for actual transport peers.
The existing 64 live-socket permits and CRDT reconstruction worker semaphore
remain independent occupancy limits; request quotas never replace them.
