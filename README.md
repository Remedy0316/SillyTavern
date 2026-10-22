# SillyTavern

LLM Frontend for Power Users

## Optional Basic Auth Login Page

For a separate Railway test project, follow the
[step-by-step deployment guide](RAILWAY-DEPLOY.md).

This fork includes a little standalone login page for single-user deployments.
It is disabled by default and requires an **Argon2id password hash**. Your actual
password stays out of Railway Variables; sign in with it as usual. 🌸

### Set Up Your Password

1. Install the root dependencies locally, then run `npm run hash-password`.
   Enter a new, strong password twice in the hidden terminal prompt. The helper
   prints only the salted hash; it does not save your password or accept it as a
   command-line argument.
2. Set `SILLYTAVERN_BASICAUTHUSER_USERNAME` to your username and
   `SILLYTAVERN_BASICAUTHUSER_PASSWORDHASH` to the complete generated hash. Paste
   it into Railway's individual variable value field, without wrapping quotes.
3. **Delete `SILLYTAVERN_BASICAUTHUSER_PASSWORD`**, including an empty variable
   with that name. The dedicated login page refuses to start while it exists.
4. Apply these variable changes together with the updated deployment. Existing
   login-page installations need this migration before the new version can start.

Use a new password if the previous one may have been exposed. Hashing the old
password does not undo an earlier leak. Remove any custom plaintext password
from your configuration file too. Do not share your password in chat or use an
online hash generator.

The equivalent configuration keys are `basicAuthUser.username` and
`basicAuthUser.passwordHash`; environment variables take priority. A missing or
invalid hash blocks login-page startup, with no plaintext fallback. The helper
uses Argon2id v19, 64 MiB, three iterations, one lane, and a random 16-byte salt.
Accepted hashes use 19–64 MiB, 2–6 iterations, 1–4 lanes, 16–64-byte salts, and
32–64-byte outputs. Passwords may contain up to 1024 UTF-8 bytes. Verification
allows at most two concurrent checks per process; busy attempts return HTTP 429.
Authenticated cookie requests do not repeat password hashing.

To enable the page on Railway, set:

```text
SILLYTAVERN_BASICAUTHLOGINPAGE=true
SILLYTAVERN_BASICAUTHLOGINSECURECOOKIE=true
SILLYTAVERN_RATELIMITING_PREFERREALIPHEADER=true
SILLYTAVERN_FORWARDEDHEADERS_XREALIP=true
SILLYTAVERN_FORWARDEDHEADERS_XFORWARDEDFOR=false
SILLYTAVERN_FORWARDEDHEADERS_CFCONNECTINGIP=false
```

The last four lines give each visitor a separate failed-login counter, using the
`X-Real-IP` header that Railway's edge sets. Without them, all visitors share
Railway's proxy address, so a few wrong guesses from anyone lock everyone out
for a minute.

The existing `listen` and `basicAuthMode` settings must be enabled, and
`enableUserAccounts` and `perUserBasicAuth` must remain disabled. Unsupported
combinations stop startup rather than bypass authentication. The same options
can be added to your active configuration file:

```yaml
basicAuthLoginPage: true
basicAuthLoginSecureCookie: true
basicAuthLoginSessionHours: 168
```

`basicAuthLoginSessionHours` defaults to 168 (seven days), accepts values above
zero up to 720, and is an absolute lifetime, not an idle timeout. Its environment
variable is `SILLYTAVERN_BASICAUTHLOGINSESSIONHOURS`. Keep secure cookies enabled
on public deployments. They work with Railway's HTTPS termination without
enabling global proxy trust. For loopback-only HTTP testing, explicitly set
`basicAuthLoginSecureCookie: false`.

### Access and Sessions

- Unauthenticated visitors can reach only `/basic-auth/login`, its explicitly
	listed assets, the shared `/manifest.json` and its six bundled app icons,
	and the gate's session, login, and logout endpoints. All other
	application routes, APIs, static files, and extension routes remain behind
	server-side authentication. The login page loads only bundled assets.
