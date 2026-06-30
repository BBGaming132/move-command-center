# Release notes

## v0.3.0 — Secure authenticated inventory

- Replaced anonymous authentication with username/password access backed by Firebase Email/Password Authentication.
- Added a private login gate with no signup or password-reset UI.
- Added persistent trusted-device sessions using Firebase local auth persistence.
- Preserved per-installation device IDs and added an account/device settings panel.
- Added active move-membership authorization in Firestore.
- Added strict event payload and actor validation in Firestore Security Rules.
- Removed the complete inventory from the public application bundle.
- Added authenticated Firestore inventory download and IndexedDB offline caching.
- Added a Firebase Admin bootstrap script that creates or updates users, creates member records, disables removed memberships, and uploads the verified inventory.
- Added a production privacy check that fails if private source rows enter the public build.
- Added generic login errors and no-index/no-referrer metadata.
- No AI features were added.

## Upgrade note from v0.2.0

Do not publish the v0.2.0 build after moving to v0.3.0 because v0.2.0 bundled the inventory into the static site. Replace the repository contents, run the private Firebase bootstrap, deploy the new rules, and then deploy the v0.3.0 public build.
