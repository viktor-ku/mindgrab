// Test-only provider and isolated database. Production never loads this module.
#[path = "../tests/common/mod.rs"]
mod common;
#[tokio::main]
async fn main() {
    let origin = std::env::var("FIXTURE_APP_ORIGIN").expect("FIXTURE_APP_ORIGIN");
    let fixture = common::Fixture::new(&origin).await;
    println!("Fixture listening on {}", fixture.url);
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
    tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
    fixture.close().await;
}
