# Move Command Center v0.3.0 secure setup

This version requires Firebase before the inventory appears. That is intentional: the private 388-piece inventory is no longer included in the GitHub Pages files.

## 1. Replace the older project

Extract this package into the project folder and replace the v0.2.0 files. Keep the `private-data` folder on the trusted setup computer.

The repository root should directly contain:

```text
.github/
private-data/
public/
scripts/
src/
firestore.rules
firebase.json
package.json
```

Do not copy only `dist/`. The new source, security rules, and bootstrap script are required.

## 2. Install dependencies and validate the private inventory

From PowerShell in the project folder:

```powershell
npm ci
npm run validate:private
```

The validator must report 14 physical crates, 388 pieces, and 388 unique printed IDs.

## 3. Create or open the dedicated Firebase project

In Firebase Console:

1. Create a dedicated project for this temporary move.
2. Register a Web app, but do not enable Firebase Hosting.
3. Copy the browser configuration object.
4. Under Authentication → Sign-in method, enable only Email/Password.
5. Disable Anonymous authentication if it was previously enabled.
6. Under Authentication → Settings → User actions, disable end-user account creation and account deletion.
7. Keep email-enumeration protection enabled under Authentication settings.
8. Create a Firestore database in Production mode.

The application does not include a signup page. Disabling end-user account creation adds a second barrier, and Firestore still requires a separate active move-membership document for every permitted UID.

## 4. Paste the Firebase browser configuration

Open:

```text
src/config/firebase.config.ts
```

Change `enabled` to `true` and replace every placeholder with the exact values supplied by Firebase:

```typescript
export const firebaseConfig = {
  enabled: true,
  apiKey: '...',
  authDomain: '...',
  projectId: '...',
  storageBucket: '...',
  messagingSenderId: '...',
  appId: '...'
} as const;
```

The browser configuration identifies the Firebase project but is not a password. Access is controlled by Authentication, move membership, and Firestore Rules.

## 5. Create the private username/password file

Copy:

```text
private-data/users.template.json
```

to:

```text
private-data/users.local.json
```

Replace all usernames, display names, and passwords. Usernames must be lowercase and may contain letters, numbers, dots, underscores, and hyphens. Each password must be unique and at least 14 characters.

Example structure:

```json
{
  "users": [
    {
      "username": "your-private-username",
      "displayName": "Your display name",
      "password": "a-long-unique-private-password"
    }
  ]
}
```

The website presents a username field. Internally, it converts the username into a reserved Firebase email alias. Users never type or see that alias.

Never commit `users.local.json`.

## 6. Download a temporary Firebase service-account key

In Firebase Console:

1. Open Project settings.
2. Open Service accounts.
3. Choose `Generate new private key`.
4. Confirm the download.
5. Rename the downloaded file to:

```text
firebase-service-account.json
```

6. Place it in:

```text
private-data/firebase-service-account.json
```

This key has administrative power. It is ignored by Git, should exist only on the trusted setup computer, and should be deleted after the bootstrap succeeds.

## 7. Bootstrap users, memberships, and the private inventory

Run:

```powershell
npm run bootstrap:firebase
```

The script will:

- Validate the complete private inventory again.
- Create or update every username/password account in `users.local.json`.
- Mark those accounts email-verified for the internal alias system.
- Create an active move-membership document for each Firebase UID.
- Disable memberships omitted from the current private user file.
- Upload the complete inventory to the protected Firestore document.
- Refuse placeholder, duplicate, weak, or reused passwords.
- Avoid printing or storing passwords in Firestore.

Do not continue unless the script reports that all users and all 388 records were uploaded.

After success, delete:

```text
private-data/firebase-service-account.json
```

You may retain `users.local.json` in a secure password-manager-backed location until the move is complete, but never push it to GitHub.

## 8. Deploy Firestore Security Rules

Install and authenticate the Firebase CLI if needed:

```powershell
npm install -g firebase-tools
firebase login
firebase use --add
```

Choose the dedicated project and use the alias `default`.

Deploy the rules:

```powershell
firebase deploy --only firestore:rules
```

The rules allow inventory reads and event synchronization only for signed-in UIDs with active membership documents. Inventory writes, member writes, event deletion, actor impersonation, and malformed event payloads are denied to browser clients.

## 9. Build and privacy-check the public site

Run:

```powershell
npm run build
```

A successful build ends with:

```text
Public build privacy check passed: the private inventory is not bundled into dist.
```

Do not deploy if that check fails.

## 10. Publish to GitHub

Before the first commit, verify:

```powershell
git status --ignored
```

The following must appear as ignored and must not be staged:

```text
private-data/inventory.generated.json
private-data/audit/
private-data/users.local.json
private-data/firebase-service-account.json
```

Then commit and push the public project files:

```powershell
git add .
git status
git commit -m "Secure Move Command Center v0.3.0"
git push
```

Review `git status` before committing. Never use `git add -f` on private data.

In GitHub repository settings:

1. Open Pages.
2. Select GitHub Actions as the source.
3. Open Actions and wait for the deploy workflow to turn green.

The public Pages deployment contains the generic app shell and login gate, not the inventory.

## 11. First sign-in on each trusted phone

First sign-in requires internet.

On each phone:

1. Open the production URL in Safari.
2. Enter the assigned username and password.
3. Leave `Keep me signed in on this device` selected.
4. Wait for the private inventory to download.
5. Open device settings and assign a clear device name.
6. Record or copy the device ID.
7. Wait for `App cached` and `Cloud synced`.
8. Add the website to the Home Screen.
9. Launch the installed PWA once more while online.

Firebase local persistence keeps the authentication session after closing the browser. The device should not require another login unless someone explicitly signs out, clears site data, revokes the account, or removes the browser storage.

Do not use Private Browsing for installation or move-day operation because private sessions may not preserve authentication or IndexedDB reliably.

## 12. Confirm security and collaboration

Use two phones:

1. Confirm that an incorrect password produces only a generic error.
2. Confirm that each correct account loads the inventory.
3. Make a temporary routing edit on one phone.
4. Confirm it appears on the second phone.
5. Confirm event history identifies both the username and device.
6. Undo the test change.

Optional negative test:

- Create an extra Firebase Authentication user without running the bootstrap membership step.
- Sign in with it.
- Confirm the app displays `This account is not authorized for this move.`
- Delete the test account afterward.

## 13. Perform the offline rehearsal

After each phone has signed in and downloaded the inventory:

1. Turn on Airplane Mode.
2. Fully close the installed PWA.
3. Reopen it.
4. Search several item numbers and keywords.
5. Make one temporary routing edit.
6. Export a backup.
7. Restore connectivity.
8. Wait for `Cloud synced`.
9. Confirm the edit reaches another phone.
10. Undo the test action.

A phone that has never signed in and downloaded the inventory cannot be prepared for offline use.

## 14. Changing or revoking users

To change passwords, add a user, remove a user, or disable access:

1. Recreate `private-data/firebase-service-account.json` temporarily.
2. Update `private-data/users.local.json`.
3. Run:

```powershell
npm run bootstrap:firebase
```

Users omitted from the file have their move membership set inactive. Their existing authentication token may remain present on a device, but Firestore access is denied after the membership change reaches the backend.

Delete the service-account key again after the update.
