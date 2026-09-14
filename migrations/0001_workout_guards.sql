-- Transient assertions live only inside a single batch; RAISE(ABORT) rolls it back.
CREATE TABLE workout_write_guards (
  id TEXT PRIMARY KEY NOT NULL,
  check_type TEXT NOT NULL CHECK(check_type IN ('cas','exercise')),
  valid INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER workout_guard_cas BEFORE INSERT ON workout_write_guards
WHEN NEW.check_type = 'cas' AND NEW.valid <> 1
BEGIN SELECT RAISE(ABORT, 'WORKOUT_VERSION_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER workout_guard_exercise BEFORE INSERT ON workout_write_guards
WHEN NEW.check_type = 'exercise' AND NEW.valid <> 1
BEGIN SELECT RAISE(ABORT, 'EXERCISE_REFERENCE_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER exercise_referenced_semantics BEFORE UPDATE ON exercises
WHEN EXISTS (SELECT 1 FROM workout_entries WHERE exercise_id=OLD.id)
AND (NEW.kind IS NOT OLD.kind OR NEW.measurement_mode IS NOT OLD.measurement_mode
 OR NEW.resistance_mode IS NOT OLD.resistance_mode OR NEW.load_convention IS NOT OLD.load_convention
 OR NEW.rep_convention IS NOT OLD.rep_convention OR NEW.volume_multiplier IS NOT OLD.volume_multiplier
 OR NEW.cardio_category IS NOT OLD.cardio_category)
BEGIN SELECT RAISE(ABORT, 'EXERCISE_REFERENCED'); END;
--> statement-breakpoint
CREATE INDEX workouts_history_order ON workouts(local_date DESC, started_at DESC, id DESC);
