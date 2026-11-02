# synology-mcp

MCP server for managing a Synology NAS (DSM 7) from Claude or any other MCP client: system health, disks, files, Container Manager, accounts, security, Photos, Drive and any other DSM API your NAS offers.

**Status: early (0.1.0).** It is tested against a simulated DSM. On a real NAS, only API discovery and certificate pinning have been confirmed so far, without logging in. See [Verification status](#verification-status).

- **Only the tools that apply.** At startup the server reads the NAS's own API list (`SYNO.API.Info`, no login needed) and hides whatever isn't installed, so a package you don't have costs no context.
- **2FA without repeated codes.** `setup` exchanges one code for a trusted-device token, stored in the Keychain.
- **The NAS's certificate is pinned.** DSM's default certificate is self-signed. Instead of turning verification off, its fingerprint is pinned and checked on every connection, before the password is sent.
- **It won't get your IP blocked.** Refused credentials are never sent again, so they can't trip DSM's Auto Block.
- **Risky changes ask first.** Deleting, sharing publicly or stopping a package returns a preview before anything happens.
- **Any DSM API.** `dsm_api_search` and `dsm_read` reach every API on the NAS, including those with no dedicated tool.

## Install and connect

Requires Node 22 or newer.

```bash
npm install -g github:joaomelorodrigues/synology-mcp
synology-mcp setup --url https://nas.example.com:5001
```

To update, run the first command again. Settings and secrets live outside the package, so they are kept.

`setup` shows the NAS's certificate and asks to pin it, then asks for the username, the password (hidden), the permission tier and the 2FA code. It finishes by printing the command that connects your client, for example:

```bash
claude mcp add --scope user synology -- /path/to/node /path/to/dist/index.js serve
```

To check the connection and try the read tools against your NAS:

```bash
synology-mcp doctor
```

The report contains no secrets.

> The port is part of the address. DSM uses 5001 (HTTPS) and 5000 (HTTP) by default, and ports 443 and 80 may be serving Web Station instead. If the address you give isn't DSM, `setup` tries the usual ports. You can find yours in Control Panel > Login Portal.
>
> If the NAS is only reachable over a VPN, tools return an error saying so while the VPN is down, and work again once it's back.
>
> The `claude mcp add` command that `setup` prints points at your current Node version. If you use nvm and switch versions, install again and rerun that command.

## Permission tiers

The tier is set with `tier`. Tools above it are never registered, so the model has no way to call them by mistake.

| Tier | What it allows |
|---|---|
| `read` (default) | Queries only. Download tools can also save to this computer, inside `localRoots` |
| `write` | Files, containers, packages, scheduled tasks, backups, photo albums, downloads and VMs. Deleting asks for confirmation |
| `admin` | Also accounts, shared folders, file services, reverse proxy rules and `dsm_write` |
| `allowPower: true` | Separate from the tiers: reboot, shut down and install DSM updates |

At any tier, secrets (OTP, encryption keys, account recovery) and changes to the disk layout (creating, deleting or repairing pools and volumes) stay out of reach. Those are left to DSM itself.

## Configuration

Settings live in `~/.config/synology-mcp/config.json`, which holds no secrets. Environment variables take priority; see [.env.example](.env.example).

```json
{
  "url": "https://nas.example.com:5001",
  "username": "mcp-admin",
  "tier": "write",
  "allowPower": false,
  "modules": "all",
  "certFingerprint": "AB:CD:EF:...",
  "localRoots": ["~/Downloads"],
  "protectedPaths": ["/backups"],
  "instructions": "Backups are in /backups. Always confirm before touching /docker."
}
```

| Field | Effect |
|---|---|
| `modules` | `"all"`, or a list of: `system`, `storage`, `files`, `docker`, `packages`, `accounts`, `services`, `security`, `network`, `backup`, `scheduler`, `photos`, `drive`, `downloads`, `vm`, `surveillance`, `generic` |
| `localRoots` | Folders on this computer that upload and download tools may use. Symlinks and `..` are resolved before checking |
| `protectedPaths` | NAS paths that no tool may change or delete |
| `instructions` | Extra text for the model about this NAS |
| `maxOutputChars` | Maximum size of a reply; 40,000 by default |

The server reads its settings at startup, so restart your MCP client after changing them.

## Tools

`synology-mcp tools --hidden` lists this connection's tools and their context cost. On a NAS with Container Manager, Photos and Drive, but without Hyper Backup, Download Station, VMM or Surveillance Station, that is 57 tools at `read` (about 8k tokens), 77 at `write` (12k) and 89 at `admin` (14k).

| Area | Read | Write |
|---|---|---|
| Overview | `nas_overview`, `nas_capabilities`, `system_info`, `system_load`, `system_processes`, `system_connections`, `system_logs`, `system_network`, `system_hardware`, `dsm_update_status` | `nas_power`, `dsm_update_install` |
| Storage | `storage_overview`, `storage_disk`, `storage_volume_usage`, `storage_schedules`, `storage_snapshots`, `iscsi_list` | |
| Files | `files_shares`, `files_list`, `files_info`, `files_search`, `files_dir_size`, `files_md5`, `files_read`, `files_download`, `files_task_status`, `files_links` | `files_write`, `files_upload`, `files_mkdir`, `files_rename`, `files_copy_move`, `files_delete`, `files_compress`, `files_extract`, `files_task_stop`, `files_link_create`, `files_link_delete` |
| Container Manager | `docker_containers`, `docker_container`, `docker_logs`, `docker_stats`, `docker_images`, `docker_projects`, `docker_networks`, `docker_registry_search` | `docker_container_control`, `docker_project_control`, `docker_project_save`, `docker_image_pull`, `docker_delete` |
| Packages | `packages_list` | `package_control` |
| Accounts and shares | `users_list`, `groups_list`, `shares_list`, `share_nfs_rules` | `user_create`, `user_update`, `user_delete`, `user_groups_set`, `user_share_permission_set`, `share_create`, `share_delete`, `share_nfs_rule_set` |
| Services and security | `services_status`, `security_overview`, `security_certificates`, `security_login_activity` | `service_set` |
| Network | `network_services`, `reverse_proxy_list` | `reverse_proxy_create`, `reverse_proxy_delete` |
| Tasks and backups | `scheduler_tasks`, `backup_tasks` | `scheduler_run`, `backup_run` |
| Photos and Drive | `photos_collections`, `photos_items`, `photos_search`, `photos_download`, `drive_status`, `drive_list`, `drive_search`, `drive_labels` | `photos_album_create`, `photos_album_add` |
| Download Station, VMM, Surveillance | `downloads_list`, `vm_list`, `surveillance_cameras` | `download_add`, `download_control`, `vm_control` |
| Any API | `dsm_api_search`, `dsm_read` | `dsm_write` |

Tools for a package that isn't installed stay hidden. They appear once you install it and restart your client.

## How 2FA works

1. `setup` logs in with your password and a code, and asks DSM for a trusted-device token.
2. The password and token are stored in the macOS Keychain (on other systems, in a file with mode `600`).
3. Later logins use the token, with no code.

If you remove the trusted device in DSM (Personal > Security > Sign-in Activity), the next error says what to do: either give the model a current code, which it passes to `nas_auth_otp`, or run `setup` again.

## Security

- The password and token always travel in a POST body, never in a URL, and are never written to replies or logs.
- Container environment variables and Compose files can hold secrets, so they are returned only when explicitly requested. `dsm_read` hides fields with names like `password` or `token`.
- Content from the NAS (files, names, logs) can contain text written by anyone. The server's instructions tell the model to treat it as data.
- `files_delete`, `files_rename` and moves through `files_copy_move` refuse a whole shared folder, because in DSM that removes the shared folder itself, beyond its recycle bin. `share_delete` does that on purpose, and requires typing the name back.
- `read` is the default tier. If you use a dedicated DSM account with fewer privileges, DSM's own limits apply on top of these.

If you replace the NAS's certificate, connections are refused until you run `synology-mcp trust-cert`. This is deliberate: someone intercepting the connection would cause the same error.

## Running on another machine over HTTP

By default the client starts the server locally over stdio, so you don't need to host it. To keep it always on, for example on the NAS itself:

```bash
docker compose run --rm -it synology-mcp setup --url https://nas.example.com:5001
SYNOLOGY_MCP_TOKEN=$(openssl rand -hex 32) docker compose up -d
```

The endpoint is `http://127.0.0.1:8765/mcp`. Beyond loopback, the server refuses to start without `SYNOLOGY_MCP_TOKEN` and `SYNOLOGY_MCP_ALLOWED_HOSTS`. To expose it, put an HTTPS reverse proxy in front. Anyone who reaches this endpoint with the token can do whatever the configured tier allows.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `answered, but not as DSM's Web API` | The URL is missing the DSM port (Control Panel > Login Portal) |
| `Could not reach the NAS` | Check the network or VPN path to the NAS |
| `different TLS certificate` | If you replaced the certificate, run `trust-cert`. If you didn't, stop there |
| `DSM refused the login` | Fix it with `setup`. The server won't try again until the credentials change or it restarts |
| `blocked by DSM Auto Block` | Remove the IP in Control Panel > Security > Protection, then restart the server |
| `permission_denied` (105) | Most system and storage APIs need an administrator account |
| A tool doesn't appear | Ask the model to call `nas_capabilities`, which says why it's hidden |

## Development

```bash
git clone https://github.com/joaomelorodrigues/synology-mcp.git
cd synology-mcp
npm install
npm test                         # compiles, then tests against a fake DSM over real HTTP
TEST_KEYCHAIN=1 npm test         # also tests the real Keychain, with a temporary item
npm run typecheck
```

`dist/` is committed because it is what `npm install -g` installs. With `-g`, a package from git that has a script named `build`, `prepare`, `prepack`, `preinstall`, `install` or `postinstall` ends up as a symlink to a temporary folder npm has already deleted, which is why the compile script is called `compile`. After changing `src/`, run `npm run compile` and include `dist/` in the commit. The GitHub Actions check fails if you forget.

The code is split into `src/dsm` (DSM client: session, TLS, errors), `src/mcp` (tool registry, output formats, path guards, HTTP transport), `src/tools` (tools by area) and `src/cli` (`setup`, `doctor`, `tools`). To add a tool, add a `tool({...})` in `src/tools` with its tier and the APIs it depends on.

### Verification status

The tests cover the server's behavior against a simulated DSM. On a real NAS, only API discovery and certificate pinning have been confirmed, without logging in. The shape of the calls comes from the reference projects below, which tested them on DSM 7.x, but it still needs confirming with a login:

- Read tools can be confirmed with `doctor`. Some have no equivalent in the references, so watch those first: `security_login_activity`, `drive_labels`, and `photos_items` with no source given.
- Write tools can only be confirmed by using them. Try them on unimportant data first, especially `files_compress`, which also has no equivalent in the references.

### References

The DSM API conventions were learned from these projects: [cmeans/mcp-synology](https://github.com/cmeans/mcp-synology), [rafalr100/synology-mcp](https://github.com/rafalr100/synology-mcp), [atom2ueki/mcp-server-synology](https://github.com/atom2ueki/mcp-server-synology) and [vocweb/synology-mcp-server](https://github.com/vocweb/synology-mcp-server). The code here is original.

## License

[MIT](LICENSE). Not affiliated with Synology Inc.
