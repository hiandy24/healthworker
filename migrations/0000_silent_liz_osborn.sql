CREATE TABLE `cardio_records` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`duration_seconds` integer,
	`duration_basis` text DEFAULT 'elapsed' NOT NULL,
	`distance_meters` real,
	`average_heart_rate` integer,
	`max_heart_rate` integer,
	`elevation_gain_meters` real,
	`incline_percent` real,
	`resistance_level` real,
	`device_calories_kcal` real,
	`completed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `workout_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cardio_duration" CHECK("cardio_records"."completed" IN (0,1) AND "cardio_records"."duration_basis" IN ('elapsed','moving') AND ("cardio_records"."duration_seconds" IS NULL OR ("cardio_records"."duration_seconds">0 AND typeof("cardio_records"."duration_seconds")='integer')) AND ("cardio_records"."completed"=0 OR "cardio_records"."duration_seconds" IS NOT NULL)),
	CONSTRAINT "cardio_measurements" CHECK(("cardio_records"."distance_meters" IS NULL OR "cardio_records"."distance_meters">=0) AND ("cardio_records"."elevation_gain_meters" IS NULL OR "cardio_records"."elevation_gain_meters">=0) AND ("cardio_records"."incline_percent" IS NULL OR "cardio_records"."incline_percent" BETWEEN -100 AND 100) AND ("cardio_records"."resistance_level" IS NULL OR "cardio_records"."resistance_level">=0) AND ("cardio_records"."device_calories_kcal" IS NULL OR "cardio_records"."device_calories_kcal">=0)),
	CONSTRAINT "cardio_heart_rate" CHECK(("cardio_records"."average_heart_rate" IS NULL OR ("cardio_records"."average_heart_rate">0 AND typeof("cardio_records"."average_heart_rate")='integer')) AND ("cardio_records"."max_heart_rate" IS NULL OR ("cardio_records"."max_heart_rate">0 AND typeof("cardio_records"."max_heart_rate")='integer')) AND ("cardio_records"."average_heart_rate" IS NULL OR "cardio_records"."max_heart_rate" IS NULL OR "cardio_records"."average_heart_rate"<="cardio_records"."max_heart_rate"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cardio_entry` ON `cardio_records` (`entry_id`);--> statement-breakpoint
CREATE TABLE `exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`kind` text NOT NULL,
	`equipment` text,
	`muscle_groups` text DEFAULT '[]' NOT NULL,
	`measurement_mode` text NOT NULL,
	`resistance_mode` text,
	`load_convention` text NOT NULL,
	`rep_convention` text NOT NULL,
	`volume_multiplier` real,
	`cardio_category` text,
	`is_builtin` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "exercise_version" CHECK("exercises"."version" > 0),
	CONSTRAINT "exercise_semantics" CHECK(("exercises"."kind" = 'strength' AND "exercises"."measurement_mode" IN ('reps','duration') AND "exercises"."resistance_mode" IN ('external','bodyweight','assisted') AND "exercises"."resistance_mode" IS NOT NULL AND "exercises"."cardio_category" IS NULL) OR ("exercises"."kind" = 'cardio' AND "exercises"."measurement_mode" = 'cardio' AND "exercises"."resistance_mode" IS NULL AND "exercises"."cardio_category" IN ('run','walk','cycle','swim','row','elliptical','other') AND "exercises"."cardio_category" IS NOT NULL)),
	CONSTRAINT "exercise_conventions" CHECK("exercises"."load_convention" IN ('total','per_implement','none') AND "exercises"."rep_convention" IN ('total','per_side','not_applicable') AND ("exercises"."volume_multiplier" IS NULL OR ("exercises"."volume_multiplier">0 AND "exercises"."resistance_mode"='external' AND "exercises"."measurement_mode"='reps'))),
	CONSTRAINT "exercise_json" CHECK(json_valid("exercises"."aliases") AND json_type("exercises"."aliases")='array' AND json_valid("exercises"."muscle_groups") AND json_type("exercises"."muscle_groups")='array'),
	CONSTRAINT "exercise_builtin" CHECK("exercises"."is_builtin" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`resource_id` text NOT NULL,
	`response_body` text NOT NULL,
	`response_status` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT "idempotency_response" CHECK(json_valid("idempotency_keys"."response_body") AND "idempotency_keys"."response_status" BETWEEN 200 AND 299 AND "idempotency_keys"."expires_at">"idempotency_keys"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_principal_scope_key` ON `idempotency_keys` (`principal`,`scope`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_expiry` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`timezone` text NOT NULL,
	`locale` text DEFAULT 'zh-CN' NOT NULL,
	`unit_system` text DEFAULT 'metric' NOT NULL,
	`theme` text DEFAULT 'auto' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("settings"."id"='singleton' AND "settings"."locale"='zh-CN' AND "settings"."unit_system"='metric' AND "settings"."theme" IN ('light','dark','auto') AND "settings"."version">0)
);
--> statement-breakpoint
CREATE TABLE `strength_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`position` integer NOT NULL,
	`set_type` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`reps` integer,
	`duration_seconds` integer,
	`load_grams` integer,
	`assistance_grams` integer,
	`effort_type` text,
	`effort_value` real,
	`notes` text,
	FOREIGN KEY (`entry_id`) REFERENCES `workout_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "set_scalars" CHECK("strength_sets"."position">=0 AND "strength_sets"."set_type" IN ('warmup','working') AND "strength_sets"."completed" IN (0,1) AND ("strength_sets"."reps" IS NULL OR ("strength_sets"."reps">0 AND typeof("strength_sets"."reps")='integer')) AND ("strength_sets"."duration_seconds" IS NULL OR ("strength_sets"."duration_seconds">0 AND typeof("strength_sets"."duration_seconds")='integer')) AND ("strength_sets"."reps" IS NULL OR "strength_sets"."duration_seconds" IS NULL) AND ("strength_sets"."completed"=0 OR "strength_sets"."reps" IS NOT NULL OR "strength_sets"."duration_seconds" IS NOT NULL)),
	CONSTRAINT "set_load" CHECK(("strength_sets"."load_grams" IS NULL OR ("strength_sets"."load_grams">=0 AND typeof("strength_sets"."load_grams")='integer')) AND ("strength_sets"."assistance_grams" IS NULL OR ("strength_sets"."assistance_grams">=0 AND typeof("strength_sets"."assistance_grams")='integer')) AND ("strength_sets"."load_grams" IS NULL OR "strength_sets"."assistance_grams" IS NULL)),
	CONSTRAINT "set_effort" CHECK(("strength_sets"."effort_type" IS NULL AND "strength_sets"."effort_value" IS NULL) OR ("strength_sets"."effort_type" IS NOT NULL AND "strength_sets"."effort_value" IS NOT NULL AND (("strength_sets"."effort_type"='rpe' AND "strength_sets"."effort_value" BETWEEN 1 AND 10 AND "strength_sets"."effort_value"*2=CAST("strength_sets"."effort_value"*2 AS INTEGER)) OR ("strength_sets"."effort_type"='rir' AND "strength_sets"."effort_value" BETWEEN 0 AND 10 AND "strength_sets"."effort_value"=CAST("strength_sets"."effort_value" AS INTEGER))))),
	CONSTRAINT "set_notes" CHECK("strength_sets"."notes" IS NULL OR length("strength_sets"."notes")<=4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `set_position` ON `strength_sets` (`entry_id`,`position`);--> statement-breakpoint
CREATE TABLE `workout_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`exercise_name_snapshot` text NOT NULL,
	`measurement_snapshot` text NOT NULL,
	`notes` text,
	FOREIGN KEY (`workout_id`) REFERENCES `workouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "entry_position_positive" CHECK("workout_entries"."position">=0),
	CONSTRAINT "entry_kind" CHECK("workout_entries"."kind" IN ('strength','cardio')),
	CONSTRAINT "entry_snapshot" CHECK(json_valid("workout_entries"."measurement_snapshot") AND json_type("workout_entries"."measurement_snapshot")='object'),
	CONSTRAINT "entry_notes" CHECK("workout_entries"."notes" IS NULL OR length("workout_entries"."notes")<=4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entry_position` ON `workout_entries` (`workout_id`,`position`);--> statement-breakpoint
CREATE INDEX `entries_exercise_workout` ON `workout_entries` (`exercise_id`,`workout_id`);--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`timezone` text NOT NULL,
	`local_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`duration_seconds` integer,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workout_status" CHECK("workouts"."status" IN ('draft','completed')),
	CONSTRAINT "workout_duration" CHECK("workouts"."duration_seconds" IS NULL OR ("workouts"."duration_seconds">0 AND typeof("workouts"."duration_seconds")='integer')),
	CONSTRAINT "workout_version" CHECK("workouts"."version">0),
	CONSTRAINT "workout_notes" CHECK("workouts"."notes" IS NULL OR length("workouts"."notes")<=4000)
);
--> statement-breakpoint
CREATE INDEX `workouts_status_date_id` ON `workouts` (`status`,`local_date`,`id`);