# Security

This project is a proof of concept meant to run on a developer's machine. It has **no authentication**: the API and
the dashboard accept every request, and CORS is open. Do not expose it to a network you do not trust.

If you find a vulnerability in the code itself (for example a way to make a tool run twice, or to read data you should
not), please report it privately through GitHub's "Report a vulnerability" (Security tab) rather than in a public issue.

API keys are read from the environment only (`.env` is git-ignored); `scripts/check-secrets.sh` scans the tree and the
history in CI.
