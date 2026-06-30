# Start here — secure Move Command Center v0.3.0

1. Read `SETUP_GUIDE.md` before publishing anything.
2. Run `npm ci` and `npm run validate:private`.
3. Enable Firebase Email/Password Authentication only; do not enable public signup.
4. Paste the Firebase browser configuration into `src/config/firebase.config.ts`.
5. Copy `private-data/users.template.json` to ignored `private-data/users.local.json` and enter the three private usernames and unique passwords.
6. Place a temporary service-account key at ignored `private-data/firebase-service-account.json`.
7. Run `npm run bootstrap:firebase` to provision users, memberships, and the protected inventory.
8. Delete the service-account key, deploy `firestore.rules`, then build and publish through GitHub Pages.
9. Sign in once on every trusted phone, name each device, and complete the offline rehearsal in `DAY_OF_CHECKLIST.md`.

The public site contains only the generic login/application shell. The 388-item inventory is uploaded to protected Firestore and cached locally only after an authorized sign-in.
