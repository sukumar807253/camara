# Fieldlink

Fieldlink is a private, consent-based WebRTC camera stream between one Android phone and one viewer. The signaling service pairs only the mobile and viewer credentials created together for a session. Video and audio are not recorded or uploaded; audio capture is disabled. Mobile camera access is requested only after the user presses **Allow camera**.

WebRTC media is DTLS-SRTP encrypted between the two peers. A TURN server relays encrypted packets when a direct route is unavailable; the application does not operate a TURN service. STUN alone cannot make every carrier/NAT combination connect.

## Requirements

- Node.js 20 or newer and npm
- A public domain and HTTPS certificate for real Android-to-laptop use
- A coturn server for relay connectivity across restrictive NATs/mobile carriers

Camera access is available on `localhost` during local development. A phone opening an HTTP address on the LAN is not a secure browser context; use HTTPS for device testing.

## Local setup

```sh
cp .env.example .env
```

Set a unique secret in `.env`:

```sh
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 48)|" .env
```

Install, verify, and run:

```sh
npm install
npm run check
npm test
npm start
```

Open <http://localhost:3000>. Local camera capture works in browsers that treat localhost as a secure context. The default configuration uses public Google STUN only, so a failed direct route is expected until TURN is configured. If port 3000 is occupied, run with `PORT=3100 BASE_URL=http://localhost:3100 npm start` and open <http://localhost:3100>.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port for the Node service; default `3000` |
| `HOST` | Bind address; defaults to `0.0.0.0` for Render and other web-service platforms |
| `BASE_URL` | Optional public origin for invitation links; must be HTTPS in production. Render's `RENDER_EXTERNAL_URL` is used when this is unset |
| `SESSION_SECRET` | Long, random secret used to key token digests; required in production |
| `SESSION_TTL_SECONDS` | Absolute invitation/session lifetime; defaults to 1800, bounded to 60–86400 seconds |
| `STUN_URL` | Comma-separated `stun:` / `stuns:` URLs; defaults to Google's public STUN endpoint |
| `TURN_URL` | Comma-separated `turn:` / `turns:` URLs; leave empty to disable TURN |
| `TURN_USERNAME`, `TURN_PASSWORD` | Static coturn credentials when shared-secret auth is not used; returned only to an authorized session client |
| `TURN_SHARED_SECRET` | Optional coturn `static-auth-secret`; preferred, issues time-limited browser credentials |
| `NODE_ENV` | Set to `production` to require HTTPS and enable HSTS |
| `TRUST_PROXY` | Set to `1` only when the Node port is reachable exclusively through a trusted, single-hop TLS reverse proxy |

Never commit `.env`. Static TURN credentials can be extracted by an authorized browser user; use `TURN_SHARED_SECRET` with coturn REST authentication where possible. TURN credentials are delivered only through the session-authenticated ICE endpoint and are not logged by this application. Invitation tokens are carried in URL fragments, which browsers do not send in HTTP requests or referrers.

## Render Deployment

The repository includes [render.yaml](render.yaml) as a Render Blueprint. In Render, create a new Blueprint from this repository and deploy the `fieldlink` web service. The Blueprint configures:

- **Build Command:** `npm ci`
- **Start Command:** `npm start`
- **Health Check Path:** `/healthz`
- `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, and a generated `SESSION_SECRET`

Render supplies `PORT` and `RENDER_EXTERNAL_URL`; do not set a fixed port. The app treats `RENDER_EXTERNAL_URL` as a production deployment signal and binds to `0.0.0.0` even if `HOST` is overridden, trusts Render's HTTPS reverse proxy when `TRUST_PROXY=1`, and rejects a production URL that is not public HTTPS. The generated Render service URL is used for invitation links; set `BASE_URL=https://your-custom-domain` only when using a custom domain.

The Blueprint leaves `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD`, and `TURN_SHARED_SECRET` as unsynced environment variables. Leave them blank to run without TURN; the dashboard and viewer show that relay is unavailable. To enable it, enter the URL(s) and matching coturn credentials. Prefer coturn shared-secret auth with `TURN_SHARED_SECRET`. Include UDP and TCP/TLS URL variants as supported by your coturn host, for example `turn:relay.example.net:3478?transport=udp,turns:relay.example.net:5349?transport=tcp`. A configured URL/credential pair does not prove that TURN is reachable; confirm a selected `relay` ICE candidate from an external network.

