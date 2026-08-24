# Security & Accounts

This document describes how NephroScope authenticates people and how to
manage accounts.

## Model at a glance

- **Per-user accounts.** Everyone has their own username and password. There
  is no shared credential. Passwords are stored only as salted
  **PBKDF2-HMAC-SHA256** hashes (via Werkzeug), never in plaintext.
- **Session cookies.** Logging in exchanges the password for a random,
  256-bit **opaque session token**, delivered as an `HttpOnly`,
  `SameSite=Strict`, `Secure` (over HTTPS) cookie scoped to `/agh`. The
  password is sent exactly once, at login, and is never stored in the browser.
  Only the SHA-256 of the token is persisted server-side, so reading the
  session store never yields a usable token.
- **Expiry and revocation.** Sessions have an absolute lifetime
  (`AGH_SESSION_TTL_SECONDS`, default 12h) and an idle timeout
  (`AGH_SESSION_IDLE_SECONDS`, default 8h). Logout deletes the session
  server-side immediately.
- **CSRF protection.** Each session carries a CSRF token returned to the SPA
  in JSON (from `/login` and `/session`). State-changing requests (`PUT`, etc.)
  must echo it in the `X-AGH-CSRF` header. Combined with the `SameSite=Strict`
  cookie, cross-site requests cannot forge writes.
- **Brute-force protection.** Failed logins are counted per client IP and per
  username in a small file-backed store; after `AGH_LOGIN_MAX_ATTEMPTS`
  (default 8) within `AGH_LOGIN_WINDOW_SECONDS` the account/IP is locked for
  `AGH_LOGIN_LOCKOUT_SECONDS`. The file-backed counter is consistent across
  the Gunicorn workers.
- **Trustworthy attribution.** Annotation `updatedBy` is stamped from the
  authenticated session, not from any client-supplied header or body field.

Authentication is enforced by the Flask API, not by Apache. Apache must **not**
add `AuthType Basic` for `/agh` or `/agh/api`, or browsers show a native
credential popup ahead of the app's own login screen.

## Managing accounts

Accounts live in a JSON store at `AGH_USERS_FILE` (default
`$AGH_STATE_DIR/users.json`, mode 600). Manage them with
`backend/manage_users.py`, which reads passwords interactively (never from the
command line, so they don't leak into shell history or the process table).

Run the CLI with the same environment the service uses so it targets the right
store. On the production server:

```bash
cd /home/ubuntu/agh-viewer/backend
export AGH_STATE_DIR=/home/ubuntu/agh-viewer/state
VENV=/home/ubuntu/agh-viewer/venv/bin/python
```

### Create an account

```bash
$VENV manage_users.py add alice
# New password: ********
# Confirm password: ********
# Created account: alice
```

Passwords must be at least 10 characters by default. To change that minimum
(for example, a low value on a throwaway demo instance), set
`AGH_MIN_PASSWORD_LENGTH` in the environment used to run the CLI and the
server. The person can then sign in at
`/agh/` with that username and password.

### Other operations

```bash
$VENV manage_users.py list                 # show accounts and status
$VENV manage_users.py passwd alice         # reset a password (prompts)
$VENV manage_users.py disable alice        # block sign-in without deleting
$VENV manage_users.py enable  alice        # re-enable
$VENV manage_users.py remove  alice        # delete (prompts unless -y)
```

Non-interactive provisioning (e.g. from a script) can pipe the password on
stdin:

```bash
printf '%s' "$GENERATED_PASSWORD" | $VENV manage_users.py add bob --stdin
```

### Local development

```bash
cd backend
AGH_LOCAL_DEV=1 python manage_users.py add me   # state under backend/.local_data/state
AGH_LOCAL_DEV=1 python app.py                    # sign in at the login screen
```

Set `AGH_AUTH_REQUIRED=0` to bypass login entirely while developing.

## Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGH_STATE_DIR` | `~/.agh-viewer` | Base dir for `users.json`, `sessions/`, `login_attempts.json` |
| `AGH_USERS_FILE` | `$AGH_STATE_DIR/users.json` | Account store path |
| `AGH_SESSION_DIR` | `$AGH_STATE_DIR/sessions` | Server-side session records |
| `AGH_AUTH_REQUIRED` | `1` | Enforce authentication (`0` disables, dev only) |
| `AGH_MIN_PASSWORD_LENGTH` | `10` | Minimum length for new/changed passwords (min 1) |
| `AGH_SESSION_TTL_SECONDS` | `43200` | Absolute session lifetime |
| `AGH_SESSION_IDLE_SECONDS` | `28800` | Idle timeout (`0` disables) |
| `AGH_COOKIE_SECURE` | `auto` | `auto` marks the cookie Secure when the request is HTTPS; `true`/`false` force it |
| `AGH_ALLOW_BASIC_AUTH` | `0` | Opt-in HTTP Basic (against the same account store) for automation |
| `AGH_LOGIN_MAX_ATTEMPTS` | `8` | Failures per IP/username before lockout |
| `AGH_LOGIN_WINDOW_SECONDS` | `900` | Failure-counting window |
| `AGH_LOGIN_LOCKOUT_SECONDS` | `900` | Lockout duration |

## HTTPS and cookies

`AGH_COOKIE_SECURE=auto` marks the session cookie `Secure` only when the
backend sees an HTTPS request. Apache forwards the original scheme via
`X-Forwarded-Proto`, so terminate TLS at Apache (or reach the server over
WireGuard/Tailscale with an HTTPS vhost) in production. If you deliberately run
plain HTTP on a trusted private network, the cookie is still `HttpOnly` and
`SameSite=Strict`; only the `Secure` flag is omitted.

## Migrating from the old shared password

Earlier versions used a single shared Basic-Auth credential and an
unsalted-SHA1 htpasswd file. That mechanism has been removed. To migrate:

1. Deploy this version.
2. Create an account per person with `manage_users.py add`.
3. Remove the obsolete `/etc/apache2/.agh-viewer.htpasswd` file and any
   `AGH_BASIC_AUTH_USER` / `AGH_BASIC_AUTH_PASSWORD` / `AGH_HTPASSWD_FILE`
   values from the environment.

## Operational notes

- **Back up `users.json`** — it is the source of truth for accounts. It
  contains only salted hashes, but losing it means recreating accounts.
- Session and login-attempt files are disposable; deleting them logs everyone
  out and clears lockouts. They are recreated automatically.
- Rotate a person's access by `disable`/`remove`; existing sessions expire at
  the TTL/idle bound, or delete the contents of `$AGH_SESSION_DIR` to force an
  immediate global logout.
