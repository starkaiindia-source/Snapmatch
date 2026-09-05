/* ============================================================================
   scripts/grant-admin.js — the bootstrap, and the way back in
   ----------------------------------------------------------------------------
   Grants, revokes and lists administrator roles from the command line.

   ----------------------------------------------------------------------------
   WHY THIS EXISTS AT ALL

   Two reasons, and they are the same reason:

     1. The FIRST super_admin. /api/admin/admins requires a super_admin to
        call it, so with an empty registry there is nobody who can create one.
        That is the correct design — the alternative is a route that grants
        admin to whoever asks first, which is not a design.

     2. The LAST super_admin. If the only administrator account is lost, this
        is how the business gets back into its own backend.

   ----------------------------------------------------------------------------
   THE AUTHORITY IS THE SERVICE-ACCOUNT KEY

   This script does not authenticate anyone. It runs with FIREBASE_SERVICE_ACCOUNT
   from the environment, which is the key that can already read and write every
   document in the project. Anyone who holds it does not need permission from
   this script, so asking for one would be theatre.

   That is exactly why the key lives only in the Vercel environment and in
   whatever password manager the owner uses, and never in this repository.

   ----------------------------------------------------------------------------
   USAGE

     node scripts/grant-admin.js list
     node scripts/grant-admin.js grant  owner@example.com super_admin
     node scripts/grant-admin.js grant  helper@example.com support
     node scripts/grant-admin.js revoke helper@example.com

   The account must have signed in to the site with Google at least once, so
   that Firebase Authentication has a record for the address. A role is granted
   to an account that exists, not to an address that might become one.

   Reads .env.local when present, so a local run needs no exported variables.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* Same minimal reader the dev server uses. Existing environment variables win,
   so a one-off override on the command line is not silently ignored. */
(function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  });
}());

const { auth } = require(path.join(ROOT, 'api/_lib/firebase'));
const { setRole, listAdmins } = require(path.join(ROOT, 'api/_lib/admin-auth'));
const { ROLE_LIST, ROLES } = require(path.join(ROOT, 'api/_schema/roles'));

function die(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

function usage() {
  console.log(`
  Mobile Parts Finder — administrator roles

    node scripts/grant-admin.js list
    node scripts/grant-admin.js grant  <email> <role>
    node scripts/grant-admin.js revoke <email>

  Roles: ${ROLE_LIST.join(', ')}

  The account must have signed in to the site once, so Firebase
  Authentication has a record for the address.
`);
}

async function main() {
  const [command, email, role] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') { usage(); return; }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    die('FIREBASE_SERVICE_ACCOUNT is not set.\n' +
        '  Put it in .env.local, or export it, then run this again.\n' +
        '  Firebase console -> Project settings -> Service accounts -> Generate new private key.');
  }

  if (command === 'list') {
    const admins = await listAdmins();
    if (!admins.length) {
      console.log('\n  No administrators yet. Grant the first one:\n' +
                  '    node scripts/grant-admin.js grant you@example.com super_admin\n');
      return;
    }
    console.log('');
    admins
      .sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0))
      .forEach(a => {
        const when = a.grantedAt ? new Date(a.grantedAt).toISOString().slice(0, 10) : '—';
        console.log(
          '  ' + (a.disabled ? 'revoked ' : 'active  ') +
          String(a.role).padEnd(12) +
          String(a.email || a.uid).padEnd(34) +
          when
        );
      });
    console.log('');
    return;
  }

  if (command !== 'grant' && command !== 'revoke') { usage(); die('Unknown command: ' + command); }
  if (!email) die('An email address is required.');

  const wanted = command === 'revoke' ? ROLES.USER : role;
  if (command === 'grant') {
    if (!wanted) die('A role is required. One of: ' + ROLE_LIST.join(', '));
    if (ROLE_LIST.indexOf(wanted) < 0) die('Unknown role "' + wanted + '". One of: ' + ROLE_LIST.join(', '));
  }

  let user;
  try {
    user = await auth().getUserByEmail(email);
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      die('No Firebase account for ' + email + '.\n' +
          '  Ask them to open the site and sign in with Google once, then run this again.');
    }
    throw err;
  }

  /* Refuse to remove the last super_admin here too. The API route has the same
     guard; this one matters more, because the command line is where somebody
     tidying up is most likely to remove themselves last thing on a Friday. */
  if (wanted !== ROLES.SUPER_ADMIN) {
    const admins = await listAdmins();
    const supers = admins.filter(a => a.role === ROLES.SUPER_ADMIN && !a.disabled);
    if (supers.length === 1 && supers[0].uid === user.uid) {
      die('That is the last super_admin. Grant super_admin to another account first,\n' +
          '  or the project will have no way back into its own admin area.');
    }
  }

  const result = await setRole({
    uid: user.uid,
    role: wanted,
    grantedBy: 'cli',
    now: Date.now(),
    identity: { email: user.email, displayName: user.displayName }
  });

  console.log('\n  ' + (command === 'revoke' ? 'Revoked' : 'Granted') + ': ' +
              (user.email || user.uid) + ' -> ' + result.role);
  console.log('  Their existing sessions were revoked, so they must sign in again\n' +
              '  for the new role to appear on their token.\n');
}

main().then(
  () => process.exit(0),
  err => {
    console.error('\n  Failed:', (err && err.message) || err, '\n');
    process.exit(1);
  }
);