To configure the service manually instead of using the Blueprint, choose **Web Service**, set the runtime to **Node**, and use the exact build, start, and health-check values above. Set `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, `SESSION_TTL_SECONDS=1800`, and a random `SESSION_SECRET` of at least 32 characters. `STUN_URL` may be left at the default. Add `BASE_URL` only for a custom public origin; Render's `RENDER_EXTERNAL_URL` is otherwise used automatically. Do not copy or upload `.env`; `.gitignore` excludes it. Never add secrets to the repository or frontend JavaScript.

The service currently stores sessions in process memory, so use one Render instance. Deploy restarts invalidate active invitations. Render hosts the signaling/application service; coturn must be provided separately because the relay needs its own public UDP/TCP ports. Real Android-to-laptop streaming still requires a public HTTPS URL, camera permission on the phone, a reachable viewer, and working TURN for network paths that cannot connect directly.

## Coturn

Install coturn on a public server and configure it with a publicly trusted certificate. A minimal shared-secret configuration is:

```ini
listening-port=3478
tls-listening-port=5349
realm=turn.example.com
fingerprint
use-auth-secret
static-auth-secret=USE_THE_SAME_RANDOM_VALUE_AS_TURN_SHARED_SECRET
no-cli
no-multicast-peers
no-loopback-peers
min-port=49160
max-port=49200
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

Set the matching secret in the app environment as `TURN_SHARED_SECRET`. Set, for example:

```dotenv
TURN_URL=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_USERNAME=camera
```

Open the relevant firewall ports: TCP/UDP 3478, TCP 5349, and UDP 49160–49200. If coturn is behind NAT, configure its external address and relay interface according to the coturn documentation. Test both UDP and TLS/TCP paths from an external mobile network. The viewer reports the selected local and remote ICE candidate types; `relay` confirms that the negotiated path is using TURN, while `host` and `srflx` indicate direct candidates.

## Other Production Deployment

1. Point a DNS name to the application host and obtain a TLS certificate (for example, with Certbot and Nginx).
2. Keep the Node port private to the host or firewall it so only the reverse proxy can reach it. Proxy HTTP and WebSocket traffic to the configured Node port and preserve the `Upgrade` and `Connection` headers.
3. Configure the production environment:

```dotenv
NODE_ENV=production
PORT=3000
BASE_URL=https://camera.example.com
SESSION_SECRET=your-generated-random-value
SESSION_TTL_SECONDS=1800
TRUST_PROXY=1
TURN_URL=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_USERNAME=camera
TURN_SHARED_SECRET=the-coturn-static-auth-secret
```

4. Install dependencies and start under a process manager such as systemd:

```sh
npm ci --omit=dev
npm start
```

Store environment values in the service manager or a root-readable environment file. Do not expose the Node port publicly when `TRUST_PROXY=1`; the app trusts one proxy hop for HTTPS detection and client IP rate limits. Keep Node, the reverse proxy, coturn, and the TLS certificates updated. HTTPS signaling protects invitation credentials in transit; invitation URLs are bearer secrets, so share them privately.

The application stores sessions in process memory. Restarting the process invalidates every active invitation. Use a single application process unless you add shared session storage and Socket.IO affinity; the current code intentionally has no public or shared signaling service.

## Test guide

1. **Laptop Wi-Fi + phone mobile data:** deploy behind HTTPS, configure TURN, create a session on the laptop, open the phone invitation over cellular data, and press **Allow camera**. Open the viewer link and confirm live video.
2. **Permission denied:** deny the browser prompt. Confirm a clear error appears, no preview starts, and the browser remains able to retry after permission is changed.
3. **Permission allowed:** allow access and verify the preview and viewer stream. Confirm the browser shows its camera-use indicator and audio remains off.
4. **TURN relay:** inspect **Selected ICE candidates** in the viewer. Force a network path that requires relay or temporarily block direct UDP in a controlled test; verify a candidate type is `relay`. A configured TURN URL alone does not prove that the relay works.
5. **Network disconnection:** disable mobile data or Wi-Fi while streaming. Confirm the status changes and the viewer reports interruption.
6. **Reconnection:** restore connectivity or press **Reconnect** on the viewer. Confirm the stream renegotiates; if ICE remains failed, create a fresh session.
7. **Expired links:** set a short `SESSION_TTL_SECONDS`, wait for expiry, and confirm the mobile/viewer links are rejected.
8. **Unauthorized viewer:** change or remove the viewer token and confirm Socket.IO authentication and the ICE endpoint reject access. Confirm the separate mobile token cannot authenticate as a viewer.

Automated checks cover token-role separation, token rejection, expiry, and cleanup. Cross-network, permission prompts, TURN relay, and browser media behavior require the real-device checks above.