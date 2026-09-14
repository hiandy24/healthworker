-- Synthetic built-in catalog only. Stable IDs never overwrite edited names.
INSERT INTO exercises (id,name,kind,measurement_mode,resistance_mode,load_convention,rep_convention,volume_multiplier,is_builtin,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000000001','杠铃深蹲','strength','reps','external','total','total',1,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z') ON CONFLICT(id) DO NOTHING;
INSERT INTO exercises (id,name,kind,measurement_mode,resistance_mode,load_convention,rep_convention,volume_multiplier,is_builtin,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000000002','双哑铃弯举（每侧次数）','strength','reps','external','per_implement','per_side',2,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z') ON CONFLICT(id) DO NOTHING;
INSERT INTO exercises (id,name,kind,measurement_mode,load_convention,rep_convention,cardio_category,is_builtin,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-000000000003','跑步','cardio','cardio','none','not_applicable','run',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z') ON CONFLICT(id) DO NOTHING;
