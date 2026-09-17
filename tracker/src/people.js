// Who is who. A Google account becomes a person the first time it reaches the
// tracker: a parent if its email is in PARENT_EMAILS, a student otherwise.
// There is one family until there is a reason for two; the column is there.

const DEFAULT_FAMILY = { id: 'fam-1', name: 'המשפחה' };

export function parentEmails(env) {
  return new Set(String(env.PARENT_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
}

async function ensureFamily(db, now) {
  const row = await db.prepare('SELECT id FROM families ORDER BY created_at LIMIT 1').first();
  if (row) return row.id;
  await db.prepare('INSERT OR IGNORE INTO families (id, name, created_at) VALUES (?, ?, ?)')
    .bind(DEFAULT_FAMILY.id, DEFAULT_FAMILY.name, now).run();
  return DEFAULT_FAMILY.id;
}

/* The people row for a signed-in user, created or promoted as needed. */
export async function ensurePerson(db, env, user, now) {
  const email = String(user.email || '').toLowerCase();
  const seededParent = parentEmails(env).has(email);
  let row = await db.prepare('SELECT * FROM people WHERE sub = ?').bind(user.sub).first();
  if (!row) {
    const familyId = await ensureFamily(db, now);
    await db.prepare(
      `INSERT INTO people (sub, email, name, picture, family_id, role, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(user.sub, email || null, user.name || null, user.picture || null, familyId,
        seededParent ? 'parent' : 'student', now, now)
      .run();
    row = await db.prepare('SELECT * FROM people WHERE sub = ?').bind(user.sub).first();
    return row;
  }
  const role = seededParent && row.role !== 'parent' ? 'parent' : row.role;
  await db.prepare('UPDATE people SET last_seen_at = ?, role = ?, name = COALESCE(?, name), picture = COALESCE(?, picture) WHERE sub = ?')
    .bind(now, role, user.name || null, user.picture || null, user.sub).run();
  return { ...row, role, last_seen_at: now };
}
