# Private setup data

This folder contains the verified inventory used only by the one-time Firebase bootstrap.

Never commit or upload these private files to GitHub:

- `inventory.generated.json`
- `audit/`
- `firebase-service-account.json`
- `users.local.json`

Copy `users.template.json` to `users.local.json`, replace every template password, and keep the local file private. The bootstrap script uploads the inventory and authorized member records to Firestore, creates or updates the password users, and never stores passwords in Firestore.