- Login and logout require short-lived CSRF proof. ST's own CSRF protection
	remains unchanged and should stay enabled.
- Successful login creates a random, HttpOnly, host-only session cookie. The
	server stores sessions in memory, without storing the password in the cookie.
	Sessions expire on timeout, server restart/redeployment, credential change,
	or logout. Configuration-file changes require a restart, as usual in ST.
- Visit `/basic-auth/login` while signed in to access **Sign out**. Logout
	revokes that browser session server-side, including access from other tabs
	using it. Already downloaded content and in-flight requests cannot be recalled.
- Existing clients sending valid Basic Auth headers still work. Logging out of
	a cookie session does not revoke a client's valid Basic Auth credentials or
	clear credentials previously cached by a browser. A private window avoids
	previously cached Basic Auth when trying the new page.
- Failed form and Basic-header attempts share `rateLimiting.basicAuthMaxAttempts`
	(default: five per minute). This mode requires a positive integer. Attempts
	are counted per socket IP by default. With `rateLimiting.preferRealIpHeader`
	enabled, they are counted per client IP from the headers enabled under
	`forwardedHeaders`, the same as upstream Basic Auth. Enable only headers your
	proxy overwrites (on Railway, `X-Real-IP`). Platform-level rate limiting is recommended
	for additional protection against public traffic and denial of service.
- This mode is intended for one running ST instance. Multiple replicas would
	require a shared session store. Redeployments require signing in again.
- On expiry, APIs return HTTP 401 rather than login HTML. Open the login page
	and sign in again; no global frontend or extension interception is added.

Switch `basicAuthLoginPage` off and restart to return to browser Basic Auth,
which also accepts the same hash. A configured hash always overrides the old
plaintext setting, including the bundled default; malformed hashes never fall
back. Upstream plaintext Basic Auth remains available only when the dedicated
page is off and no hash is configured. Per-user account authentication is unchanged.
Before changing a Railway deployment source, back up the persistent
volume and verify its mount path still matches the configured data directory.
If you use a Railway health check, `/basic-auth/login` is a public, read-only
path suitable for that check. Existing protected health-check paths still
require authentication.

### Password Managers and iOS

The login form uses standard username/current-password autofill attributes and
keeps filled fields intact until successful navigation. Saved credentials should
match your deployed domain. On iOS, enable your chosen password manager as an
AutoFill provider. Autofill and save-password prompts depend on the browser and
provider; they still need verification on your device.

The login page links the same manifest as ST, includes Apple home-screen metadata,
and can be used as the entry page for Add to Home Screen. Both login and ST remain
within the manifest's root scope, with `/` as the launch URL. Only the exact
manifest and bundled icon paths are public; this adds no access to ST content or
APIs and does not add offline caching. Use your HTTPS deployment on the phone.

Safari and an installed home-screen app may have separate login sessions. After
a server restart or session expiry, launching or reloading the app returns to
login. Expiry while ST is already open still requires reloading or opening the
login page. Home-screen installation, relaunch, and AutoFill should be tested on
a physical iPhone; desktop emulation does not verify these OS features.

Login inputs remain at 16px to avoid the usual Safari input-focus zoom, while
pinch zoom stays enabled. Keyboard positioning and device accessibility settings
can still affect the viewport.

### Verification

With the root and test dependencies installed, run:

```sh
npm --prefix tests run test:unit -- --runInBand basic-auth.test.js basic-auth-password.test.js basic-auth-legacy.test.js basic-auth-startup.test.js
```

Tests cover unauthenticated access, asset allowlisting, CSRF, rate limiting,
cookie security, session revocation/expiry, credential changes, Basic headers,
redirect validation, upload/stream passthrough, middleware ordering, PWA metadata
access, password-manager-friendly submission, hash-only authentication, hash
rotation, bounded verification, the hidden local password prompt, and actual
server startup with missing hashes or leftover plaintext variables.

## Resources

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
