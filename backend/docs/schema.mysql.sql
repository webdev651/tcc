-- TCC Clinic: MySQL 8+ schema for users / accounts.
-- Compatible with the existing Aiven MySQL database.

CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(20)  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL PRIMARY KEY,
    role          VARCHAR(10)  NOT NULL,
    name          VARCHAR(80)  NOT NULL,
    email         VARCHAR(120) NULL UNIQUE,
    student_id    VARCHAR(12)  NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    status        VARCHAR(10)  NOT NULL DEFAULT 'active',
    photo         MEDIUMTEXT   NULL,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT ck_users_role
        CHECK (role IN ('student','staff','admin')),

    CONSTRAINT ck_users_status
        CHECK (status IN ('active','disabled'))
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;


CREATE TABLE IF NOT EXISTS students (
    user_id           VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL PRIMARY KEY,
    course            VARCHAR(20)  NULL,
    year_level        VARCHAR(12)  NULL,
    contact           VARCHAR(20)  NULL,
    birthdate         DATE         NULL,
    gender            VARCHAR(10)  NULL,
    blood_type        VARCHAR(3)   NULL,
    address           VARCHAR(200) NULL,
    emergency_contact VARCHAR(150) NULL,

    CONSTRAINT fk_students_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;


CREATE TABLE IF NOT EXISTS sessions (
    jti       VARCHAR(30) NOT NULL PRIMARY KEY,
    user_id   VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
    exp       BIGINT      NOT NULL,
    last_seen BIGINT      NOT NULL,
    remember  BOOLEAN     NOT NULL DEFAULT FALSE,

    INDEX ix_sessions_user (user_id),

    CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash CHAR(64)    NOT NULL PRIMARY KEY,
    user_id    VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
    expires    BIGINT      NOT NULL,

    INDEX ix_reset_user (user_id),

    CONSTRAINT fk_reset_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;