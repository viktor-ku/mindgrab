use reqwest::Url;
use sqlx::PgPool;

const USER_NAME: &str = "Boba Tee";
const USER_EMAIL: &str = "boba.tee@mindgrab.test";
const EXTERNAL_ID: &str = "user_01M3D7HX2KDTKS1SQXA8KWMX15";

pub(crate) fn is_local_mindgrab_database(database_url: &str) -> bool {
    let Ok(url) = Url::parse(database_url) else {
        return false;
    };
    matches!(url.scheme(), "postgres" | "postgresql")
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && url.path() == "/mindgrab"
}

pub(crate) async fn seed_user(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO users (name, email, external_id) VALUES ($1, $2, $3) \
         ON CONFLICT (external_id) DO NOTHING",
    )
    .bind(USER_NAME)
    .bind(USER_EMAIL)
    .bind(EXTERNAL_ID)
    .execute(pool)
    .await?;
    Ok(())
}
