# Railway Test Deployment Guide

Deploy this fork as a **new Railway project with a new volume and a new domain**.
Your existing SillyTavern instance stays separate and continues running as it is.
This guide starts with empty test data; it is not a migration guide.

Verified against this fork and Railway documentation on 2026-09-25. Dashboard
labels may move slightly between Railway updates.

## What You Will Create

| Item | Setting for this test |
| --- | --- |
| Railway project | `sillytavern-login-test` |
| Service | `sillytavern-test` |
| GitHub source | [Remedy0316/SillyTavern](https://github.com/Remedy0316/SillyTavern) |
| Branch | `release` |
| Build | Existing root [Dockerfile](Dockerfile) |
| App port and domain target port | `8000` |
| Persistent volume | A newly created volume mounted at `/home/node/app/data` |
| Public URL | A newly generated Railway HTTPS domain |
| Authentication | New test credentials, Basic Auth login page enabled |
| User accounts | Disabled |
| Replicas | One |

The login feature was introduced in commit `1c6cf5341`. Deploy that commit or a
later commit on this fork's `release` branch that retains the feature.

## 1. Prepare

1. Sign in to Railway using the account that can access your GitHub fork.
2. Check that your Railway plan supports a running service and persistent volume.
   The test project has its own resource usage and can incur additional charges.
3. Open your password manager and create a **separate test login**, with a new
   username and a strong, randomly generated password. A 24-character or longer
   random password is a reasonable choice. Use a simple username without a colon
   so it also works with clients using HTTP Basic Auth.
4. Keep the credentials in your password manager. Enter them only in the new
   service's Railway Variables interface, not in GitHub or this guide.

All dashboard steps below apply to the **new test project**. Leave your current
project, volume, variables, and domain unchanged. Use fresh test content rather
than importing your real chats or characters during the initial checks.

## 2. Create an Empty Project and Service

1. From the Railway dashboard, choose **New Project**, then **Empty Project**.
2. Rename the project to `sillytavern-login-test`.
3. Inside that project's canvas, choose **New** or **Add**, then **Empty Service**.
   The command palette, opened with `Ctrl+K` on Windows, can also create services.
4. Rename the empty service to `sillytavern-test`.
5. Keep the new project's default environment. If Railway calls it `production`,
   that is just the environment name inside this separate test project; it is
   not your old deployed instance.

Start with an empty service so you can configure authentication and storage
before connecting the source. Generate the public domain only after Step 6.

## 3. Add the Service Variables

Open **sillytavern-test -> Variables**. Add the following values using the raw
editor, if available, or the individual variable fields.

This block contains configuration only. The two credential variables are added
separately below so there is no example password to accidentally deploy.

```dotenv
PORT=8000
SILLYTAVERN_PORT=8000
SILLYTAVERN_LISTEN=true
SILLYTAVERN_LISTENADDRESS_IPV4=0.0.0.0
SILLYTAVERN_DATAROOT=/home/node/app/data
SILLYTAVERN_BASICAUTHMODE=true
SILLYTAVERN_BASICAUTHLOGINPAGE=true
SILLYTAVERN_BASICAUTHLOGINSECURECOOKIE=true
SILLYTAVERN_BASICAUTHLOGINSESSIONHOURS=168
SILLYTAVERN_ENABLEUSERACCOUNTS=false
SILLYTAVERN_PERUSERBASICAUTH=false
SILLYTAVERN_WHITELISTMODE=false
SILLYTAVERN_DISABLECSRFPROTECTION=false
SILLYTAVERN_SECURITYOVERRIDE=false
SILLYTAVERN_SSL_ENABLED=false
SILLYTAVERN_BROWSERLAUNCH_ENABLED=false
SILLYTAVERN_RATELIMITING_BASICAUTHMAXATTEMPTS=5
SILLYTAVERN_RATELIMITING_PREFERREALIPHEADER=true
SILLYTAVERN_FORWARDEDHEADERS_XREALIP=true
SILLYTAVERN_FORWARDEDHEADERS_XFORWARDEDFOR=false
SILLYTAVERN_FORWARDEDHEADERS_CFCONNECTINGIP=false
```

Then add these two variables individually:

| Variable | Value to enter |
| --- | --- |
| `SILLYTAVERN_BASICAUTHUSER_USERNAME` | Your new test username |
| `SILLYTAVERN_BASICAUTHUSER_PASSWORD` | Your new strong test password |

Enter the actual credential value in the individual value field, without adding
wrapping quotes. Preserve any characters that are part of the password itself.
Double-check both values are set before connecting the repository. Omitting them
can leave ST using its bundled default credentials, which are unsuitable for a
public deployment.

### Why These Settings Matter

- `PORT` tells Railway which port to use, including for health checks.
  `SILLYTAVERN_PORT` tells ST which port to listen on. This fork does not use the
  generic `PORT` variable directly, so set both to `8000`.
- `0.0.0.0` allows Railway's proxy to reach ST inside the container. This is
  different from the loopback address used by the local preview.
- `SILLYTAVERN_WHITELISTMODE=false` disables ST's default localhost-only incoming
  IP whitelist. Otherwise a public browser may pass login and still be blocked.
  **Basic Auth remains enabled and is the access gate.**
- `SILLYTAVERN_SSL_ENABLED=false` means HTTP inside the container. Railway
  terminates public HTTPS. Keep `SILLYTAVERN_BASICAUTHLOGINSECURECOOKIE=true` so the
  browser sends the authentication cookie only over HTTPS.
- ST's normal CSRF protection remains enabled. There is no need to enable a
  security override, global proxy trust, or permissive CORS for this setup.
- `SILLYTAVERN_RATELIMITING_PREFERREALIPHEADER=true` gives each visitor their
  own failed-login counter. Without it, every request arrives from Railway's
  proxy address, so five wrong guesses from anyone lock out everyone, including
  you, for a minute. Railway's edge sets `X-Real-IP` to the client's address, so
  only that header is enabled; `X-Forwarded-For` and `CF-Connecting-IP` are
  turned off because a client can supply them itself.
- The session lifetime is seven days, measured from login. Restarting or
  redeploying the server also ends all login-page sessions.

For an initial login/UI test, you can optionally prevent automatic downloads of
local AI models by adding `SILLYTAVERN_EXTENSIONS_MODELS_AUTODOWNLOAD=false`.
This does not affect authentication, but local model-backed extension features
may need those downloads later.

## 4. Attach a New Persistent Volume

1. In the **test project's** canvas, right-click and choose the volume creation
   option, or use the command palette to search for **Create Volume**.
2. Create a new volume and attach it to `sillytavern-test`.
3. Set its mount path to exactly:

   ```text
   /home/node/app/data
   ```

4. Confirm that `SILLYTAVERN_DATAROOT` has exactly the same value.
5. Review and apply the staged changes when Railway prompts you.

This path comes from this repository's Dockerfile. Generic Railway examples may
use `/app/data`, but that is not the default location for this image. Mount the
data directory itself, not the application root, so the volume does not hide
the code inside the image.

### What This Volume Preserves

ST data under this path persists across redeployments: test chats, characters,
personas, settings, saved provider credentials, and user-scoped extension files.
Treat the volume as sensitive once you add any provider credentials.

The generated server configuration lives under `/home/node/app/config`, outside
this volume. In this setup, keep server configuration in Railway Variables;
manual edits to that container configuration are not persistent. Global
extensions under `/home/node/app/public/scripts/extensions/third-party` and
server plugins under `/home/node/app/plugins` are also outside this data volume.
For initial testing, use built-in extensions or user-scoped extension installs.

The authentication session store is intentionally in memory. A fresh login after
a redeployment is expected and does not mean your volume was lost.

## 5. Connect the Fork and Set Deployment Options

1. Open **sillytavern-test -> Settings -> Source** and choose **Connect Repo**.
2. Select **Remedy0316/SillyTavern**. This is the existing fork, not the upstream
   repository or a template pointing at a prebuilt upstream image.
3. If the fork is missing from the list, grant the Railway GitHub App access to
   it, then refresh the repository selector.
4. Select **release** as the deployment/trigger branch. Check the actual branch
   selected rather than relying on the repository's default.
5. Keep the source root at the repository root. Leave build and start-command
   overrides empty so Railway uses the existing Dockerfile and its entrypoint.
6. Set the replica count to **one**. The login session store is not shared across
   replicas.
7. For controlled testing, disable GitHub automatic deployments for this service.
   When you want an update, use **Deploy Latest Commit** in Railway's command
   palette. If you leave autodeploy enabled, each push to `release` may redeploy
   this test service and require you to sign in again.
8. Set the **Healthcheck Path** to `/basic-auth/login`. Keep the normal timeout
   initially; increase it only if logs show an otherwise healthy slow startup.

Connecting a repository can trigger a deployment. If that happens before the
settings above are complete, finish configuring the service and deploy again.
The public domain has not been generated yet.

The login page is deliberately public and returns 200 when the gate is available.
An authenticated ST endpoint such as `/api/users/me` is unsuitable as Railway's
unauthenticated health check. This check verifies startup availability, not every
ST feature, the persistence of your data, or the strength of your password.

## 6. Deploy and Inspect Startup

1. Review Railway's staged changes and deploy the test service. If everything is
   already applied, use **Deploy Latest Commit**.
2. In the build logs, confirm Railway is using the detected Dockerfile. It should
   install dependencies and compile the frontend.
3. In the runtime logs, look for ST listening on port **8000**, on **0.0.0.0**
   for IPv4. The selected data root should be `/home/node/app/data`.
4. Confirm the deployment becomes healthy/active and is not repeatedly restarting.
5. Review the source commit in the deployment details. It must include the login
   feature from `1c6cf5341` or a later compatible revision of the fork.

A first deployment can take several minutes. Railway mounts the volume at
runtime, not during the Docker build. Do not diagnose an empty build-time data
directory as a missing runtime volume.

If the process reports that `basicAuthLoginPage` requires particular settings,
check the exact names and values in Step 3. Keep authentication enabled while
correcting the configuration.

## 7. Generate a New HTTPS Domain

1. Open **sillytavern-test -> Settings -> Networking -> Public Networking**.
2. Choose **Generate Domain** and set/confirm its target port is **8000**.
3. Use the resulting `https://...up.railway.app` URL, or the Railway domain format
   shown in your dashboard. Keep this new domain separate from your old domain.
4. Add the new HTTPS address to the test login entry in your password manager.
5. Open the address in a private/incognito browser window first.

**Expected:** you see the dedicated SillyTavern login page. ST's chat interface
is not available until you authenticate. If the chat interface appears in a
fresh private session without credentials, stop testing, remove the new public
domain, and verify the deployed source and auth settings before exposing it again.

## 8. Check Login and the Access Gate

1. Enter the correct username with one deliberately wrong password. You should
   get an inline error and remain on the login page. Avoid repeated guesses;
   failed attempts are rate-limited.
2. Enter your new test credentials. You should enter ST, with a fresh profile or
   its first-run welcome screen.
3. In a separate private browser session with no login cookie, visit these URLs
   on the test domain:

   | Path | Expected without authentication |
   | --- | --- |
   | `/basic-auth/login` | Login page, HTTP 200 |
   | `/manifest.json` | Public app metadata, HTTP 200 |
   | `/img/apple-icon-192x192.png` | Bundled app icon, HTTP 200 |
   | `/api/users/me` | Authentication error, HTTP 401 |
   | `/api/settings/get` | Authentication error, HTTP 401, not private settings |
   | `/scripts/extensions.js` | Login redirect for browser navigation, or HTTP 401 for a programmatic request |

4. In your signed-in browser, open `/basic-auth/login` and select **Sign out**.
5. Reload `/api/users/me` in that browser. It should now return HTTP 401.
6. Sign in again and verify normal ST navigation and built-in extension loading.

Signing out revokes the browser's gate session. It cannot erase content already
downloaded to an open tab, so refresh when checking denial of access. Clients
that separately send valid HTTP Basic Auth credentials can still authenticate.

These checks verify the expected gate behavior; they are not a complete security
audit. Keep strong credentials, dependency updates, and platform protections in
place for any publicly reachable instance.

## 9. Check Persistence Before Adding Real Content

1. Give the test profile an obvious disposable persona name, such as
   `Railway volume test`, and save it. Alternatively, change and save a harmless
   theme setting you can easily recognize.
2. Reload ST and confirm the setting is saved.
3. In the **test service's** Deployments view, redeploy the current version.
4. Wait for the health check to pass, then reopen the test domain.
5. Sign in again. A new login is expected because the server restarted.
6. Confirm the disposable persona name or theme setting survived.

If saved settings disappear, stop here and check the volume attachment, mount
path, and `SILLYTAVERN_DATAROOT`. Do not import important data until persistence
works across a redeployment. Configure Railway volume backups before relying on
the new service for content you care about.

Once the gate and persistence checks pass, you can test a provider connection
with a restricted/test API key and a small spending limit. Test streaming with a
short disposable conversation and test uploads with a harmless sample file.
Provider usage may incur separate charges.

## 10. Check Password Managers and iPhone Home Screen

1. On desktop, save the test credentials for the new domain in your password
   manager, sign out, and confirm it fills both fields on the login page.
2. On iPhone, enable Apple Passwords or your chosen AutoFill provider, then open
   the **Railway HTTPS URL** in Safari. The Windows localhost preview address
   does not point to your computer when opened on the phone.
3. Tap both inputs. Text should remain readable without the usual small-input
   auto-zoom. Scrolling to keep an input above the keyboard is normal. Pinch zoom
   remains available.
4. Verify credential AutoFill, successful login, and the save-password prompt if
   your password manager offers one. OS/provider settings control these prompts.
5. Sign out, then use Safari's **Share -> Add to Home Screen** from the login page.
   Check the proposed app name and icon, then add it. Enable **Open as Web App**
   if your iOS version offers that option.
6. Launch the home-screen icon and sign in there if requested. Safari and the
   home-screen app may use separate sessions.
7. Close and reopen the home-screen app. With a valid session, it should return
   to ST; the manifest starts at `/` and covers both ST and the login route.
8. Redeploy the **test** service, reopen/reload the home-screen app, and confirm
   it returns to login and lets you sign in again.

If an already-open ST screen encounters an expired session, API requests return
401. Reload the app or open `/basic-auth/login` to sign in again. The login
feature does not add offline access or intercept every extension's error UI.

For a short expiry test, temporarily set
`SILLYTAVERN_BASICAUTHLOGINSESSIONHOURS=0.05` (three minutes), deploy, and sign in
again. After three minutes, a new protected request should require login. Return
the value to `168` and redeploy when finished. The time limit is absolute, not an
idle timeout.

## 11. Optional Security Hardening

The login page protects incoming requests. ST also has a separate filter for
outgoing requests to private IP addresses, to reduce SSRF exposure. For a test
instance that only uses public API providers, consider these additional values:

```dotenv
SILLYTAVERN_PRIVATEADDRESSWHITELIST_ENABLED=true
SILLYTAVERN_PRIVATEADDRESSWHITELIST_ALLOWUNRESOLVEDHOSTS=false
SILLYTAVERN_PRIVATEADDRESSWHITELIST_ALLOWEDRANGES=[]
```

These settings block private-address destinations, including loopback in this
example. If you later connect to a backend on a Railway private network, allow
only the specific private destinations you need and retest. This outbound filter
is different from the incoming `SILLYTAVERN_WHITELISTMODE` setting in Step 3.

The form-login rate limiter keys failed attempts by the `X-Real-IP` header that
Railway's edge sets, as configured in Step 3. If you remove
`SILLYTAVERN_RATELIMITING_PREFERREALIPHEADER=true`, it falls back to the socket
IP, which is Railway's proxy for every visitor, so all visitors share one limit.
Only enable forwarding headers that your proxy sets itself; do not enable
`X-Forwarded-For` or `CF-Connecting-IP` unless a proxy in front of ST overwrites
them. Keep the limiter enabled, and consider Railway edge protections where available
for additional protection against abusive traffic. Authentication cannot prevent
all denial-of-service attempts or undo a stolen session cookie.

## 12. Rollback and Finish Testing

To keep the new test service but return to the browser's original Basic Auth
prompt:

1. Keep `SILLYTAVERN_BASICAUTHMODE=true` and both credential variables unchanged.
2. Set `SILLYTAVERN_BASICAUTHLOGINPAGE=false`.
3. Clear the Railway health-check path before redeploying: `/basic-auth/login`
   will no longer be a public route in legacy mode. Leave health checking unset
   for this temporary rollback rather than using a protected endpoint.
4. Deploy and test in a fresh private window. The browser should request Basic
   Auth credentials before showing ST.

To re-enable the page, set the option back to `true` and restore the health-check
path to `/basic-auth/login` in the same staged deployment.

Keep your old instance unchanged until you have completed the checks and decided
how to migrate. Code rollback and data restore are separate operations; a volume
is not a backup. Before any future migration, back up the old instance and plan
its paths and credentials explicitly.

When finished with this disposable project, review its usage and billing. Remove
the test project and volume only after confirming you no longer need any data in
them. Removing a public domain alone does not stop service or storage charges.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Railway cannot find the fork | GitHub App repository access, then refresh the repository list. |
| Build does not use the Dockerfile | Source is this fork, root is the repository root, build override is empty. |
| Build fails before ST starts | Read the first build error. This guide has not verified a Railway image build; dependency, registry, or resource failures need their own diagnosis. |
| Deployment needs approval | Review and approve it in the new service's Deployments view. |
| Health check fails | Both port variables are `8000`, auth variables are set, login page is enabled, health-check path is `/basic-auth/login`. |
| Public URL returns 502 or cannot connect | Runtime is listening on `0.0.0.0:8000`; domain target port is `8000`; process is not restarting. |
| Browser Basic Auth popup instead of the new page | Deployed commit includes the feature; `SILLYTAVERN_BASICAUTHLOGINPAGE=true` was applied. Try a fresh private session to exclude cached Basic Auth. |
| Login succeeds but ST returns 403 | Incoming localhost-only whitelist is disabled for this setup. If the message says invalid CSRF token, reload ST instead of disabling CSRF protection. |
| Login returns 500 or "Authentication unavailable" | Both credential variables are nonempty strings; check service logs without sharing their values. |
| Cookie not retained or repeated sign-in | Use HTTPS, keep secure cookies enabled, allow cookies, use one replica, and check for repeated server restarts. |
| HTTP 429 during login | Stop attempts for about a minute. Shared proxy limits may affect several visitors; do not disable the limiter as a fix. |
| Settings disappear after redeploy | Fresh volume is attached to this service at `/home/node/app/data`, matching `SILLYTAVERN_DATAROOT`. |
| A global extension disappears | It was outside the data volume. Use a user-scoped install or plan separate persistence. |
| Home-screen launch or AutoFill behaves differently | Confirm HTTPS/domain matching, AutoFill provider settings, current deployed metadata, and retest a newly added home-screen icon on the actual iPhone. |

## Completion Checklist

- [ ] New project, service, volume, and domain are separate from the old instance.
- [ ] Fork's `release` branch is deployed using the existing Dockerfile.
- [ ] Test credentials are strong, saved privately, and distinct from the old login.
- [ ] Port variables, listener, and domain target all agree on `8000`.
- [ ] Data root and volume mount both equal `/home/node/app/data`.
- [ ] Login works; wrong credentials and signed-out API requests are rejected.
- [ ] Logout and server restart revoke sessions as expected.
- [ ] A saved disposable setting survives redeployment.
- [ ] Password-manager and iPhone home-screen checks are complete.
- [ ] Optional provider, streaming, upload, and extension checks use test data.
- [ ] Test-project usage and backup needs have been reviewed.
- [ ] Old deployment remains untouched.

## References

- [Fork login settings and implementation notes](README.md#optional-basic-auth-login-page)
- [Railway services and GitHub sources](https://docs.railway.com/guides/services)
- [Railway Dockerfile detection](https://docs.railway.com/guides/dockerfiles)
- [Railway variables](https://docs.railway.com/guides/variables)
- [Railway volumes](https://docs.railway.com/guides/volumes)
- [Railway health checks and ports](https://docs.railway.com/guides/healthchecks)
- [Railway public networking](https://docs.railway.com/guides/public-networking)
- [Railway GitHub automatic deployments](https://docs.railway.com/guides/github-autodeploys)