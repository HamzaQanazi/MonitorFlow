-- Employee evaluation system (supervisor-mandated, CLAUDE.md §13). A manager
-- generates a scored evaluation for one employee over a date range they pick
-- (no cron -- generation is always a deliberate action, same "human stays in
-- the loop" shape as /schedule/suggest's preview-only design). Rows are never
-- updated or deleted -- regenerating a period inserts a new row, so past
-- evaluations stay a real record of what was reported when (same immutable
-- shape as request_status_history, I9).
--
-- breakdown is JSONB, not separate columns: the metrics blended into `score`
-- are read-only diagnostics for a human reviewing the number, never queried
-- or filtered on individually, so a flat JSON blob (same shape autoAssign's
-- in-memory scoring already uses) is enough -- no need for five more columns
-- and their own indexes.
CREATE TABLE employee_evaluation (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES users(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  score NUMERIC(5,2) NOT NULL,
  breakdown JSONB NOT NULL,
  generated_by INT NOT NULL REFERENCES users(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX employee_evaluation_employee_period_idx
  ON employee_evaluation (employee_id, period_start);
