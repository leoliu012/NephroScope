#!/usr/bin/env python3
"""
manage_users.py — create and manage AGH Viewer accounts.

Passwords are never accepted on the command line (they would leak into shell
history and the process table). They are read interactively with getpass, or
piped on stdin for automation.

Examples
--------
    # Create the first account (prompts twice for the password):
    python manage_users.py add alice

    # Reset a password:
    python manage_users.py passwd alice

    # Non-interactive (e.g. from a provisioning script):
    printf '%s' "$NEW_PASSWORD" | python manage_users.py add bob --stdin

    # List / disable / enable / remove:
    python manage_users.py list
    python manage_users.py disable bob
    python manage_users.py enable bob
    python manage_users.py remove bob

The account store location comes from the same configuration the API uses
(AGH_USERS_FILE / AGH_STATE_DIR), so running this on the server with the
service environment targets the right file. Override explicitly with
--users-file if needed.
"""
import argparse
import getpass
import os
import sys
from pathlib import Path

# Allow running as "python manage_users.py" from the backend directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from agh_api.audit import AuditLog  # noqa: E402
from agh_api.auth import ROLES, UserError, UserStore  # noqa: E402
from agh_api.config import Config  # noqa: E402


def _default_users_file() -> Path:
    # Resolve the same path the running service would use.
    local_dev = os.environ.get("AGH_LOCAL_DEV", "").lower() in {"1", "true", "yes"}
    if local_dev:
        return Config.local_dev(Path(__file__).resolve().parent).users_file
    return Config.from_env().users_file


def _default_config() -> Config:
    local_dev = os.environ.get("AGH_LOCAL_DEV", "").lower() in {"1", "true", "yes"}
    if local_dev:
        return Config.local_dev(Path(__file__).resolve().parent)
    return Config.from_env()


def _audit_actor() -> str:
    return os.environ.get("USER") or os.environ.get("USERNAME") or "manage_users.py"


def _audit(store: UserStore, action: str, result: str = "success", **details) -> None:
    try:
        cfg = _default_config()
        if Path(store.path).resolve() != Path(cfg.users_file).resolve():
            return
        AuditLog(cfg.audit_log_file).record(
            actor=_audit_actor(),
            action=action,
            result=result,
            details=details or None,
        )
    except Exception:
        pass


def _read_password(from_stdin: bool, confirm: bool) -> str:
    if from_stdin:
        password = sys.stdin.readline().rstrip("\n")
        if not password:
            raise UserError("No password received on stdin")
        return password
    password = getpass.getpass("New password: ")
    if confirm:
        again = getpass.getpass("Confirm password: ")
        if password != again:
            raise UserError("Passwords did not match")
    return password


def cmd_add(store: UserStore, args) -> int:
    password = _read_password(args.stdin, confirm=not args.stdin)
    require_profile = bool(args.first_name or args.last_name)
    name = store.add(args.username, password, allow_update=args.force, first_name=args.first_name, last_name=args.last_name, require_profile=require_profile)
    if args.role:
        store.set_role(name, args.role)
    print(f"Created account: {name}")
    return 0


def cmd_passwd(store: UserStore, args) -> int:
    password = _read_password(args.stdin, confirm=not args.stdin)
    name = store.set_password(args.username, password)
    print(f"Updated password for: {name}")
    return 0


def cmd_disable(store: UserStore, args) -> int:
    name = store.set_disabled(args.username, True)
    print(f"Disabled account: {name}")
    return 0


def cmd_enable(store: UserStore, args) -> int:
    name = store.set_disabled(args.username, False)
    print(f"Enabled account: {name}")
    return 0


def cmd_role(store: UserStore, args) -> int:
    name = store.set_role(args.username, args.role)
    _audit(store, "CHANGE_ROLE", username=name, role=args.role)
    print(f"Updated role for: {name}")
    return 0


def cmd_remove(store: UserStore, args) -> int:
    if not args.yes:
        confirm = input(f"Remove account '{args.username}'? [y/N] ").strip().lower()
        if confirm not in {"y", "yes"}:
            print("Aborted.")
            return 1
    name = store.remove(args.username)
    _audit(store, "DELETE_ACCOUNT", username=name)
    print(f"Removed account: {name}")
    return 0


def cmd_list(store: UserStore, args) -> int:
    users = store.list_users()
    if not users:
        print("No accounts defined yet. Create one with: manage_users.py add <username>")
        return 0
    width = max(len(u["username"]) for u in users)
    for user in users:
        status = "disabled" if user["disabled"] else "active"
        print(f"{user['username']:<{width}}  {status:<8}  {user['role']:<12}  {user['displayName']:<24}  created {user['createdAt']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage AGH Viewer accounts.")
    parser.add_argument(
        "--users-file",
        default=None,
        help="Path to the account store (defaults to the service configuration).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="Create a new account.")
    p_add.add_argument("username")
    p_add.add_argument("--stdin", action="store_true", help="Read the password from stdin.")
    p_add.add_argument("--force", action="store_true", help="Overwrite if the user exists.")
    p_add.add_argument("--role", choices=sorted(ROLES), default="annotator", help="Initial role.")
    p_add.add_argument("--first-name", default="", help="User's first name.")
    p_add.add_argument("--last-name", default="", help="User's last name.")
    p_add.set_defaults(func=cmd_add)

    p_passwd = sub.add_parser("passwd", help="Set a new password for an existing account.")
    p_passwd.add_argument("username")
    p_passwd.add_argument("--stdin", action="store_true", help="Read the password from stdin.")
    p_passwd.set_defaults(func=cmd_passwd)

    p_disable = sub.add_parser("disable", help="Disable an account without deleting it.")
    p_disable.add_argument("username")
    p_disable.set_defaults(func=cmd_disable)

    p_enable = sub.add_parser("enable", help="Re-enable a disabled account.")
    p_enable.add_argument("username")
    p_enable.set_defaults(func=cmd_enable)

    p_role = sub.add_parser("role", help="Set an account role.")
    p_role.add_argument("username")
    p_role.add_argument("role", choices=sorted(ROLES))
    p_role.set_defaults(func=cmd_role)

    p_remove = sub.add_parser("remove", help="Delete an account.")
    p_remove.add_argument("username")
    p_remove.add_argument("-y", "--yes", action="store_true", help="Do not prompt for confirmation.")
    p_remove.set_defaults(func=cmd_remove)

    p_list = sub.add_parser("list", help="List accounts.")
    p_list.set_defaults(func=cmd_list)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    users_file = Path(args.users_file).expanduser() if args.users_file else _default_users_file()
    store = UserStore(users_file)

    try:
        return args.func(store, args)
    except UserError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
