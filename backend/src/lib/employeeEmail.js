// Generated company-domain login email for employees, replacing
// employeeNumber.js's role in POST /employees: "Hamza Qanazi" at a company
// whose wizard-set email_domain is 'nablusmunicipalworks.org' becomes
// 'ha.qanazi@nablusmunicipalworks.org'. A colliding name gets a number
// inserted after the first-name part: 'ha2.qanazi@...', 'ha3.qanazi@...'.
//
// login_identifier stays the one column/one lookup design (CLAUDE.md §4) —
// this only changes what value populates it for a new employee.

function firstPart(firstName) {
  return firstName.trim().slice(0, 2).toLowerCase();
}

function lastPart(lastName) {
  return lastName.trim().toLowerCase().replace(/\s+/g, '');
}

// MUST be called inside a transaction: the advisory lock (keyed on the
// candidate's base prefix + domain) stops two concurrent hires with
// colliding names from picking the same free address (login_identifier is
// UNIQUE, so the loser would otherwise 500).
async function allocateEmployeeEmail(tx, firstName, lastName, domain) {
  const first = firstPart(firstName);
  const last = lastPart(lastName);
  const lockKey = `${first}.${last}@${domain}`;
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

  const { rows } = await tx.query(
    'SELECT login_identifier FROM users WHERE login_identifier LIKE $1',
    [`${first}%.${last}@${domain}`]
  );
  const taken = new Set(rows.map((r) => r.login_identifier));

  let n = 1;
  let candidate = lockKey;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${first}${n}.${last}@${domain}`;
  }
  return candidate;
}

module.exports = { allocateEmployeeEmail, firstPart, lastPart };
