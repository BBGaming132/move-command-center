# Move Command Center v0.3.0

A temporary mobile-first PWA for routing, receiving, reconciling, and searching a private household move inventory.

## Security model

- Firebase Email/Password Authentication; no anonymous access.
- No public signup, password-reset, or account-creation interface.
- Authorized users are created by the private bootstrap script.
- Each authorized Firebase UID must also have an active move-membership document.
- Firestore Security Rules restrict inventory and event access to active move members.
- The private inventory is not bundled into the GitHub Pages application or public repository.
- The inventory downloads only after authentication and is cached in IndexedDB for offline use.
- Authentication uses local browser persistence by default, so each trusted device remains signed in until explicit sign-out.
- Each installation retains its own device ID and editable device name for the event audit trail.
- Event documents are append-only and validate their actor UID, username, type, item number, and payload shape.

## Local commands

```powershell
npm ci
npm run validate:private
npm run bootstrap:firebase
firebase deploy --only firestore:rules
npm run build
npm run dev
```

Read `SETUP_GUIDE.md` before running the bootstrap. Never commit files ignored under `private-data/`.
