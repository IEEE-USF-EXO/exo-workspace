# EXO Workspace

EXO Workspace is the task and team portal for IEEE USF EXO. The live site is
[exo-work.space](https://exo-work.space/) and the source is in the
[IEEE-USF-EXO GitHub organization](https://github.com/IEEE-USF-EXO/exo-workspace).
The site serves the HTML, CSS, and JavaScript in the repository root. The
[Supabase runbook](supabase/README.md) covers SQL migrations and backend setup.

## Integrations to hand over

| Service | What the next maintainer needs |
| --- | --- |
| GitHub and Pages | Repository and Pages settings access. The custom hostname is set in `CNAME`. The public [EXO Org Board](https://github.com/orgs/IEEE-USF-EXO/projects/3) is a separate dependency for manual task imports. Automatic GitHub sync is inactive. |
| Porkbun | Domain management and DNS access for `exo-work.space`. Maintain the site's DNS and copy the current sending records from Resend when verifying or changing the email domain. [Porkbun DNS guide](https://kb.porkbun.com/article/68-how-to-edit-dns-records) |
| Supabase | Access to project `tnupwlucufewosslvcaz`, including SQL Editor, Auth, Edge Functions, Secrets, Cron, and Vault. Supabase stores the workspace data and enforces team and role access. The browser configuration is in `config.js`. |
| Google Cloud OAuth | Access to the Google Cloud project and OAuth client used by Supabase Auth. Maintain the Google client credentials in Supabase Auth and the authorized callback and app redirect URLs in the appropriate dashboards. |
| Google Drive | Management access to the EXO root and team folders listed in `config.js`. Workspace membership controls which folders the app shows. Drive sharing controls who can open their contents. |
| Resend | Access to the Resend account, verified sending domain, and domain-restricted sending key for task notifications. The key lives in Supabase Edge Function Secrets. Follow the [task email setup](supabase/README.md#new-task-emails-with-resend) for the worker and schedule. |

Tasks from AI opens ChatGPT, Claude, or Gemini for a manual copy-and-paste
workflow. It uses the member's own account in the selected app. The browser
loads the public Supabase client library from jsDelivr.

Grant incoming maintainers access through the service dashboards and keep
private credentials in the service that uses them. Keep the Resend key,
Google OAuth client secret, Supabase service keys, Cron secret, and private
roster exports out of Git. The Supabase URL and public browser key in
`config.js` are intended for the frontend.
