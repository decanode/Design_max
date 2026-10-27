import { pool } from '../db.js';

export interface Mail { to: string; subject: string; body: string }
export interface Mailer { send(m: Mail): Promise<void> }

/** Writes to the email_outbox table so approval links can be inspected locally. Swap for M365 later. */
export class OutboxMailer implements Mailer {
  async send(m: Mail) {
    await pool.query('INSERT INTO email_outbox (to_email, subject, body) VALUES ($1,$2,$3)', [m.to, m.subject, m.body]);
  }
}
